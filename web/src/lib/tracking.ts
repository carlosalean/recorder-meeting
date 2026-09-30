import type { PoolClient } from "pg";
import { analyzeMeeting, type Analysis, type ProjectContext } from "./analysis";
import { type Db, one, pool, query, tx } from "./db";
import { applyParticipants } from "./people";
import {
  PERSON_SHORT, TASK_STATUSES, type TaskStatus, TOPIC_STATUSES, type TopicStatus, isClosedTask,
} from "./status";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
export const normTaskStatus = (s: string | null | undefined): TaskStatus | null =>
  (TASK_STATUSES as readonly string[]).includes(norm(s)) ? (norm(s) as TaskStatus) : null;
const normTopicStatus = (s: string | null | undefined): TopicStatus | null =>
  (TOPIC_STATUSES as readonly string[]).includes(norm(s)) ? (norm(s) as TopicStatus) : null;

type Change = {
  projectId: number;
  meetingId: number | null;
  entity: "tema" | "tarea" | "persona";
  entityId: number;
  entityTitle: string;
  action: "creado" | "estado" | "actualizado" | "eliminado";
  oldStatus?: string | null;
  newStatus?: string | null;
  note?: string | null;
  evidence?: string | null;
};

export async function logChange(db: Db, c: Change) {
  await db.query(
    `INSERT INTO changes (project_id, meeting_id, entity, entity_id, entity_title, action,
                          old_status, new_status, note, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [c.projectId, c.meetingId, c.entity, c.entityId, c.entityTitle, c.action,
     c.oldStatus ?? null, c.newStatus ?? null, c.note || null, c.evidence || null],
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(s: string | null | undefined): string | null {
  if (!s || !DATE_RE.test(s)) return null;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

// ---------------------------------------------------------------------------
// Contexto que se envía a la IA
// ---------------------------------------------------------------------------

export async function loadProjectContext(projectId: number, db: Db): Promise<ProjectContext> {
  const project = await one<{ name: string; description: string | null; ai_summary: string | null; client: string }>(
    `SELECT p.name, p.description, p.ai_summary, c.name AS client
     FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
    [projectId], db,
  );
  if (!project) throw new Error(`Proyecto ${projectId} no encontrado`);
  const topics = await query<{ id: string; title: string; description: string | null; status: string }>(
    "SELECT id, title, description, status FROM topics WHERE project_id = $1 ORDER BY id", [projectId], db,
  );
  const tasks = await query<{
    id: string; topic_id: string; title: string; owner: string | null; due_date: string | null; status: string;
  }>(
    `SELECT t.id, t.topic_id, t.title, t.owner, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.status
     FROM tasks t JOIN topics tp ON tp.id = t.topic_id WHERE tp.project_id = $1 ORDER BY t.id`,
    [projectId], db,
  );
  const people = await query<{
    id: string; name: string; company: string | null; job_title: string | null; ai_profile: string | null;
    role: string | null; summary: string | null; in_project: boolean; aliases: string[];
    department: string | null; hierarchy_level: string | null; influence: string | null;
    reports_to: string | null; notes: string | null;
  }>(
    `SELECT p.id, p.name, p.company, p.job_title, p.ai_profile, pp.role, pp.summary, p.aliases, p.department,
            p.hierarchy_level, p.influence, p.notes,
            (SELECT b.name FROM people b WHERE b.id = p.reports_to_id) AS reports_to,
            pp.person_id IS NOT NULL AS in_project
     FROM people p LEFT JOIN project_people pp ON pp.person_id = p.id AND pp.project_id = $1
     ORDER BY in_project DESC, p.updated_at DESC LIMIT 400`,
    [projectId], db,
  );
  return {
    client: project.client,
    project: project.name,
    description: project.description,
    aiSummary: project.ai_summary,
    people: people.map((p) => ({
      id: Number(p.id), name: p.name, company: p.company, job_title: p.job_title, profile: p.ai_profile,
      role: p.role, summary: p.summary, inProject: p.in_project, aliases: p.aliases,
      department: p.department, reportsTo: p.reports_to, notes: p.notes,
      level: p.hierarchy_level ? PERSON_SHORT[p.hierarchy_level] : null,
      influence: p.influence ? PERSON_SHORT[p.influence] : null,
    })),
    topics: topics.map((t) => ({
      id: Number(t.id),
      title: t.title,
      description: t.description,
      status: t.status,
      // De los temas cerrados basta con el título (por si hay que reabrirlos).
      tasks: t.status === "cerrado" ? [] : tasks
        .filter((k) => k.topic_id === t.id)
        .map((k) => ({ ...k, id: Number(k.id) })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Aplicar el resultado de la IA
// ---------------------------------------------------------------------------

export type ApplyResult = {
  newTopics: number;
  newTasks: number;
  statusChanges: number;
  updates: number;
  newPeople: number;
};

export async function applyAnalysis(
  db: PoolClient,
  projectId: number,
  meetingId: number,
  a: Analysis,
): Promise<ApplyResult> {
  const res: ApplyResult = { newTopics: 0, newTasks: 0, statusChanges: 0, updates: 0, newPeople: 0 };
  const base = { projectId, meetingId };

  // 0) Personas y descripción del proyecto
  const people = await applyParticipants(db, projectId, meetingId, a.participantes ?? [], async (id, name, note) => {
    await logChange(db, { ...base, entity: "persona", entityId: id, entityTitle: name, action: "creado", note });
    res.newPeople++;
  });
  if (a.resumen_proyecto?.trim()) {
    await db.query("UPDATE projects SET ai_summary = $2 WHERE id = $1", [projectId, a.resumen_proyecto.trim()]);
  }
  const owner = async (name: string | null | undefined) => {
    const p = name?.trim() ? await people.ensure(name) : undefined;
    return { name: p?.name ?? (name?.trim() || null), personId: p?.id ?? null };
  };

  const topicRows = await query<{ id: string; title: string; status: string }>(
    "SELECT id, title, status FROM topics WHERE project_id = $1", [projectId], db,
  );
  const topics = new Map(topicRows.map((t) => [Number(t.id), { title: t.title, status: t.status }]));
  const taskRows = await query<{
    id: string; title: string; status: string; owner: string | null; owner_person_id: string | null;
    due_date: string | null;
  }>(
    `SELECT t.id, t.title, t.status, t.owner, t.owner_person_id, to_char(t.due_date, 'YYYY-MM-DD') AS due_date
     FROM tasks t JOIN topics tp ON tp.id = t.topic_id WHERE tp.project_id = $1`,
    [projectId], db,
  );
  const tasks = new Map(taskRows.map((t) => [Number(t.id), t]));

  const setTopicStatus = async (id: number, status: "abierto" | "cerrado", note: string, evidence?: string) => {
    const t = topics.get(id)!;
    if (t.status === status) return;
    await db.query(
      `UPDATE topics SET status = $2, updated_at = now(),
         closed_at = CASE WHEN $2 = 'cerrado' THEN now() ELSE NULL END WHERE id = $1`,
      [id, status],
    );
    await logChange(db, { ...base, entity: "tema", entityId: id, entityTitle: t.title, action: "estado",
      oldStatus: t.status, newStatus: status, note, evidence });
    t.status = status;
    res.statusChanges++;
  };

  const createTopic = async (title: string, description: string | null) => {
    const row = await one<{ id: string }>(
      `INSERT INTO topics (project_id, title, description, created_meeting_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [projectId, title, description || null, meetingId], db,
    );
    const id = Number(row!.id);
    topics.set(id, { title, status: "abierto" });
    await logChange(db, { ...base, entity: "tema", entityId: id, entityTitle: title, action: "creado",
      newStatus: "abierto", note: description });
    res.newTopics++;
    return id;
  };

  // 1) Temas nuevos
  const keyToTopic = new Map<string, number>();
  for (const t of a.temas_nuevos) {
    keyToTopic.set(t.clave, await createTopic(t.titulo, t.descripcion));
  }

  // 2) Cambios de estado de temas existentes
  for (const c of a.cambios_temas) {
    const status = normTopicStatus(c.estado);
    if (topics.has(c.tema_id) && status) await setTopicStatus(c.tema_id, status, c.nota);
  }

  // 3) Tareas nuevas
  let generalTopic: number | undefined;
  for (const t of a.tareas_nuevas) {
    const estado = normTaskStatus(t.estado) ?? "pendiente";
    let topicId =
      (t.tema_id != null && topics.has(t.tema_id) ? t.tema_id : undefined) ??
      (t.tema_clave ? keyToTopic.get(t.tema_clave) : undefined);
    if (topicId === undefined) {
      generalTopic ??= [...topics].find(([, v]) => v.title === "General")?.[0] ??
        (await createTopic("General", "Tareas sin un tema específico"));
      topicId = generalTopic;
    }
    if (topics.get(topicId)!.status === "cerrado" && !isClosedTask(estado)) {
      await setTopicStatus(topicId, "abierto", "Reabierto: surge una tarea nueva", t.evidencia);
    }
    const who = await owner(t.responsable);
    const row = await one<{ id: string }>(
      `INSERT INTO tasks (topic_id, title, description, owner, owner_person_id, due_date, status,
                          created_meeting_id, last_meeting_id, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8, CASE WHEN $7 IN ('completada','cancelada') THEN now() END)
       RETURNING id`,
      [topicId, t.titulo, t.descripcion || null, who.name, who.personId, validDate(t.fecha_limite),
       estado, meetingId], db,
    );
    await logChange(db, { ...base, entity: "tarea", entityId: Number(row!.id), entityTitle: t.titulo,
      action: "creado", newStatus: estado, note: t.descripcion, evidence: t.evidencia });
    res.newTasks++;
  }

  // 4) Cambios en tareas existentes
  for (const c of a.cambios_tareas) {
    const cur = tasks.get(c.tarea_id);
    if (!cur) continue;
    const status = normTaskStatus(c.estado) ?? cur.status;
    const who = c.responsable?.trim()
      ? await owner(c.responsable)
      : { name: cur.owner, personId: cur.owner_person_id ? Number(cur.owner_person_id) : null };
    const newOwner = who.name;
    const due = validDate(c.fecha_limite) ?? cur.due_date;
    await db.query(
      `UPDATE tasks SET status = $2, owner = $3, owner_person_id = $4, due_date = $5, last_meeting_id = $6,
         updated_at = now(),
         closed_at = CASE WHEN $2 IN ('completada','cancelada') THEN COALESCE(closed_at, now()) END
       WHERE id = $1`,
      [c.tarea_id, status, newOwner, who.personId, due, meetingId],
    );
    if (status !== cur.status) {
      await logChange(db, { ...base, entity: "tarea", entityId: c.tarea_id, entityTitle: cur.title,
        action: "estado", oldStatus: cur.status, newStatus: status, note: c.nota, evidence: c.evidencia });
      res.statusChanges++;
    }
    const details = [
      newOwner !== cur.owner ? `Responsable: ${cur.owner ?? "sin asignar"} → ${newOwner}` : null,
      due !== cur.due_date ? `Fecha límite: ${cur.due_date ?? "sin fecha"} → ${due}` : null,
    ].filter(Boolean);
    if (details.length || status === cur.status) {
      await logChange(db, { ...base, entity: "tarea", entityId: c.tarea_id, entityTitle: cur.title,
        action: "actualizado", note: [...details, c.nota].filter(Boolean).join(". "), evidence: c.evidencia });
      res.updates++;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Procesar una reunión de principio a fin
// ---------------------------------------------------------------------------

export async function processMeeting(meetingId: number): Promise<void> {
  try {
    const m = await one<{
      project_id: string; title: string; date: string; transcript: string; recorder_summary: string | null;
      participants_hint: string | null;
    }>(
      `SELECT project_id, title, to_char(meeting_date, 'YYYY-MM-DD') AS date, transcript, recorder_summary,
              participants_hint
       FROM meetings WHERE id = $1`,
      [meetingId],
    );
    if (!m) return;
    const projectId = Number(m.project_id);
    await query("UPDATE meetings SET status = 'procesando', error = NULL WHERE id = $1", [meetingId]);

    const ctx = await loadProjectContext(projectId, pool());
    const analysis = await analyzeMeeting(ctx, {
      title: m.title, date: m.date, transcript: m.transcript, recorderSummary: m.recorder_summary,
      participantsHint: m.participants_hint,
    });

    await tx(async (db) => {
      await applyAnalysis(db, projectId, meetingId, analysis);
      await db.query(
        `UPDATE meetings SET status = 'procesada', ai_summary = $2, processed_at = now(), error = NULL
         WHERE id = $1`,
        [meetingId, analysis.resumen],
      );
      await db.query("UPDATE projects SET updated_at = now() WHERE id = $1", [projectId]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[reunión ${meetingId}] error al procesar:`, e);
    await query("UPDATE meetings SET status = 'error', error = $2 WHERE id = $1", [meetingId, msg]);
  }
}
