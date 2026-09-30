"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { one, pool, query, tx } from "@/lib/db";
import { readRecording } from "@/lib/recordings";
import { PROJECT_STATUSES, TASK_STATUSES, TOPIC_STATUSES } from "@/lib/status";
import { applyParticipants, createPerson } from "@/lib/people";
import { logChange, processMeeting, validDate } from "@/lib/tracking";
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

export async function savePerson(_: FormState, fd: FormData): Promise<FormState> {
  let newId: number | undefined;
  const res = await run(async () => {
    const id = str(fd, "id");
    const v = {
      name: required(fd, "name", "El nombre"), company: str(fd, "company"), job_title: str(fd, "job_title"),
      email: str(fd, "email"), phone: str(fd, "phone"),
    };
    if (id) {
      await query(
        `UPDATE people SET name=$2, company=$3, job_title=$4, email=$5, phone=$6, notes=$7, ai_profile=$8,
           updated_at=now() WHERE id=$1`,
        [id, v.name, v.company, v.job_title, v.email, v.phone, str(fd, "notes"), str(fd, "ai_profile")]);
    } else {
      newId = await createPerson(pool(), v);
      if (str(fd, "notes")) await query("UPDATE people SET notes=$2 WHERE id=$1", [newId, str(fd, "notes")]);
    }
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

/** Une dos fichas de la misma persona (p. ej. "Ana" y "Ana García"). */
export async function mergePeople(_: FormState, fd: FormData): Promise<FormState> {
  const into = required(fd, "id", "id");
  const from = required(fd, "merge_from", "La persona a unir");
  if (into === from) return { error: "Elige otra persona" };
  await run(async () => {
    await tx(async (db) => {
      await db.query("UPDATE tasks SET owner_person_id = $1 WHERE owner_person_id = $2", [into, from]);
      await db.query(
        `INSERT INTO project_people (project_id, person_id, role, summary)
           SELECT project_id, $1, role, summary FROM project_people WHERE person_id = $2
         ON CONFLICT (project_id, person_id) DO UPDATE SET
           role = COALESCE(project_people.role, EXCLUDED.role),
           summary = CONCAT_WS(' ', project_people.summary, EXCLUDED.summary)`,
        [into, from]);
      await db.query(
        `INSERT INTO meeting_people (meeting_id, person_id) SELECT meeting_id, $1 FROM meeting_people
         WHERE person_id = $2 ON CONFLICT DO NOTHING`, [into, from]);
      await db.query(
        `UPDATE people i SET company = COALESCE(i.company, f.company), job_title = COALESCE(i.job_title, f.job_title),
           email = COALESCE(i.email, f.email), phone = COALESCE(i.phone, f.phone),
           notes = NULLIF(CONCAT_WS(E'\\n', i.notes, f.notes), ''),
           ai_profile = NULLIF(CONCAT_WS(' ', i.ai_profile, f.ai_profile), ''), updated_at = now()
         FROM people f WHERE i.id = $1 AND f.id = $2`, [into, from]);
      await db.query("DELETE FROM people WHERE id = $1", [from]);
    });
  });
  redirect(`/personas?id=${into}`);
}
