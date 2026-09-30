import { z } from "zod";
import { askStructured } from "./analysis";
import { CONFIDENCES } from "./status";
import { one, query, tx } from "./db";
import { DOC_PREFIX, listDocuments } from "./documents";
import { THREAD_PREFIX, threadText } from "./emails";
import { listRecordings } from "./recordings";
import { SOURCE_NATURE, type SourceKind, loadSource } from "./sources";
import { processMeeting } from "./tracking";
import { runDocPlan } from "./docplan";

/**
 * Asignación automática de grabaciones a proyectos.
 *
 * La IA lee la transcripción y la compara con el catálogo de proyectos (cliente,
 * descripción, temas abiertos y personas). Solo asigna cuando tiene confianza
 * ALTA; si duda, deja sugerencias para que el usuario confirme con un clic.
 * Una reunión puede tratar varios proyectos: se crea una reunión por proyecto,
 * cada una limitada a su parte de la conversación.
 */

export { CONFIDENCES } from "./status";

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

const SYSTEM = `Eres el CLASIFICADOR de reuniones de un profesional que trabaja en varios proyectos para \
distintos clientes. Recibirás un catálogo de proyectos y la transcripción automática de una reunión. \
Tu trabajo es decir a qué proyecto o proyectos pertenece.

Criterios de confianza:
- "alta": no hay duda razonable. Se nombra el proyecto o el cliente, o se tratan temas abiertos de ese \
proyecto, o participan personas claramente ligadas a él y el contenido encaja.
- "media": encaja bastante pero falta alguna confirmación (p. ej. solo coinciden algunos temas genéricos).
- "baja": posible pero dudoso.
Sé conservador: una asignación errónea contamina el seguimiento del proyecto. Ante la duda, no uses "alta".

Si en la reunión se tratan de forma sustancial varios proyectos, inclúyelos todos, cada uno con su alcance. \
No incluyas proyectos que solo se mencionan de pasada. Si no encaja ninguno, devuelve la lista vacía. \
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
 * Crea una reunión por proyecto a partir de una fuente (grabación, hilo de correo o
 * documento). Si son varios proyectos, cada reunión lleva una nota de alcance para
 * que la IA solo trate su parte. Devuelve los IDs creados (los ya existentes se omiten).
 */
export async function createMeetingsFromSource(
  key: string,
  assign: { project_id: string; scope?: string | null; text?: string | null }[],
): Promise<number[]> {
  const src = await loadSource(key);
  const names = new Map(
    (await query<{ id: string; name: string }>(
      "SELECT id, name FROM projects WHERE id = ANY($1::bigint[])", [assign.map((a) => a.project_id)],
    )).map((p) => [p.id, p.name]),
  );
  return tx(async (db) => {
    const ids: number[] = [];
    for (const a of assign) {
      const others = assign.filter((x) => x.project_id !== a.project_id).map((x) => `"${names.get(x.project_id)}"`);
      const multi = others.length
        ? `Esta fuente trata varios proyectos (también ${others.join(", ")}). Ocúpate SOLO de lo relativo ` +
          `a "${names.get(a.project_id)}"${a.scope ? `: ${a.scope}` : ""}. Ignora lo demás.`
        : null;
      const scope = [SOURCE_NATURE[src.kind], multi].filter(Boolean).join(" ") || null;
      const row = await one<{ id: string }>(
        `INSERT INTO meetings (project_id, title, meeting_date, transcript, recorder_summary, source,
                               source_path, audio_file, status, scope_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'procesando',$9)
         ON CONFLICT (source_path, project_id) DO NOTHING RETURNING id`,
        [a.project_id, src.title, src.date ?? new Date(), a.text || src.text, src.summary, src.kind, key, src.audio, scope],
        db,
      );
      if (row) ids.push(Number(row.id));
    }
    return ids;
  });
}

/** Aplica la decisión de la IA: guarda las sugerencias y, si está clara, asigna y procesa. */
async function applyDecision(key: string, result: Triage, validIds: Set<string>) {
  const decision = decide(result, validIds);
  await setTriage(key, {
    status: decision.status, suggestions: decision.suggestions, new_project: result.proyecto_nuevo,
    summary: result.resumen,
  });
  if (decision.status === "asignada") {
    const ids = await createMeetingsFromSource(key, decision.assign);
    for (const id of ids) await processMeeting(id);
  }
}

const LABEL: Record<SourceKind, string> = { grabadora: "REUNIÓN", correo: "HILO DE CORREO", documento: "DOCUMENTO" };

/** Clasifica una fuente y, si la IA lo tiene claro, la asigna y la procesa. */
export async function triageSource(key: string): Promise<void> {
  try {
    await setTriage(key, { status: "clasificando" });
    const [src, catalog] = await Promise.all([loadSource(key), loadCatalog()]);
    // Para clasificar basta con una parte generosa del texto.
    const text = src.text.length > 60_000 ? `${src.text.slice(0, 40_000)}\n[…]\n${src.text.slice(-20_000)}` : src.text;
    const user = [
      renderCatalog(catalog),
      "",
      `${LABEL[src.kind]}: "${src.title}"${src.date ? ` — fecha: ${src.date.toISOString().slice(0, 10)}` : ""}`,
      src.kind !== "grabadora" ? SOURCE_NATURE[src.kind] ?? "" : "",
      src.summary ? `\n<resumen_previo>\n${src.summary}\n</resumen_previo>` : "",
      `\n<contenido>\n${text}\n</contenido>`,
    ].join("\n");
    const result = await askStructured(TriageSchema, SYSTEM, user, { effort: "medium", maxTokens: 16000 });
    await applyDecision(key, result, new Set(catalog.map((p) => p.id)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[clasificación ${key}]`, e);
    await setTriage(key, { status: "error", error: msg }).catch(() => {});
  }
}

// Nombres anteriores (grabaciones).
export const triageRecording = triageSource;
export const createMeetingsFromRecording = createMeetingsFromSource;

// ---------------------------------------------------------------------------
// Correos: clasificación por lotes (muchos hilos en una sola consulta)
// ---------------------------------------------------------------------------

const BatchSchema = z.object({
  hilos: z.array(TriageSchema.extend({ hilo: z.string().describe("Identificador del hilo, p. ej. 'H3'") })),
});

/**
 * Clasifica hilos de correo pendientes en lotes de `batchSize` (un resumen de cada
 * hilo por consulta, para que el coste sea asumible con miles de correos).
 * Los hilos asignados con seguridad se procesan después uno a uno.
 */
export async function triageEmailThreads(opts: { limit?: number; batchSize?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 200, batchSize = opts.batchSize ?? 20;
  const catalog = await loadCatalog();
  if (!catalog.length) return 0;
  const pending = await query<{ thread_key: string }>(
    `SELECT e.thread_key FROM emails e
     WHERE NOT EXISTS (SELECT 1 FROM recording_triage t WHERE t.folder = $1 || e.thread_key AND t.status <> 'error')
       AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.source_path = $1 || e.thread_key)
     GROUP BY e.thread_key ORDER BY max(e.sent_at) DESC NULLS LAST LIMIT $2`,
    [THREAD_PREFIX, limit]);
  const valid = new Set(catalog.map((p) => p.id));
  let done = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const keys = batch.map((b) => THREAD_PREFIX + b.thread_key);
    for (const k of keys) await setTriage(k, { status: "clasificando" });
    try {
      const blocks: string[] = [];
      for (const [j, b] of batch.entries()) {
        const t = await threadText(b.thread_key);
        const excerpt = t.text.length > 2500 ? `${t.text.slice(0, 900)}\n[…]\n${t.text.slice(-1600)}` : t.text;
        blocks.push(`=== [H${j + 1}] ${t.subject} (${t.count} correos) ===\n${excerpt}`);
      }
      const user = [
        renderCatalog(catalog), "",
        "Clasifica CADA uno de estos HILOS DE CORREO por separado. Devuelve un elemento en 'hilos' por cada " +
          "[H..], con su identificador. Los correos que no tengan que ver con ningún proyecto (publicidad, " +
          "trámites internos, notificaciones…) van con la lista de proyectos vacía.",
        "", blocks.join("\n\n"),
      ].join("\n");
      const res = await askStructured(BatchSchema, SYSTEM, user, { effort: "low", maxTokens: 32000 });
      const byId = new Map(res.hilos.map((h) => [h.hilo.replace(/[^\d]/g, ""), h]));
      for (const [j, key] of keys.entries()) {
        const h = byId.get(String(j + 1));
        if (!h) {
          await setTriage(key, { status: "error", error: "La IA no devolvió este hilo" });
          continue;
        }
        await applyDecision(key, h, valid);
        done++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[clasificación de correos]", e);
      for (const k of keys) await setTriage(k, { status: "error", error: msg }).catch(() => {});
    }
  }
  return done;
}

const state = globalThis as unknown as { __scanRunning?: boolean; __scanTimer?: NodeJS.Timeout };

/**
 * Clasifica las grabaciones nuevas (sin proyecto ni clasificación previa) y prepara
 * el plan de los documentos nuevos (que pueden proponer proyectos nuevos).
 */
export async function scanRecordings(opts: { retryErrors?: boolean } = {}): Promise<number> {
  if (state.__scanRunning) return 0;
  state.__scanRunning = true;
  try {
    const [recs, docs] = await Promise.all([listRecordings(), listDocuments()]);
    // De más antiguo a más reciente, para que los estados evolucionen en orden.
    const items = [
      ...recs.items.map((r) => ({ key: r.folder, date: r.date, doc: false })),
      ...docs.files.map((d) => ({ key: DOC_PREFIX + d.path, date: d.modified, doc: true })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());
    if (!items.length) return 0;
    const imported = new Set((await query<{ source_path: string }>(
      "SELECT DISTINCT source_path FROM meetings WHERE source_path IS NOT NULL")).map((r) => r.source_path));
    const newest = await one<{ n: number; last: Date | null }>(
      "SELECT count(*)::int AS n, max(created_at) AS last FROM projects WHERE status <> 'cerrado'");
    const triaged = new Map((await query<{ folder: string; status: string; updated_at: Date }>(
      "SELECT folder, status, updated_at FROM recording_triage")).map((r) => [r.folder, r]));
    const plans = new Map((await query<{ source_key: string; status: string }>(
      "SELECT source_key, status FROM doc_plans")).map((r) => [r.source_key, r.status]));
    let n = 0;
    for (const r of items) {
      if (imported.has(r.key)) continue;
      if (r.doc) {
        const p = plans.get(r.key);
        if (p && !(opts.retryErrors && p === "error")) continue;
        await runDocPlan(r.key);
        n++;
        continue;
      }
      if (!newest?.n) continue; // sin proyectos no hay nada a lo que asignar las grabaciones
      const t = triaged.get(r.key);
      // Se reintentan las que no encajaban en ningún proyecto si desde entonces se ha creado alguno.
      const retry = t && (
        (opts.retryErrors && (t.status === "error" || t.status === "clasificando")) ||
        (t.status === "sin_proyecto" && newest.last && newest.last > t.updated_at));
      if (t && !retry) continue;
      await triageSource(r.key);
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
