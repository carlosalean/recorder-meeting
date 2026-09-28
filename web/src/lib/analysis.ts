import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { TASK_STATUSES, TOPIC_STATUSES } from "./status";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

// Se piden como texto (y se normalizan al aplicarlos) para que un valor inesperado no invalide todo el resultado.
const TaskStatus = z.string().describe(`Uno de: ${TASK_STATUSES.join(", ")}`);
const TopicStatus = z.string().describe(`Uno de: ${TOPIC_STATUSES.join(", ")}`);
const nullableDate = z
  .string()
  .nullable()
  .describe("Fecha en formato YYYY-MM-DD, o null si no se menciona");

export const AnalysisSchema = z.object({
  resumen: z
    .string()
    .describe("Resumen de la reunión en Markdown: propósito, conclusiones y decisiones principales"),
  temas_nuevos: z.array(
    z.object({
      clave: z.string().describe("Identificador temporal, p. ej. 'N1', para referenciarlo en tareas_nuevas"),
      titulo: z.string(),
      descripcion: z.string(),
    }),
  ),
  cambios_temas: z.array(
    z.object({
      tema_id: z.number().int().describe("ID de un tema EXISTENTE (el número de [T..])"),
      estado: TopicStatus,
      nota: z.string().describe("Por qué cambia el estado"),
    }),
  ),
  tareas_nuevas: z.array(
    z.object({
      tema_id: z.number().int().nullable().describe("ID de un tema existente, o null si va en un tema nuevo"),
      tema_clave: z.string().nullable().describe("Clave de un tema de temas_nuevos, o null"),
      titulo: z.string(),
      descripcion: z.string(),
      responsable: z.string().nullable(),
      fecha_limite: nullableDate,
      estado: TaskStatus,
      evidencia: z.string().describe("Marca de tiempo y cita breve de la transcripción"),
    }),
  ),
  cambios_tareas: z.array(
    z.object({
      tarea_id: z.number().int().describe("ID de una tarea EXISTENTE (el número de [#..])"),
      estado: TaskStatus.nullable().describe("Nuevo estado, o null si no cambia"),
      responsable: z.string().nullable().describe("Nuevo responsable, o null si no cambia"),
      fecha_limite: nullableDate,
      nota: z.string().describe("Qué se dijo sobre la tarea"),
      evidencia: z.string().describe("Marca de tiempo y cita breve de la transcripción"),
    }),
  ),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

const SYSTEM = `Eres el asistente de seguimiento de proyectos de una consultora. Tu trabajo es \
mantener al día la lista de TEMAS y TAREAS de un proyecto a partir de las transcripciones de sus reuniones.

Recibirás el estado actual del proyecto (temas con sus tareas, cada uno con su ID) y la transcripción \
automática de una nueva reunión. La transcripción tiene marcas de tiempo [hh:mm:ss], puede contener \
errores de reconocimiento y no indica quién habla: deduce responsables por el contexto ("yo me encargo", \
"Ana lo revisa", presentaciones...) y si no puedes saberlo deja el responsable en null. No inventes.

Reglas:
- ANTES de crear algo, busca si ya existe un tema o tarea equivalente (aunque esté redactado distinto). \
Si existe, actualízalo en cambios_tareas/cambios_temas en lugar de duplicarlo.
- Cambia el estado de una tarea solo si la reunión lo justifica: "completada" si se confirma que está \
hecha; "en_progreso" si se dice que se está trabajando en ella; "bloqueada" si algo impide avanzar; \
"cancelada" si se decide no hacerla; "pendiente" si se reabre.
- Crea tareas nuevas solo para compromisos o acciones concretas (alguien tiene que hacer algo), no para \
comentarios generales.
- Agrupa las tareas en temas (áreas de trabajo o asuntos del proyecto). Reutiliza temas existentes cuando \
encajen; crea temas nuevos solo cuando haga falta.
- Cierra un tema cuando se dé por resuelto y no queden acciones pendientes en él; reábrelo si vuelve a surgir.
- Las fechas relativas ("el viernes", "la semana que viene") conviértelas a YYYY-MM-DD usando la fecha de la reunión.
- En evidencia, pon la marca de tiempo y una cita breve que justifique el cambio.
- Usa los IDs exactamente como aparecen. Escribe todo en español.`;

export type ProjectContext = {
  client: string;
  project: string;
  description: string | null;
  topics: {
    id: number;
    title: string;
    description: string | null;
    status: string;
    tasks: { id: number; title: string; owner: string | null; due_date: string | null; status: string }[];
  }[];
};

export function renderContext(ctx: ProjectContext): string {
  const lines = [`CLIENTE: ${ctx.client}`, `PROYECTO: ${ctx.project}`];
  if (ctx.description) lines.push(`DESCRIPCIÓN: ${ctx.description}`);
  lines.push("", "ESTADO ACTUAL DE TEMAS Y TAREAS:");
  if (!ctx.topics.length) lines.push("(todavía no hay temas: es la primera reunión registrada)");
  for (const t of ctx.topics) {
    lines.push(`[T${t.id}] (${t.status}) ${t.title}${t.description ? ` — ${t.description}` : ""}`);
    for (const k of t.tasks) {
      lines.push(
        `   [#${k.id}] (${k.status}) ${k.title} | responsable: ${k.owner ?? "sin asignar"} | fecha límite: ${k.due_date ?? "sin fecha"}`,
      );
    }
  }
  return lines.join("\n");
}

export class AnalysisError extends Error {}

export function anthropicClient(): Anthropic {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  return new Anthropic({
    defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined,
  });
}

export async function analyzeMeeting(
  ctx: ProjectContext,
  meeting: { title: string; date: string; transcript: string; recorderSummary?: string | null },
  client: Anthropic = anthropicClient(),
): Promise<Analysis> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AnalysisError("Falta ANTHROPIC_API_KEY en el archivo .env");
  }
  const user = [
    renderContext(ctx),
    "",
    `NUEVA REUNIÓN: "${meeting.title}" — fecha: ${meeting.date}`,
    meeting.recorderSummary
      ? `\n<resumen_previo>\n${meeting.recorderSummary}\n</resumen_previo>`
      : "",
    `\n<transcripcion>\n${meeting.transcript}\n</transcripcion>`,
  ].join("\n");

  // Streaming: las transcripciones largas generan peticiones largas y así se evitan timeouts.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(AnalysisSchema) },
    // Si un filtro de seguridad rechaza la petición por error, la API reintenta con otro modelo.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new AnalysisError("El modelo rechazó procesar esta transcripción.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new AnalysisError("La respuesta del modelo se cortó por longitud.");
  }
  if (!message.parsed_output) {
    throw new AnalysisError("El modelo no devolvió un resultado válido.");
  }
  return message.parsed_output;
}
