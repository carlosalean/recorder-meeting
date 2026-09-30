"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { one, pool, query, tx } from "@/lib/db";
import { readRecording } from "@/lib/recordings";
import {
  HIERARCHY_LEVELS, INFLUENCE_LEVELS, PROJECT_STATUSES, TASK_STATUSES, TOPIC_STATUSES,
} from "@/lib/status";
import { applyParticipants, createPerson, mergePeople } from "@/lib/people";
import { logChange, processMeeting, validDate } from "@/lib/tracking";
import { applyProposal, runReorg } from "@/lib/reorg";
import { importPst } from "@/lib/emails";
import { DOC_PREFIX, saveUploadedDocument } from "@/lib/documents";
import { applyDocPlan, discardDocPlan, runDocPlan } from "@/lib/docplan";
import {
  createMeetingsFromRecording, scanRecordings, triageEmailThreads, triageRecording, type Suggestion,
} from "@/lib/triage";
import type { PoolClient } from "pg";

export type FormState = { error?: string; ok?: number } | undefined;

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const required = (fd: FormData, k: string, label: string) => {
  const v = str(fd, k);
  if (!v) throw new UserError(`${label} es obligatorio`);
  return v;
};
const oneOf = <T extends string>(v: string | null, list: readonly T[], def: T): T =>
  v && (list as readonly string[]).includes(v) ? (v as T) : def;

const inList = (v: string | null, list: readonly string[]) => (v && list.includes(v) ? v : null);

class UserError extends Error {}

/** Ejecuta la acción y convierte los errores esperados en un mensaje para el formulario. */
async function run(fn: () => Promise<void>): Promise<FormState> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    const code = (e as { code?: string }).code;
    if (code === "23505") return { error: "Ya existe un registro con ese nombre" };
    throw e;
  }
  revalidatePath("/", "layout");
  return { ok: Date.now() };
}

// --------------------------------------------------------------------------- Clientes

export async function saveClient(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const id = str(fd, "id");
    const vals = [required(fd, "name", "El nombre"), str(fd, "contact_name"), str(fd, "email"),
      str(fd, "phone"), str(fd, "notes")];
    if (id) {
      await query(`UPDATE clients SET name=$2, contact_name=$3, email=$4, phone=$5, notes=$6 WHERE id=$1`,
        [id, ...vals]);
    } else {
      await query(`INSERT INTO clients (name, contact_name, email, phone, notes) VALUES ($1,$2,$3,$4,$5)`, vals);
    }
  });
}

export async function deleteClient(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    await query("DELETE FROM clients WHERE id = $1", [required(fd, "id", "id")]);
  });
}

// --------------------------------------------------------------------------- Proyectos

export async function saveProject(_: FormState, fd: FormData): Promise<FormState> {
  let newId: string | undefined;
  const res = await run(async () => {
    const id = str(fd, "id");
    const name = required(fd, "name", "El nombre");
    const clientId = required(fd, "client_id", "El cliente");
    const status = oneOf(str(fd, "status"), PROJECT_STATUSES, "activo");
    if (id) {
      await query(
        `UPDATE projects SET client_id=$2, name=$3, description=$4, status=$5, updated_at=now() WHERE id=$1`,
        [id, clientId, name, str(fd, "description"), status]);
    } else {
      const row = await one<{ id: string }>(
        `INSERT INTO projects (client_id, name, description, status) VALUES ($1,$2,$3,$4) RETURNING id`,
        [clientId, name, str(fd, "description"), status]);
      newId = row!.id;
    }
  });
  if (newId) redirect(`/proyectos/${newId}`);
  return res;
}

export async function deleteProject(_: FormState, fd: FormData): Promise<FormState> {
  await run(async () => {
    await query("DELETE FROM projects WHERE id = $1", [required(fd, "id", "id")]);
  });
  redirect("/proyectos");
}

// --------------------------------------------------------------------------- Temas

export async function saveTopic(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const id = str(fd, "id");
    const title = required(fd, "title", "El título");
    const description = str(fd, "description");
    if (!id) {
      const projectId = required(fd, "project_id", "El proyecto");
      const row = await one<{ id: string }>(
        "INSERT INTO topics (project_id, title, description) VALUES ($1,$2,$3) RETURNING id",
        [projectId, title, description]);
      await logChange(pool(), { projectId: Number(projectId), meetingId: null, entity: "tema",
        entityId: Number(row!.id), entityTitle: title, action: "creado", newStatus: "abierto",
        note: "Creado manualmente" });
      return;
    }
    await tx(async (db) => {
      const cur = await one<{ project_id: string; status: string; title: string }>(
        "SELECT project_id, status, title FROM topics WHERE id = $1 FOR UPDATE", [id], db);
      if (!cur) throw new UserError("El tema ya no existe");
      const status = oneOf(str(fd, "status"), TOPIC_STATUSES, cur.status as "abierto");
      await db.query(
        `UPDATE topics SET title=$2, description=$3, status=$4, updated_at=now(),
           closed_at = CASE WHEN $4 = 'cerrado' THEN COALESCE(closed_at, now()) END WHERE id=$1`,
        [id, title, description, status]);
      if (status !== cur.status) {
        await logChange(db, { projectId: Number(cur.project_id), meetingId: null, entity: "tema",
          entityId: Number(id), entityTitle: title, action: "estado", oldStatus: cur.status,
          newStatus: status, note: "Cambio manual" });
      }
    });
  });
}

export async function deleteTopic(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const id = required(fd, "id", "id");
    await tx(async (db) => {
      const t = await one<{ project_id: string; title: string }>(
        "DELETE FROM topics WHERE id = $1 RETURNING project_id, title", [id], db);
      if (t) await logChange(db, { projectId: Number(t.project_id), meetingId: null, entity: "tema",
        entityId: Number(id), entityTitle: t.title, action: "eliminado", note: "Eliminado manualmente" });
    });
  });
}

// --------------------------------------------------------------------------- Tareas

/** Vincula el responsable escrito a mano con una persona (la crea si no existe). */
async function ownerPerson(db: PoolClient, projectId: number, name: string | null) {
  if (!name) return { name: null, personId: null };
  const people = await applyParticipants(db, projectId, 0, [], async (id, n) => {
    await logChange(db, { projectId, meetingId: null, entity: "persona", entityId: id, entityTitle: n,
      action: "creado", note: "Creada al asignarle una tarea" });
  });
  const p = await people.ensure(name);
  return { name: p?.name ?? name, personId: p?.id ?? null };
}

export async function saveTask(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const id = str(fd, "id");
    const title = required(fd, "title", "El título");
    const owner = str(fd, "owner");
    const due = validDate(str(fd, "due_date"));
    const description = str(fd, "description");
    if (!id) {
      const topicId = required(fd, "topic_id", "El tema");
      const status = oneOf(str(fd, "status"), TASK_STATUSES, "pendiente");
      await tx(async (db) => {
        const t = await one<{ project_id: string }>("SELECT project_id FROM topics WHERE id=$1", [topicId], db);
        if (!t) throw new UserError("El tema ya no existe");
        const who = await ownerPerson(db, Number(t.project_id), owner);
        const row = await one<{ id: string }>(
          `INSERT INTO tasks (topic_id, title, description, owner, owner_person_id, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [topicId, title, description, who.name, who.personId, due, status], db);
        await db.query("UPDATE topics SET status='abierto', closed_at=NULL, updated_at=now() WHERE id=$1", [topicId]);
        await logChange(db, { projectId: Number(t.project_id), meetingId: null, entity: "tarea",
          entityId: Number(row!.id), entityTitle: title, action: "creado", newStatus: status,
          note: "Creada manualmente" });
      });
      return;
    }
    await updateTask(id, { title, owner, due, description, status: str(fd, "status") });
  });
}

/** Cambio rápido de estado desde el panel (select en la tabla de tareas). */
export async function setTaskStatus(taskId: string, status: string): Promise<void> {
  const cur = await one<{ title: string; owner: string | null; due_date: string | null; description: string | null }>(
    `SELECT k.title, COALESCE(p.name, k.owner) AS owner, to_char(k.due_date,'YYYY-MM-DD') AS due_date, k.description
     FROM tasks k LEFT JOIN people p ON p.id = k.owner_person_id WHERE k.id=$1`, [taskId]);
  if (!cur) return;
  await updateTask(taskId, { title: cur.title, owner: cur.owner, due: cur.due_date,
    description: cur.description, status });
  revalidatePath("/", "layout");
}

async function updateTask(
  id: string,
  v: { title: string; owner: string | null; due: string | null; description: string | null; status: string | null },
) {
  await tx(async (db) => {
    const cur = await one<{
      status: string; owner: string | null; owner_person_id: string | null; due_date: string | null; project_id: string;
    }>(
      `SELECT k.status, COALESCE(p.name, k.owner) AS owner, k.owner_person_id,
              to_char(k.due_date,'YYYY-MM-DD') AS due_date, t.project_id
       FROM tasks k JOIN topics t ON t.id = k.topic_id LEFT JOIN people p ON p.id = k.owner_person_id
       WHERE k.id = $1 FOR UPDATE OF k`, [id], db);
    if (!cur) throw new UserError("La tarea ya no existe");
    const status = oneOf(v.status, TASK_STATUSES, cur.status as "pendiente");
    const who = v.owner === cur.owner
      ? { name: cur.owner, personId: cur.owner_person_id }
      : await ownerPerson(db, Number(cur.project_id), v.owner);
    await db.query(
      `UPDATE tasks SET title=$2, owner=$3, owner_person_id=$4, due_date=$5, description=$6, status=$7,
         updated_at=now(),
         closed_at = CASE WHEN $7 IN ('completada','cancelada') THEN COALESCE(closed_at, now()) END
       WHERE id=$1`,
      [id, v.title, who.name, who.personId, v.due, v.description, status]);
    const base = { projectId: Number(cur.project_id), meetingId: null, entity: "tarea" as const,
      entityId: Number(id), entityTitle: v.title };
    if (status !== cur.status) {
      await logChange(db, { ...base, action: "estado", oldStatus: cur.status, newStatus: status,
        note: "Cambio manual" });
    }
    const details = [
      v.owner !== cur.owner ? `Responsable: ${cur.owner ?? "sin asignar"} → ${v.owner ?? "sin asignar"}` : null,
      v.due !== cur.due_date ? `Fecha límite: ${cur.due_date ?? "sin fecha"} → ${v.due ?? "sin fecha"}` : null,
    ].filter(Boolean);
    if (details.length) {
      await logChange(db, { ...base, action: "actualizado", note: `${details.join(". ")} (manual)` });
    }
  });
}

export async function deleteTask(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const id = required(fd, "id", "id");
    await tx(async (db) => {
      const t = await one<{ project_id: string; title: string }>(
        `DELETE FROM tasks k USING topics t WHERE k.id = $1 AND t.id = k.topic_id
         RETURNING t.project_id, k.title`, [id], db);
      if (t) await logChange(db, { projectId: Number(t.project_id), meetingId: null, entity: "tarea",
        entityId: Number(id), entityTitle: t.title, action: "eliminado", note: "Eliminada manualmente" });
    });
  });
}

// --------------------------------------------------------------------------- Reuniones

function scheduleProcessing(meetingId: string) {
  // Se procesa en segundo plano: la página muestra "Procesando…" y se refresca sola.
  after(() => processMeeting(Number(meetingId)));
}

/**
 * Participantes indicados al subir una reunión: personas conocidas (casillas) y
 * personas nuevas en texto libre. Se guardan como pista para la IA y las conocidas
 * quedan ya registradas como asistentes.
 */
async function saveParticipants(db: PoolClient, meetingId: string, projectId: string, fd: FormData) {
  const ids = fd.getAll("people").map(String).filter((x) => /^\d+$/.test(x));
  const known = ids.length
    ? await query<{ id: string; name: string; company: string | null; job_title: string | null }>(
        "SELECT id, name, company, job_title FROM people WHERE id = ANY($1::bigint[])", [ids], db)
    : [];
  const extra = (str(fd, "new_people") ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const p of known) {
    await db.query("INSERT INTO meeting_people (meeting_id, person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [meetingId, p.id]);
    await db.query(
      "INSERT INTO project_people (project_id, person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [projectId, p.id]);
  }
  const lines = [
    ...known.map((p) => `- [P${p.id}] ${[p.name, p.company, p.job_title].filter(Boolean).join(" — ")}`),
    ...extra.map((l) => `- ${l} (persona nueva, indicada por el usuario)`),
  ];
  if (lines.length) {
    await db.query("UPDATE meetings SET participants_hint = $2 WHERE id = $1", [meetingId, lines.join("\n")]);
  }
}

export async function addMeeting(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const projectId = required(fd, "project_id", "El proyecto");
    const title = required(fd, "title", "El título");
    let transcript = str(fd, "transcript");
    const file = fd.get("file");
    if (!transcript && file instanceof File && file.size > 0) transcript = (await file.text()).trim();
    if (!transcript) throw new UserError("Pega la transcripción o adjunta el archivo transcripcion.txt");
    const date = str(fd, "meeting_date");
    const id = await tx(async (db) => {
      const row = await one<{ id: string }>(
        `INSERT INTO meetings (project_id, title, meeting_date, transcript, source, status)
         VALUES ($1, $2, COALESCE($3::timestamp, now()), $4, 'manual', 'procesando') RETURNING id`,
        [projectId, title, date, transcript], db);
      await saveParticipants(db, row!.id, projectId, fd);
      return row!.id;
    });
    scheduleProcessing(id);
  });
}

export async function importRecording(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const folder = required(fd, "folder", "La grabación");
    const projectId = required(fd, "project_id", "El proyecto");
    const rec = await readRecording(folder);
    const id = await tx(async (db) => {
      const row = await one<{ id: string }>(
        `INSERT INTO meetings (project_id, title, meeting_date, transcript, recorder_summary, source,
                               source_path, audio_file, status)
         VALUES ($1,$2,$3,$4,$5,'grabadora',$6,$7,'procesando') RETURNING id`,
        [projectId, str(fd, "title") ?? rec.title, rec.date ?? new Date(), rec.transcript, rec.summary,
         folder, rec.audio], db);
      await saveParticipants(db, row!.id, projectId, fd);
      return row!.id;
    });
    scheduleProcessing(id);
  });
}

export async function retryMeeting(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const id = required(fd, "id", "id");
    const m = await one<{ id: string }>(
      "UPDATE meetings SET status='procesando', error=NULL WHERE id=$1 AND status='error' RETURNING id", [id]);
    if (!m) throw new UserError("Solo se pueden reintentar reuniones con error");
    scheduleProcessing(id);
  });
}

export async function deleteMeeting(_: FormState, fd: FormData): Promise<FormState> {
  const id = required(fd, "id", "id");
  const m = await one<{ project_id: string }>("DELETE FROM meetings WHERE id=$1 RETURNING project_id", [id]);
  revalidatePath("/", "layout");
  redirect(m ? `/proyectos/${m.project_id}` : "/");
}

// --------------------------------------------------------------------------- Personas

function personValues(fd: FormData) {
  const reports = str(fd, "reports_to_id");
  return {
    name: required(fd, "name", "El nombre"),
    company: str(fd, "company"), job_title: str(fd, "job_title"), department: str(fd, "department"),
    hierarchy_level: inList(str(fd, "hierarchy_level"), HIERARCHY_LEVELS),
    influence: inList(str(fd, "influence"), INFLUENCE_LEVELS),
    reports_to_id: reports && /^\d+$/.test(reports) ? reports : null,
    email: str(fd, "email"), phone: str(fd, "phone"), linkedin: str(fd, "linkedin"),
    notes: str(fd, "notes"), ai_profile: str(fd, "ai_profile"),
  };
}

export async function savePerson(_: FormState, fd: FormData): Promise<FormState> {
  let newId: number | undefined;
  const res = await run(async () => {
    const id = str(fd, "id");
    const v = personValues(fd);
    if (id && v.reports_to_id === id) throw new UserError("Una persona no puede reportarse a sí misma");
    const aliases = (str(fd, "aliases") ?? "").split(/[,;\n]/).map((a) => a.trim()).filter(Boolean);
    if (!id) newId = await createPerson(pool(), { name: v.name });
    await query(
      `UPDATE people SET name=$2, company=$3, job_title=$4, department=$5, hierarchy_level=$6, influence=$7,
         reports_to_id=$8, email=$9, phone=$10, linkedin=$11, notes=$12, ai_profile=COALESCE($13, ai_profile),
         aliases=$14, updated_at=now()
       WHERE id=$1`,
      [id ?? newId, v.name, v.company, v.job_title, v.department, v.hierarchy_level, v.influence,
       v.reports_to_id, v.email, v.phone, v.linkedin, v.notes, v.ai_profile, aliases]);
  });
  if (newId) redirect(`/personas?id=${newId}`);
  return res;
}

export async function deletePerson(_: FormState, fd: FormData): Promise<FormState> {
  await run(async () => {
    await query("DELETE FROM people WHERE id = $1", [required(fd, "id", "id")]);
  });
  redirect("/personas");
}

/** Une varias fichas de la misma persona con los valores elegidos en /personas/unificar. */
export async function unifyPeople(_: FormState, fd: FormData): Promise<FormState> {
  const ids = fd.getAll("ids").map(String).filter((x) => /^\d+$/.test(x));
  const main = str(fd, "main");
  if (ids.length < 2 || !main || !ids.includes(main)) return { error: "Elige al menos dos fichas y la principal" };
  const res = await run(async () => {
    const v = personValues(fd);
    await tx((db) => mergePeople(db, main, ids, v));
  });
  if (res?.error) return res;
  redirect(`/personas?id=${main}`);
}

// --------------------------------------------------------------------------- Asignación automática

/** Pide a la IA que clasifique una grabación (y la asigne si lo tiene claro). */
export async function autoAssignRecording(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const folder = required(fd, "folder", "La grabación");
    await query(
      `INSERT INTO recording_triage (folder, status) VALUES ($1, 'clasificando')
       ON CONFLICT (folder) DO UPDATE SET status = 'clasificando', error = NULL, updated_at = now()`, [folder]);
    after(() => triageRecording(folder));
  });
}

/** Clasifica todas las grabaciones pendientes (incluidas las que dieron error). */
export async function autoAssignAll(_: FormState): Promise<FormState> {
  return run(async () => {
    after(() => scanRecordings({ retryErrors: true }));
  });
}

/** Confirma una o varias de las sugerencias de la IA para una grabación dudosa. */
export async function confirmTriage(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const folder = required(fd, "folder", "La grabación");
    const chosen = fd.getAll("project_id").map(String).filter((x) => /^\d+$/.test(x));
    if (!chosen.length) throw new UserError("Marca al menos un proyecto");
    const t = await one<{ suggestions: Suggestion[] }>(
      "SELECT suggestions FROM recording_triage WHERE folder = $1", [folder]);
    const scopes = new Map((t?.suggestions ?? []).map((s) => [s.project_id, s.scope]));
    await query("UPDATE recording_triage SET status = 'asignada', updated_at = now() WHERE folder = $1", [folder]);
    const ids = await createMeetingsFromRecording(folder, chosen.map((id) => ({ project_id: id, scope: scopes.get(id) })));
    after(async () => {
      for (const id of ids) await processMeeting(id);
    });
  });
}

// --------------------------------------------------------------------------- Reorganización con IA

export async function startReorg(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const clientId = str(fd, "client_id") ?? undefined;
    const busy = await one("SELECT id FROM reorg_runs WHERE status = 'analizando' AND created_at > now() - interval '30 minutes'");
    if (busy) throw new UserError("Ya hay un análisis en curso");
    const r = await one<{ id: string }>("INSERT INTO reorg_runs (status) VALUES ('analizando') RETURNING id");
    after(() => runReorg(Number(r!.id), clientId));
  });
}

export async function applyReorg(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const ids = fd.getAll("proposal").map(String).filter((x) => /^\d+$/.test(x));
    if (!ids.length) throw new UserError("Marca al menos una propuesta");
    if (str(fd, "op") === "descartar") {
      await query("UPDATE reorg_proposals SET status = 'descartada' WHERE id = ANY($1::bigint[]) AND status = 'pendiente'", [ids]);
      return;
    }
    // En orden: fusiones de proyectos al final para no invalidar otras propuestas antes de aplicarlas.
    const rows = await query<{ id: string; kind: string }>(
      "SELECT id, kind FROM reorg_proposals WHERE id = ANY($1::bigint[]) AND status = 'pendiente' ORDER BY id", [ids]);
    const order = (k: string) => (k === "fusionar_proyectos" ? 2 : k === "fusionar_temas" ? 1 : 0);
    for (const r of rows.sort((a, b) => order(a.kind) - order(b.kind))) await applyProposal(Number(r.id));
  });
}

// --------------------------------------------------------------------------- Correos y documentos

/** Importa un .pst en segundo plano (solo correos desde la fecha indicada). */
export async function importEmails(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const file = required(fd, "file", "El archivo");
    const since = validDate(str(fd, "since"));
    const busy = await one("SELECT 1 FROM email_sources WHERE status = 'importando' AND imported_at > now() - interval '2 hours'");
    if (busy) throw new UserError("Ya hay una importación en curso; espera a que termine");
    await query(
      `INSERT INTO email_sources (file, status, since) VALUES ($1, 'importando', $2)
       ON CONFLICT (file) DO UPDATE SET status = 'importando', since = $2, error = NULL, imported_at = now()`,
      [file, since]);
    after(() => importPst(file, since ? new Date(since) : null));
  });
}

/** Clasifica con IA (por lotes) los hilos de correo pendientes. */
export async function classifyEmails(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const limit = Math.min(Math.max(Number(str(fd, "limit") ?? 100) || 100, 1), 2000);
    after(() => triageEmailThreads({ limit }));
  });
}

/** Asigna a mano una fuente (hilo de correo o documento) a un proyecto y la procesa. */
export async function assignSource(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const key = required(fd, "folder", "La fuente");
    const projectId = required(fd, "project_id", "El proyecto");
    await query(
      `INSERT INTO recording_triage (folder, status) VALUES ($1, 'asignada')
       ON CONFLICT (folder) DO UPDATE SET status = 'asignada', updated_at = now()`, [key]);
    const ids = await createMeetingsFromRecording(key, [{ project_id: projectId }]);
    if (!ids.length) throw new UserError("Ya estaba asignada a ese proyecto");
    after(async () => {
      for (const id of ids) await processMeeting(id);
    });
  });
}

// --------------------------------------------------------------------------- Documentos

/** Sube documentos (PDF, Word…) a la carpeta de documentos y los analiza con IA. */
export async function uploadDocuments(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) throw new UserError("Elige al menos un archivo");
    const keys: string[] = [];
    for (const f of files) {
      try {
        keys.push(DOC_PREFIX + await saveUploadedDocument(f.name, Buffer.from(await f.arrayBuffer())));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EROFS" || code === "EACCES") {
          throw new UserError("La carpeta de documentos es de solo lectura. Quita ':ro' del volumen /documentos en " +
            "docker-compose.yml y reinicia con 'docker compose up -d'");
        }
        if (e instanceof Error && e.message.startsWith("Formato no admitido")) throw new UserError(e.message);
        throw e;
      }
    }
    for (const k of keys) {
      await query(
        `INSERT INTO doc_plans (source_key, status) VALUES ($1, 'analizando')
         ON CONFLICT (source_key) DO UPDATE SET status = 'analizando', error = NULL, updated_at = now()`, [k]);
    }
    after(async () => {
      for (const k of keys) await runDocPlan(k);
    });
  });
}

/** (Re)analiza un documento con IA: propone a qué proyectos (existentes o nuevos) incorporarlo. */
export async function analyzeDocument(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const key = required(fd, "key", "El documento");
    const auto = str(fd, "auto") !== "0";
    await query(
      `INSERT INTO doc_plans (source_key, status) VALUES ($1, 'analizando')
       ON CONFLICT (source_key) DO UPDATE SET status = 'analizando', error = NULL, updated_at = now()`, [key]);
    after(() => runDocPlan(key, { auto }));
  });
}

/** Aplica las propuestas marcadas del plan de un documento (o lo descarta con op=descartar). */
export async function applyDocumentPlan(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const key = required(fd, "key", "El documento");
    if (str(fd, "op") === "descartar") {
      await discardDocPlan(key);
      return;
    }
    const choices = fd.getAll("item").map(String).filter((x) => /^\d+$/.test(x)).map((x) => ({
      index: Number(x), name: str(fd, `name_${x}`), client_name: str(fd, `client_${x}`),
    }));
    if (!choices.length) throw new UserError("Marca al menos un proyecto");
    let ids: number[];
    try {
      ids = await applyDocPlan(key, choices);
    } catch (e) {
      if (e instanceof Error && !("code" in e)) throw new UserError(e.message);
      throw e;
    }
    after(async () => {
      for (const id of ids) await processMeeting(id);
    });
  });
}
