import { z } from "zod";
import { askStructured } from "./analysis";
import { one, query, tx } from "./db";
import { listRecordings, readRecording } from "./recordings";
import { processMeeting } from "./tracking";

/**
 * Asignación automática de grabaciones a proyectos.
 *
 * La IA lee la transcripción y la compara con el catálogo de proyectos (cliente,
 * descripción, temas abiertos y personas). Solo asigna cuando tiene confianza
 * ALTA; si duda, deja sugerencias para que el usuario confirme con un clic.
 * Una reunión puede tratar varios proyectos: se crea una reunión por proyecto,
 * cada una limitada a su parte de la conversación.
 */

export const CONFIDENCES = ["alta", "media", "baja"] as const;

export const TriageSchema = z.object({
  resumen: z.string().describe("De qué trata la reunión, en una o dos frases"),
  proyectos: z
    .array(
      z.object({
        proyecto_id: z.number().int().describe("ID de un proyecto del catálogo ([PR..])"),
        confianza: z.string().describe(`Una de: ${CONFIDENCES.join(", ")}`),
        motivo: z.string().describe("Por qué se relaciona con este proyecto (cita nombres, temas o personas)"),
        alcance: z.string().describe("Qué partes de la reunión corresponden a este proyecto"),
      }),
    )
    .describe("Proyectos tratados en la reunión, del más al menos relevante. Vacío si ninguno encaja"),
  proyecto_nuevo: z
    .object({ cliente: z.string(), nombre: z.string(), descripcion: z.string() })
    .nullable()
    .describe("Si la reunión trata claramente de un proyecto que NO está en el catálogo, cuál sería; si no, null"),
});
export type Triage = z.infer<typeof TriageSchema>;

const SYSTEM = `Eres el CLASIFICADOR de reuniones de un profesional que trabaja en varios proyectos para \\
distintos clientes. Recibirás un catálogo de proyectos y la transcripción automática de una reunión. \\
Tu trabajo es decir a qué proyecto o proyectos pertenece.

Criterios de confianza:
- "alta": no hay duda razonable. Se nombra el proyecto o el cliente, o se tratan temas abiertos de ese \\
proyecto, o participan personas claramente ligadas a él y el contenido encaja.
- "media": encaja bastante pero falta alguna confirmación (p. ej. solo coinciden algunos temas genéricos).
- "baja": posible pero dudoso.
Sé conservador: una asignación errónea contamina el seguimiento del proyecto. Ante la duda, no uses "alta".

Si en la reunión se tratan de forma sustancial varios proyectos, inclúyelos todos, cada uno con su alcance. \\
No incluyas proyectos que solo se mencionan de pasada. Si no encaja ninguno, devuelve la lista vacía. \\
Escribe en español y usa los IDs exactamente como aparecen.`;

type CatalogProject = {
  id: string; name: string; client: string; status: string; description: string | null;
  ai_summary: string | null; topics: string[]; people: string[];
};

async function loadCatalog(): Promise<CatalogProject[]> {
  return query<CatalogProject>(
    `SELECT p.id, p.name, c.name AS client, p.status, p.description, p.ai_summary,
       ARRAY(SELECT t.title FROM topics t WHERE t.project_id = p.id AND t.status = 'abierto'
             ORDER BY t.updated_at DESC LIMIT 15) AS topics,
       ARRAY(SELECT pe.name FROM project_people pp JOIN people pe ON pe.id = pp.person_id
             WHERE pp.project_id = p.id ORDER BY pp.updated_at DESC LIMIT 12) AS people
     FROM projects p JOIN clients c ON c.id = p.client_id
     WHERE p.status <> 'cerrado' ORDER BY c.name, p.name`,
  );
}

export function renderCatalog(projects: CatalogProject[]): string {
  if (!projects.length) return "CATÁLOGO DE PROYECTOS: (vacío)";
  const clean = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
  const lines = ["CATÁLOGO DE PROYECTOS:"];
  for (const p of projects) {
    lines.push(`[PR${p.id}] ${p.name} — cliente: ${p.client}${p.status === "en_pausa" ? " (en pausa)" : ""}`);
    const about = clean(p.ai_summary) || clean(p.description);
    if (about) lines.push(`   de qué va: ${about}`);
    if (p.topics.length) lines.push(`   temas abiertos: ${p.topics.join("; ")}`);
    if (p.people.length) lines.push(`   personas: ${p.people.join(", ")}`);
  }
  return lines.join("\n");
}

export type Suggestion = { project_id: string; confidence: string; reason: string; scope: string };

/** Decide qué hacer con la clasificación: asignar (solo confianza alta), dudar o nada. */
export function decide(t: Triage, validIds: Set<string>) {
  const suggestions: Suggestion[] = [];
  for (const p of t.proyectos) {
    const id = String(p.proyecto_id);
    if (!validIds.has(id) || suggestions.some((s) => s.project_id === id)) continue;
    const confidence = (CONFIDENCES as readonly string[]).includes(p.confianza.trim().toLowerCase())
      ? p.confianza.trim().toLowerCase() : "baja";
    suggestions.push({ project_id: id, confidence, reason: p.motivo, scope: p.alcance });
  }
  const assign = suggestions.filter((s) => s.confidence === "alta").slice(0, 4);
  const status = assign.length ? "asignada" : suggestions.length ? "dudosa" : "sin_proyecto";
  return { status, assign, suggestions } as const;
}

async function setTriage(folder: string, fields: {
  status: string; suggestions?: Suggestion[]; new_project?: unknown; summary?: string | null; error?: string | null;
}) {
  await query(
    `INSERT INTO recording_triage (folder, status, suggestions, new_project, summary, error, updated_at)
     VALUES ($1, $2, COALESCE($3::jsonb, '[]'), $4, $5, $6, now())
     ON CONFLICT (folder) DO UPDATE SET status = EXCLUDED.status,
       suggestions = COALESCE($3::jsonb, recording_triage.suggestions),
       new_project = COALESCE($4::jsonb, recording_triage.new_project),
       summary = COALESCE($5, recording_triage.summary), error = $6, updated_at = now()`,
    [folder, fields.status, fields.suggestions ? JSON.stringify(fields.suggestions) : null,
     fields.new_project ? JSON.stringify(fields.new_project) : null, fields.summary ?? null, fields.error ?? null],
  );
}

/**
 * Crea una reunión por proyecto a partir de una grabación. Si son varios proyectos,
 * cada reunión lleva una nota de alcance para que la IA solo trate su parte.
 * Devuelve los IDs de las reuniones creadas (las ya existentes se omiten).
 */
export async function createMeetingsFromRecording(
  folder: string,
  assign: { project_id: string; scope?: string | null }[],
): Promise<number[]> {
  const rec = await readRecording(folder);
  const names = new Map(
    (await query<{ id: string; name: string }>(
      "SELECT id, name FROM projects WHERE id = ANY($1::bigint[])", [assign.map((a) => a.project_id)],
    )).map((p) => [p.id, p.name]),
  );
  return tx(async (db) => {
    const ids: number[] = [];
    for (const a of assign) {
      const others = assign.filter((x) => x.project_id !== a.project_id).map((x) => `"${names.get(x.project_id)}"`);
      const scope = others.length
        ? `Esta reunión trató varios proyectos (también ${others.join(", ")}). Ocúpate SOLO de lo relativo ` +
          `a "${names.get(a.project_id)}"${a.scope ? `: ${a.scope}` : ""}. Ignora lo demás.`
        : null;
      const row = await one<{ id: string }>(
        `INSERT INTO meetings (project_id, title, meeting_date, transcript, recorder_summary, source,
                               source_path, audio_file, status, scope_note)
         VALUES ($1,$2,$3,$4,$5,'grabadora',$6,$7,'procesando',$8)
         ON CONFLICT (source_path, project_id) DO NOTHING RETURNING id`,
        [a.project_id, rec.title, rec.date ?? new Date(), rec.transcript, rec.summary, folder, rec.audio, scope],
        db,
      );
      if (row) ids.push(Number(row.id));
    }
    return ids;
  });
}

/** Clasifica una grabación y, si la IA lo tiene claro, la asigna y la procesa. */
export async function triageRecording(folder: string): Promise<void> {
  try {
    await setTriage(folder, { status: "clasificando" });
    const [rec, catalog] = await Promise.all([readRecording(folder), loadCatalog()]);
    const user = [
      renderCatalog(catalog),
      "",
      `REUNIÓN: "${rec.title}"${rec.date ? ` — fecha: ${rec.date.toISOString().slice(0, 10)}` : ""}`,
      rec.summary ? `\n<resumen_previo>\n${rec.summary}\n</resumen_previo>` : "",
      `\n<transcripcion>\n${rec.transcript}\n</transcripcion>`,
    ].join("\n");
    const result = await askStructured(TriageSchema, SYSTEM, user, { effort: "medium", maxTokens: 16000 });
    const decision = decide(result, new Set(catalog.map((p) => p.id)));
    await setTriage(folder, {
      status: decision.status, suggestions: decision.suggestions, new_project: result.proyecto_nuevo,
      summary: result.resumen,
    });
    if (decision.status === "asignada") {
      const ids = await createMeetingsFromRecording(folder, decision.assign);
      for (const id of ids) await processMeeting(id);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[clasificación ${folder}]`, e);
    await setTriage(folder, { status: "error", error: msg }).catch(() => {});
  }
}

const state = globalThis as unknown as { __scanRunning?: boolean; __scanTimer?: NodeJS.Timeout };

/** Clasifica las grabaciones nuevas (sin proyecto ni clasificación previa). */
export async function scanRecordings(opts: { retryErrors?: boolean } = {}): Promise<number> {
  if (state.__scanRunning) return 0;
  state.__scanRunning = true;
  try {
    const { available, items } = await listRecordings();
    if (!available) return 0;
    const imported = new Set((await query<{ source_path: string }>(
      "SELECT DISTINCT source_path FROM meetings WHERE source_path IS NOT NULL")).map((r) => r.source_path));
    const newest = await one<{ n: number; last: Date | null }>(
      "SELECT count(*)::int AS n, max(created_at) AS last FROM projects WHERE status <> 'cerrado'");
    if (!newest?.n) return 0; // sin proyectos no hay nada a lo que asignar
    const triaged = new Map((await query<{ folder: string; status: string; updated_at: Date }>(
      "SELECT folder, status, updated_at FROM recording_triage")).map((r) => [r.folder, r]));
    let n = 0;
    // De la más antigua a la más reciente: así los estados de las tareas evolucionan en orden.
    for (const r of [...items].reverse()) {
      if (imported.has(r.folder)) continue;
      const t = triaged.get(r.folder);
      // Se reintentan las que no encajaban en ningún proyecto si desde entonces se ha creado alguno.
      const retry = t && (
        (opts.retryErrors && (t.status === "error" || t.status === "clasificando")) ||
        (t.status === "sin_proyecto" && newest.last && newest.last > t.updated_at));
      if (t && !retry) continue;
      await triageRecording(r.folder);
      n++;
    }
    return n;
  } finally {
    state.__scanRunning = false;
  }
}

/** Revisa periódicamente la carpeta de grabaciones (AUTO_ASSIGN_MINUTES, 0 = desactivado). */
export function startAutoAssign() {
  const minutes = Number(process.env.AUTO_ASSIGN_MINUTES ?? "5");
  if (!minutes || minutes <= 0 || state.__scanTimer) return;
  const run = () => scanRecordings().catch((e) => console.error("[asignación automática]", e));
  state.__scanTimer = setInterval(run, minutes * 60_000);
  setTimeout(run, 20_000);
  console.log(`[asignación automática] activada: revisa las grabaciones cada ${minutes} min`);
}

export const isScanning = () => Boolean(state.__scanRunning);
