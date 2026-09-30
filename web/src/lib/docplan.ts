import { z } from "zod";
import { askStructured } from "./analysis";
import { one, query, tx } from "./db";
import { DOC_PREFIX, joinPages, readDocumentPages } from "./documents";
import { processMeeting } from "./tracking";
import { CONFIDENCES } from "./status";
import { createMeetingsFromSource } from "./triage";

/**
 * Importación de documentos como base de conocimiento (p. ej. un cuaderno de OneNote
 * exportado a PDF). La IA lee el documento completo y propone un PLAN: qué proyectos
 * trata (existentes o nuevos, con su cliente), de qué va cada uno y qué páginas le
 * corresponden. Si todo encaja con seguridad en proyectos existentes, se aplica sola;
 * si propone crear proyectos o clientes, espera a que el usuario lo confirme.
 * Al aplicarlo, cada proyecto recibe solo sus páginas y la IA completa temas, tareas,
 * personas y la descripción del proyecto.
 */

export const PlanSchema = z.object({
  resumen: z.string().describe("Qué es el documento y qué contiene, en 1-3 frases"),
  proyectos: z
    .array(
      z.object({
        proyecto_id: z.number().int().nullable()
          .describe("ID de un proyecto del catálogo ([PR..]); null si es un proyecto NUEVO"),
        nombre: z.string().describe("Nombre del proyecto (el del catálogo si ya existe; si es nuevo, uno corto y claro)"),
        cliente_id: z.number().int().nullable()
          .describe("ID de un cliente existente ([CL..]); null si el cliente no está en la lista"),
        cliente_nombre: z.string().describe("Nombre del cliente o empresa para la que es el proyecto"),
        descripcion: z.string().describe("De qué va el proyecto según el documento: objetivo, alcance, tecnología, estado (2-5 frases)"),
        paginas: z.array(z.number().int()).describe("Números de las páginas del documento con información de este proyecto"),
        confianza: z.string().describe(`Una de: ${CONFIDENCES.join(", ")}`),
        motivo: z.string().describe("Por qué el documento trata este proyecto (cita el texto)"),
      }),
    )
    .describe("Proyectos de los que el documento tiene información relevante. Vacío si ninguno"),
});
export type PlanResult = z.infer<typeof PlanSchema>;

export type PlanItem = {
  project_id: string | null;
  name: string;
  client_id: string | null;
  client_name: string;
  description: string;
  pages: number[];
  confidence: string;
  reason: string;
};
export type DocPlan = { summary: string; total_pages: number; method: string; items: PlanItem[] };

const SYSTEM = `Eres el DOCUMENTALISTA de un profesional (desarrollador y arquitecto de software) que trabaja en \
varios proyectos para distintos clientes. Recibirás su catálogo de clientes y proyectos y un DOCUMENTO (p. ej. \
un cuaderno de OneNote exportado a PDF, un acta o una especificación) dividido en páginas.

Tu trabajo es decir de qué proyectos contiene información el documento, para incorporarla a su base de conocimiento:
- Usa un proyecto EXISTENTE (con su proyecto_id) siempre que el documento hable de él, aunque lo llame de otra forma \
(siglas, nombre del producto, del cliente…).
- Propón un proyecto NUEVO (proyecto_id null) solo si el documento trata de forma sustancial un proyecto que no está \
en el catálogo. Indica su cliente: si el cliente ya existe, usa su cliente_id; si no, cliente_id null y su nombre.
- Indica las páginas que tratan cada proyecto; una página puede ir en varios proyectos (p. ej. una tabla resumen).
- No incluyas proyectos que solo se mencionan de pasada ni páginas genéricas sin información útil.

Confianza: "alta" solo si no hay duda razonable de que la información es de ese proyecto; "media" si encaja \
bastante; "baja" si es dudoso. Sé conservador. Escribe en español y usa los IDs exactamente como aparecen.`;

type Catalog = {
  clients: { id: string; name: string }[];
  projects: { id: string; name: string; client_id: string; client: string; status: string; about: string | null }[];
};

async function loadCatalog(): Promise<Catalog> {
  const [clients, projects] = await Promise.all([
    query<{ id: string; name: string }>("SELECT id, name FROM clients ORDER BY name"),
    query<Catalog["projects"][number]>(
      `SELECT p.id, p.name, p.client_id, c.name AS client, p.status,
              COALESCE(NULLIF(p.ai_summary, ''), p.description) AS about
       FROM projects p JOIN clients c ON c.id = p.client_id ORDER BY c.name, p.name`),
  ]);
  return { clients, projects };
}

export function renderCatalog(c: Catalog): string {
  const lines = ["CLIENTES Y PROYECTOS:"];
  if (!c.clients.length) lines.push("(todavía no hay ninguno)");
  for (const cl of c.clients) {
    lines.push(`[CL${cl.id}] ${cl.name}`);
    for (const p of c.projects.filter((x) => x.client_id === cl.id)) {
      const about = (p.about ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      lines.push(`   [PR${p.id}] ${p.name}${p.status !== "activo" ? ` (${p.status.replace("_", " ")})` : ""}` +
        (about ? ` — ${about}` : ""));
    }
  }
  return lines.join("\n");
}

/** Texto para el plan: si el documento es muy largo, recorta cada página para que quepa entero. */
export function planText(pages: string[], maxChars = 150_000): string {
  const total = pages.reduce((n, p) => n + p.length, 0);
  if (total <= maxChars) return joinPages(pages);
  const per = Math.max(300, Math.floor(maxChars / pages.length));
  return joinPages(pages.map((p) => (p.length > per ? `${p.slice(0, per)} […]` : p)));
}

const lc = (s: string) => s.trim().toLowerCase();

/** Normaliza la respuesta de la IA: IDs válidos, páginas en rango, sin duplicados. */
export function normalizePlan(r: PlanResult, c: Catalog, totalPages: number): PlanItem[] {
  const items: PlanItem[] = [];
  for (const p of r.proyectos) {
    let project = c.projects.find((x) => x.id === String(p.proyecto_id ?? ""));
    let client = project
      ? c.clients.find((x) => x.id === project!.client_id)
      : c.clients.find((x) => x.id === String(p.cliente_id ?? "")) ??
        c.clients.find((x) => lc(x.name) === lc(p.cliente_nombre));
    // Un "nuevo" que ya existe con el mismo nombre (en ese cliente, o en cualquiera si no se sabe el cliente).
    if (!project) {
      project = c.projects.find((x) => lc(x.name) === lc(p.nombre) && (!client || x.client_id === client.id));
      if (project) client = c.clients.find((x) => x.id === project!.client_id);
    }
    const pages = [...new Set(p.paginas.filter((n) => n >= 1 && n <= totalPages))].sort((a, b) => a - b);
    const confidence = (CONFIDENCES as readonly string[]).includes(lc(p.confianza)) ? lc(p.confianza) : "baja";
    const item: PlanItem = {
      project_id: project?.id ?? null,
      name: project?.name ?? p.nombre.trim(),
      client_id: client?.id ?? null,
      client_name: client?.name ?? p.cliente_nombre.trim(),
      description: p.descripcion.trim(),
      pages: pages.length ? pages : Array.from({ length: totalPages }, (_, i) => i + 1),
      confidence,
      reason: p.motivo,
    };
    if (!item.name || !item.client_name) continue;
    const dup = items.find((x) => (item.project_id ? x.project_id === item.project_id
      : !x.project_id && lc(x.name) === lc(item.name) && lc(x.client_name) === lc(item.client_name)));
    if (dup) {
      dup.pages = [...new Set([...dup.pages, ...item.pages])].sort((a, b) => a - b);
      continue;
    }
    items.push(item);
  }
  return items;
}

/** Se aplica sin preguntar solo si todo va a proyectos existentes con confianza alta. */
export const canAutoApply = (items: PlanItem[]) =>
  items.length > 0 && items.length <= 6 && items.every((i) => i.project_id && i.confidence === "alta");

async function setPlan(key: string, status: string, plan?: DocPlan | null, error?: string | null) {
  await query(
    `INSERT INTO doc_plans (source_key, status, plan, error) VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_key) DO UPDATE SET status = $2, plan = COALESCE($3, doc_plans.plan), error = $4,
       updated_at = now()`,
    [key, status, plan ? JSON.stringify(plan) : null, error ?? null]);
}

/** Lee el documento, pide el plan a la IA y, si es seguro, lo aplica. */
export async function runDocPlan(key: string, opts: { auto?: boolean } = {}): Promise<void> {
  try {
    await setPlan(key, "analizando");
    const [doc, catalog] = await Promise.all([readDocumentPages(key.slice(DOC_PREFIX.length)), loadCatalog()]);
    const user = [
      renderCatalog(catalog),
      "",
      `DOCUMENTO: "${doc.title}" — ${doc.pages.length} página(s), modificado el ${doc.date.toISOString().slice(0, 10)}`,
      `\n<documento>\n${planText(doc.pages)}\n</documento>`,
    ].join("\n");
    const res = await askStructured(PlanSchema, SYSTEM, user, { effort: "medium", maxTokens: 32000 });
    const items = normalizePlan(res, catalog, doc.pages.length);
    const plan: DocPlan = { summary: res.resumen, total_pages: doc.pages.length, method: doc.method, items };
    await setPlan(key, "lista", plan);
    if (opts.auto !== false && canAutoApply(items)) {
      const ids = await applyDocPlan(key, items.map((_, i) => ({ index: i })));
      for (const id of ids) await processMeeting(id);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[plan de documento ${key}]`, e);
    await setPlan(key, "error", null, msg).catch(() => {});
  }
}

export type PlanChoice = { index: number; name?: string | null; client_name?: string | null };

/**
 * Aplica las propuestas elegidas del plan: crea los clientes y proyectos nuevos y una
 * reunión (fuente "documento") por proyecto con solo sus páginas. Devuelve los IDs de
 * las reuniones creadas, que hay que procesar después con processMeeting.
 */
export async function applyDocPlan(key: string, choices: PlanChoice[]): Promise<number[]> {
  const row = await one<{ plan: DocPlan | null }>("SELECT plan FROM doc_plans WHERE source_key = $1", [key]);
  if (!row?.plan) throw new Error("Este documento no tiene un plan; analízalo primero");
  const plan = row.plan;
  const chosen = choices.filter((c) => plan.items[c.index]);
  if (!chosen.length) throw new Error("Elige al menos un proyecto");

  const targets = await tx(async (db) => {
    const out: { project_id: string; pages: number[]; scope: string }[] = [];
    for (const c of chosen) {
      const item = plan.items[c.index];
      let projectId = item.project_id;
      if (projectId && !(await one("SELECT 1 FROM projects WHERE id = $1", [projectId], db))) projectId = null;
      if (!projectId) {
        const clientName = (c.client_name || item.client_name).trim();
        const name = (c.name || item.name).trim();
        if (!clientName || !name) throw new Error("Falta el nombre del proyecto o del cliente");
        const client = (item.client_id && !c.client_name
          ? await one<{ id: string }>("SELECT id FROM clients WHERE id = $1", [item.client_id], db) : null)
          ?? await one<{ id: string }>("SELECT id FROM clients WHERE lower(name) = lower($1)", [clientName], db)
          ?? await one<{ id: string }>("INSERT INTO clients (name) VALUES ($1) RETURNING id", [clientName], db);
        const project = await one<{ id: string }>(
          "SELECT id FROM projects WHERE client_id = $1 AND lower(name) = lower($2)", [client!.id, name], db)
          ?? await one<{ id: string }>(
            "INSERT INTO projects (client_id, name, description) VALUES ($1, $2, $3) RETURNING id",
            [client!.id, name, item.description || null], db);
        projectId = project!.id;
      } else if (item.description) {
        // Si el proyecto no tenía descripción, se completa con la del documento.
        await db.query(
          "UPDATE projects SET description = $2 WHERE id = $1 AND COALESCE(description, '') = ''",
          [projectId, item.description]);
      }
      if (!out.some((o) => o.project_id === projectId)) {
        out.push({ project_id: projectId, pages: item.pages, scope: item.reason });
      }
    }
    return out;
  });

  const rel = key.slice(DOC_PREFIX.length);
  const doc = await readDocumentPages(rel);
  const ids = await createMeetingsFromSource(key, targets.map((t) => ({
    project_id: t.project_id,
    scope: `páginas ${t.pages.join(", ")}. ${t.scope}`,
    text: joinPages(doc.pages, t.pages),
  })));
  await setPlan(key, "aplicada");
  return ids;
}

export async function discardDocPlan(key: string) {
  await setPlan(key, "descartada");
}
