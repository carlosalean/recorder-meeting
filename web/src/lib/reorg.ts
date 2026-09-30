import type { PoolClient } from "pg";
import { z } from "zod";
import { askStructured } from "./analysis";
import { type Db, one, query, tx } from "./db";
import { logChange } from "./tracking";

/**
 * Reorganización de proyectos con IA.
 *
 * La IA revisa todos los proyectos (temas, tareas y reuniones) y propone cambios:
 * mover información que está en el proyecto equivocado, fusionar temas o proyectos
 * duplicados, etc. Las propuestas NO se aplican solas: el usuario las revisa y elige.
 */

export const REORG_KINDS = [
  "mover_tema", "mover_tarea", "mover_reunion", "fusionar_temas", "fusionar_proyectos", "renombrar_tema",
] as const;
export type ReorgKind = (typeof REORG_KINDS)[number];

const id = (d: string) => z.number().int().nullable().describe(d);

export const ReorgSchema = z.object({
  diagnostico: z.string().describe("Valoración general de cómo está organizada la información (2-5 frases)"),
  propuestas: z.array(
    z.object({
      tipo: z.string().describe(`Uno de: ${REORG_KINDS.join(", ")}`),
      tema_id: id("mover_tema / renombrar_tema: tema afectado ([T..])"),
      tarea_id: id("mover_tarea: tarea afectada ([#..])"),
      reunion_id: id("mover_reunion: reunión afectada ([R..])"),
      temas_ids: z.array(z.number().int()).describe("fusionar_temas: temas a unir (el primero es el que se conserva)"),
      proyecto_origen_id: id("fusionar_proyectos: proyecto que se absorbe y desaparece"),
      proyecto_destino_id: id("Proyecto de destino (mover_tema, mover_reunion, mover_tarea a tema nuevo, fusionar_proyectos)"),
      tema_destino_id: id("mover_tarea: tema existente de destino"),
      nuevo_titulo: z.string().nullable().describe("renombrar_tema / fusionar_temas / mover_tarea a un tema nuevo"),
      motivo: z.string().describe("Por qué: qué información concreta está mal ubicada o duplicada"),
    }),
  ),
});
export type ReorgResult = z.infer<typeof ReorgSchema>;
export type Proposal = ReorgResult["propuestas"][number];

const SYSTEM = `Eres el responsable de ORDENAR la base de conocimiento de proyectos de un profesional que \\
trabaja para varios clientes. La información (temas, tareas y reuniones) se ha ido generando automáticamente \\
a partir de transcripciones de reuniones y a veces queda en el sitio equivocado.

Revisa el catálogo completo y propón cambios concretos:
- mover_tema: un tema (con todas sus tareas) pertenece a otro proyecto.
- mover_tarea: una tarea está en un tema o proyecto que no le corresponde. Indica tema_destino_id, o bien \\
proyecto_destino_id + nuevo_titulo para crear un tema nuevo en ese proyecto.
- mover_reunion: una reunión se asignó al proyecto equivocado.
- fusionar_temas: varios temas del MISMO asunto (duplicados). El primero de temas_ids se conserva; puedes \\
darle nuevo_titulo.
- fusionar_proyectos: dos proyectos son en realidad el mismo. proyecto_origen_id se absorbe en proyecto_destino_id.
- renombrar_tema: el título no refleja su contenido.

Reglas: sé conservador y concreto; cada propuesta debe apoyarse en información clara del catálogo \\
(nombres, cliente, contenido de las tareas o reuniones). No propongas cambios cosméticos ni por matices. \\
Si todo está bien organizado, devuelve la lista vacía. Usa los IDs exactamente como aparecen. Escribe en español.`;

type CatalogTopic = { id: string; project_id: string; title: string; description: string | null; status: string };
type CatalogTask = { id: string; topic_id: string; title: string; owner: string | null; status: string };
type CatalogMeeting = { id: string; project_id: string; title: string; date: string; summary: string | null };
type CatalogProject = {
  id: string; name: string; client: string; status: string; description: string | null; ai_summary: string | null;
};

async function loadCatalog(clientId?: string) {
  const projects = await query<CatalogProject>(
    `SELECT p.id, p.name, c.name AS client, p.status, p.description, p.ai_summary
     FROM projects p JOIN clients c ON c.id = p.client_id
     ${clientId ? "WHERE p.client_id = $1" : ""} ORDER BY c.name, p.name`,
    clientId ? [clientId] : [],
  );
  const ids = projects.map((p) => p.id);
  const [topics, tasks, meetings] = await Promise.all([
    query<CatalogTopic>(
      "SELECT id, project_id, title, description, status FROM topics WHERE project_id = ANY($1::bigint[]) ORDER BY id",
      [ids]),
    query<CatalogTask>(
      `SELECT k.id, k.topic_id, k.title, COALESCE(pe.name, k.owner) AS owner, k.status
       FROM tasks k JOIN topics t ON t.id = k.topic_id LEFT JOIN people pe ON pe.id = k.owner_person_id
       WHERE t.project_id = ANY($1::bigint[]) AND k.status <> 'cancelada' ORDER BY k.id`,
      [ids]),
    query<CatalogMeeting>(
      `SELECT id, project_id, title, to_char(meeting_date, 'YYYY-MM-DD') AS date,
              left(coalesce(ai_summary, recorder_summary, left(transcript, 600)), 600) AS summary
       FROM meetings WHERE project_id = ANY($1::bigint[]) ORDER BY meeting_date`,
      [ids]),
  ]);
  return { projects, topics, tasks, meetings };
}

type Catalog = Awaited<ReturnType<typeof loadCatalog>>;

export function renderCatalog(c: Catalog): string {
  const clean = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  for (const p of c.projects) {
    lines.push(`[PR${p.id}] ${p.name} — cliente: ${p.client} (${p.status})`);
    const about = clean(p.ai_summary) || clean(p.description);
    if (about) lines.push(`  de qué va: ${about}`);
    for (const t of c.topics.filter((t) => t.project_id === p.id)) {
      lines.push(`  [T${t.id}] (${t.status}) ${t.title}${t.description ? ` — ${clean(t.description)}` : ""}`);
      for (const k of c.tasks.filter((k) => k.topic_id === t.id).slice(0, 40)) {
        lines.push(`     [#${k.id}] (${k.status}) ${k.title}${k.owner ? ` — ${k.owner}` : ""}`);
      }
    }
    for (const m of c.meetings.filter((m) => m.project_id === p.id)) {
      lines.push(`  [R${m.id}] reunión ${m.date} "${m.title}": ${clean(m.summary).slice(0, 400)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Descarta propuestas incoherentes (IDs inexistentes, tipos desconocidos, no-cambios). */
export function validateProposals(props: Proposal[], c: Catalog): Proposal[] {
  const P = new Set(c.projects.map((p) => Number(p.id)));
  const T = new Map(c.topics.map((t) => [Number(t.id), Number(t.project_id)]));
  const K = new Map(c.tasks.map((k) => [Number(k.id), Number(k.topic_id)]));
  const R = new Map(c.meetings.map((m) => [Number(m.id), Number(m.project_id)]));
  return props.filter((x) => {
    const kind = x.tipo.trim().toLowerCase();
    switch (kind) {
      case "mover_tema":
        return x.tema_id != null && T.has(x.tema_id) && x.proyecto_destino_id != null &&
          P.has(x.proyecto_destino_id) && T.get(x.tema_id) !== x.proyecto_destino_id;
      case "mover_tarea":
        if (x.tarea_id == null || !K.has(x.tarea_id)) return false;
        if (x.tema_destino_id != null) return T.has(x.tema_destino_id) && K.get(x.tarea_id) !== x.tema_destino_id;
        return x.proyecto_destino_id != null && P.has(x.proyecto_destino_id) && !!x.nuevo_titulo?.trim();
      case "mover_reunion":
        return x.reunion_id != null && R.has(x.reunion_id) && x.proyecto_destino_id != null &&
          P.has(x.proyecto_destino_id) && R.get(x.reunion_id) !== x.proyecto_destino_id;
      case "fusionar_temas":
        return new Set(x.temas_ids).size >= 2 && x.temas_ids.every((t) => T.has(t));
      case "fusionar_proyectos":
        return x.proyecto_origen_id != null && x.proyecto_destino_id != null && P.has(x.proyecto_origen_id) &&
          P.has(x.proyecto_destino_id) && x.proyecto_origen_id !== x.proyecto_destino_id;
      case "renombrar_tema":
        return x.tema_id != null && T.has(x.tema_id) && !!x.nuevo_titulo?.trim();
      default:
        return false;
    }
  }).map((x) => ({ ...x, tipo: x.tipo.trim().toLowerCase() }));
}

/** Lanza un análisis completo (o de un cliente) y guarda las propuestas. */
export async function runReorg(runId: number, clientId?: string): Promise<void> {
  try {
    const catalog = await loadCatalog(clientId);
    if (!catalog.projects.length) throw new Error("No hay proyectos que revisar");
    const result = await askStructured(ReorgSchema, SYSTEM,
      `CATÁLOGO COMPLETO:\n\n${renderCatalog(catalog)}`, { effort: "high" });
    const valid = validateProposals(result.propuestas, catalog);
    await tx(async (db) => {
      for (const p of valid) {
        await db.query(
          "INSERT INTO reorg_proposals (run_id, kind, payload, reason) VALUES ($1, $2, $3, $4)",
          [runId, p.tipo, JSON.stringify(p), p.motivo]);
      }
      await db.query("UPDATE reorg_runs SET status = 'lista', diagnosis = $2 WHERE id = $1",
        [runId, result.diagnostico]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[reorganización]", e);
    await query("UPDATE reorg_runs SET status = 'error', error = $2 WHERE id = $1", [runId, msg]);
  }
}

// ---------------------------------------------------------------------------
// Aplicar propuestas
// ---------------------------------------------------------------------------

const name = async (db: Db, table: "projects" | "topics", id: number) =>
  (await one<{ n: string }>(`SELECT ${table === "projects" ? "name" : "title"} AS n FROM ${table} WHERE id = $1`,
    [id], db))?.n ?? `#${id}`;

/** Vincula al proyecto a los responsables de las tareas de un tema. */
async function linkOwners(db: Db, topicIds: number[], projectId: number) {
  await db.query(
    `INSERT INTO project_people (project_id, person_id)
       SELECT DISTINCT $1::bigint, owner_person_id FROM tasks
       WHERE topic_id = ANY($2::bigint[]) AND owner_person_id IS NOT NULL
     ON CONFLICT DO NOTHING`, [projectId, topicIds]);
}

async function moveTopic(db: PoolClient, topicId: number, dest: number, reason: string) {
  const t = await one<{ project_id: string; title: string }>(
    "SELECT project_id, title FROM topics WHERE id = $1 FOR UPDATE", [topicId], db);
  if (!t) throw new Error("El tema ya no existe");
  const from = Number(t.project_id);
  await db.query("UPDATE topics SET project_id = $2, updated_at = now() WHERE id = $1", [topicId, dest]);
  await linkOwners(db, [topicId], dest);
  const note = `Movido de «${await name(db, "projects", from)}» a «${await name(db, "projects", dest)}» (reorganización): ${reason}`;
  for (const projectId of [from, dest]) {
    await logChange(db, { projectId, meetingId: null, entity: "tema", entityId: topicId, entityTitle: t.title,
      action: "movido", note });
  }
}

export async function applyProposal(proposalId: number): Promise<void> {
  const row = await one<{ kind: ReorgKind; payload: Proposal; status: string; reason: string }>(
    "SELECT kind, payload, status, reason FROM reorg_proposals WHERE id = $1", [proposalId]);
  if (!row || row.status !== "pendiente") return;
  const x = row.payload;
  try {
    await tx(async (db) => {
      switch (row.kind) {
        case "mover_tema":
          await moveTopic(db, x.tema_id!, x.proyecto_destino_id!, row.reason);
          break;

        case "renombrar_tema": {
          const t = await one<{ project_id: string; title: string }>(
            "SELECT project_id, title FROM topics WHERE id = $1", [x.tema_id], db);
          if (!t) throw new Error("El tema ya no existe");
          await db.query("UPDATE topics SET title = $2, updated_at = now() WHERE id = $1", [x.tema_id, x.nuevo_titulo!.trim()]);
          await logChange(db, { projectId: Number(t.project_id), meetingId: null, entity: "tema", entityId: x.tema_id!,
            entityTitle: x.nuevo_titulo!.trim(), action: "actualizado",
            note: `Renombrado desde «${t.title}» (reorganización): ${row.reason}` });
          break;
        }

        case "mover_tarea": {
          const k = await one<{ title: string; project_id: string }>(
            `SELECT k.title, t.project_id FROM tasks k JOIN topics t ON t.id = k.topic_id WHERE k.id = $1`,
            [x.tarea_id], db);
          if (!k) throw new Error("La tarea ya no existe");
          let dest = x.tema_destino_id;
          if (dest == null) {
            const created = await one<{ id: string }>(
              "INSERT INTO topics (project_id, title) VALUES ($1, $2) RETURNING id",
              [x.proyecto_destino_id, x.nuevo_titulo!.trim()], db);
            dest = Number(created!.id);
            await logChange(db, { projectId: x.proyecto_destino_id!, meetingId: null, entity: "tema", entityId: dest,
              entityTitle: x.nuevo_titulo!.trim(), action: "creado", newStatus: "abierto", note: "Creado al reorganizar" });
          }
          const destTopic = await one<{ project_id: string; title: string }>(
            "SELECT project_id, title FROM topics WHERE id = $1", [dest], db);
          if (!destTopic) throw new Error("El tema de destino ya no existe");
          await db.query("UPDATE tasks SET topic_id = $2, updated_at = now() WHERE id = $1", [x.tarea_id, dest]);
          await db.query("UPDATE topics SET status = 'abierto', closed_at = NULL WHERE id = $1 AND status = 'cerrado'" +
            " AND EXISTS (SELECT 1 FROM tasks WHERE id = $2 AND status NOT IN ('completada','cancelada'))",
            [dest, x.tarea_id]);
          await linkOwners(db, [dest], Number(destTopic.project_id));
          const note = `Movida al tema «${destTopic.title}»${destTopic.project_id !== k.project_id
            ? ` del proyecto «${await name(db, "projects", Number(destTopic.project_id))}»` : ""} (reorganización): ${row.reason}`;
          for (const projectId of new Set([Number(k.project_id), Number(destTopic.project_id)])) {
            await logChange(db, { projectId, meetingId: null, entity: "tarea", entityId: x.tarea_id!,
              entityTitle: k.title, action: "movido", note });
          }
          break;
        }

        case "mover_reunion": {
          const m = await one<{ project_id: string; title: string }>(
            "SELECT project_id, title FROM meetings WHERE id = $1", [x.reunion_id], db);
          if (!m) throw new Error("La reunión ya no existe");
          await db.query("UPDATE meetings SET project_id = $2 WHERE id = $1", [x.reunion_id, x.proyecto_destino_id]);
          await db.query(
            `INSERT INTO project_people (project_id, person_id)
               SELECT $1::bigint, person_id FROM meeting_people WHERE meeting_id = $2 ON CONFLICT DO NOTHING`,
            [x.proyecto_destino_id, x.reunion_id]);
          const note = `Reunión movida de «${await name(db, "projects", Number(m.project_id))}» a «${
            await name(db, "projects", x.proyecto_destino_id!)}» (reorganización): ${row.reason}`;
          for (const projectId of [Number(m.project_id), x.proyecto_destino_id!]) {
            await logChange(db, { projectId, meetingId: x.reunion_id, entity: "reunion", entityId: x.reunion_id!,
              entityTitle: m.title, action: "movido", note });
          }
          break;
        }

        case "fusionar_temas": {
          const [keep, ...rest] = x.temas_ids;
          const target = await one<{ project_id: string; title: string }>(
            "SELECT project_id, title FROM topics WHERE id = $1", [keep], db);
          if (!target) throw new Error("El tema principal ya no existe");
          const titles = await query<{ title: string }>(
            "SELECT title FROM topics WHERE id = ANY($1::bigint[])", [rest], db);
          await db.query("UPDATE tasks SET topic_id = $1, updated_at = now() WHERE topic_id = ANY($2::bigint[])", [keep, rest]);
          await db.query("DELETE FROM topics WHERE id = ANY($1::bigint[])", [rest]);
          const title = x.nuevo_titulo?.trim() || target.title;
          await db.query(
            `UPDATE topics SET title = $2, updated_at = now(),
               status = CASE WHEN EXISTS (SELECT 1 FROM tasks WHERE topic_id = $1
                 AND status NOT IN ('completada','cancelada')) THEN 'abierto' ELSE status END
             WHERE id = $1`, [keep, title]);
          await linkOwners(db, [keep], Number(target.project_id));
          await logChange(db, { projectId: Number(target.project_id), meetingId: null, entity: "tema", entityId: keep,
            entityTitle: title, action: "actualizado",
            note: `Fusionado con: ${titles.map((t) => `«${t.title}»`).join(", ")} (reorganización): ${row.reason}` });
          break;
        }

        case "fusionar_proyectos": {
          const from = x.proyecto_origen_id!, dest = x.proyecto_destino_id!;
          const fromName = await name(db, "projects", from);
          // Reuniones de la misma grabación ya presentes en el destino: se descartan las del origen.
          await db.query(
            `DELETE FROM meetings m WHERE m.project_id = $1 AND m.source_path IS NOT NULL AND EXISTS (
               SELECT 1 FROM meetings d WHERE d.project_id = $2 AND d.source_path = m.source_path)`, [from, dest]);
          await db.query("UPDATE meetings SET project_id = $2 WHERE project_id = $1", [from, dest]);
          await db.query("UPDATE topics SET project_id = $2 WHERE project_id = $1", [from, dest]);
          await db.query(
            `INSERT INTO project_people (project_id, person_id, role, summary)
               SELECT $2, person_id, role, summary FROM project_people WHERE project_id = $1
             ON CONFLICT (project_id, person_id) DO UPDATE SET
               role = COALESCE(project_people.role, EXCLUDED.role),
               summary = CONCAT_WS(' ', project_people.summary, EXCLUDED.summary)`, [from, dest]);
          await db.query("UPDATE changes SET project_id = $2 WHERE project_id = $1", [from, dest]);
          await db.query(
            `UPDATE projects d SET description = COALESCE(d.description, f.description), updated_at = now()
             FROM projects f WHERE d.id = $2 AND f.id = $1`, [from, dest]);
          await db.query("DELETE FROM projects WHERE id = $1", [from]);
          await logChange(db, { projectId: dest, meetingId: null, entity: "proyecto", entityId: from,
            entityTitle: fromName, action: "movido",
            note: `Proyecto «${fromName}» fusionado en este (reorganización): ${row.reason}` });
          break;
        }
      }
      await db.query("UPDATE reorg_proposals SET status = 'aplicada', applied_at = now(), error = NULL WHERE id = $1",
        [proposalId]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await query("UPDATE reorg_proposals SET status = 'error', error = $2 WHERE id = $1", [proposalId, msg]);
  }
}
