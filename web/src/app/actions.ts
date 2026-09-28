"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { one, pool, query, tx } from "@/lib/db";
import { readRecording } from "@/lib/recordings";
import { PROJECT_STATUSES, TASK_STATUSES, TOPIC_STATUSES } from "@/lib/status";
import { logChange, processMeeting, validDate } from "@/lib/tracking";

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
        const row = await one<{ id: string }>(
          `INSERT INTO tasks (topic_id, title, description, owner, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [topicId, title, description, owner, due, status], db);
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
    "SELECT title, owner, to_char(due_date,'YYYY-MM-DD') AS due_date, description FROM tasks WHERE id=$1", [taskId]);
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
    const cur = await one<{ status: string; owner: string | null; due_date: string | null; project_id: string }>(
      `SELECT k.status, k.owner, to_char(k.due_date,'YYYY-MM-DD') AS due_date, t.project_id
       FROM tasks k JOIN topics t ON t.id = k.topic_id WHERE k.id = $1 FOR UPDATE OF k`, [id], db);
    if (!cur) throw new UserError("La tarea ya no existe");
    const status = oneOf(v.status, TASK_STATUSES, cur.status as "pendiente");
    await db.query(
      `UPDATE tasks SET title=$2, owner=$3, due_date=$4, description=$5, status=$6, updated_at=now(),
         closed_at = CASE WHEN $6 IN ('completada','cancelada') THEN COALESCE(closed_at, now()) END
       WHERE id=$1`,
      [id, v.title, v.owner, v.due, v.description, status]);
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

export async function addMeeting(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const projectId = required(fd, "project_id", "El proyecto");
    const title = required(fd, "title", "El título");
    let transcript = str(fd, "transcript");
    const file = fd.get("file");
    if (!transcript && file instanceof File && file.size > 0) transcript = (await file.text()).trim();
    if (!transcript) throw new UserError("Pega la transcripción o adjunta el archivo transcripcion.txt");
    const date = str(fd, "meeting_date");
    const row = await one<{ id: string }>(
      `INSERT INTO meetings (project_id, title, meeting_date, transcript, source, status)
       VALUES ($1, $2, COALESCE($3::timestamp, now()), $4, 'manual', 'procesando') RETURNING id`,
      [projectId, title, date, transcript]);
    scheduleProcessing(row!.id);
  });
}

export async function importRecording(_: FormState, fd: FormData): Promise<FormState> {
  return run(async () => {
    const folder = required(fd, "folder", "La grabación");
    const projectId = required(fd, "project_id", "El proyecto");
    const rec = await readRecording(folder);
    const row = await one<{ id: string }>(
      `INSERT INTO meetings (project_id, title, meeting_date, transcript, recorder_summary, source,
                             source_path, audio_file, status)
       VALUES ($1,$2,$3,$4,$5,'grabadora',$6,$7,'procesando') RETURNING id`,
      [projectId, str(fd, "title") ?? rec.title, rec.date ?? new Date(), rec.transcript, rec.summary,
       folder, rec.audio]);
    scheduleProcessing(row!.id);
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
