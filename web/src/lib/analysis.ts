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

const nullableText = (d: string) => z.string().nullable().describe(d);

export const AnalysisSchema = z.object({
  resumen: z
    .string()
    .describe("Resumen de la reunión en Markdown: propósito, conclusiones y decisiones principales"),
  resumen_proyecto: z
    .string()
    .describe(
      "Descripción ACTUALIZADA y acumulada del proyecto (2-6 frases): objetivo, alcance, tecnologías o " +
        "enfoque, situación actual y próximos hitos. Parte de la descripción previa y añade lo nuevo.",
    ),
  participantes: z
    .array(
      z.object({
        persona_id: z.number().int().nullable().describe("ID de una persona CONOCIDA ([P..]), o null si es nueva"),
        nombre: z.string().describe("Nombre (y apellido si se conoce)"),
        empresa: nullableText("Empresa u organización para la que trabaja, si se sabe"),
        cargo: nullableText("Cargo o puesto, si se sabe"),
        email: nullableText("Email, solo si se menciona"),
        telefono: nullableText("Teléfono, solo si se menciona"),
        asistio: z.boolean().describe("true si participó en la reunión; false si solo se la menciona"),
        rol_en_proyecto: nullableText("Papel en ESTE proyecto (p. ej. 'Product Owner del cliente'), o null"),
        resumen_en_proyecto: z
          .string()
          .describe(
            "Qué hace, de qué se encarga y qué posiciones ha tomado en ESTE proyecto, acumulado con lo ya " +
              "conocido (1-4 frases)",
          ),
        perfil: nullableText(
          "Quién es esta persona en general (empresa, puesto, especialidad, cómo se relaciona con el " +
            "usuario), acumulado con el perfil previo. null si no hay nada que añadir",
        ),
      }),
    )
    .describe("Personas que participan en la reunión o que tienen un papel relevante en lo que se habla"),
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
      responsable: z.string().nullable().describe("Nombre de la persona responsable, tal como aparece en participantes"),
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

const SYSTEM = `Eres el asistente de seguimiento de proyectos y la base de conocimiento de un profesional \
que trabaja para varias empresas. Tu trabajo es mantener al día, a partir de las transcripciones de sus \
reuniones, la lista de TEMAS y TAREAS de cada proyecto, una descripción de qué va el proyecto y quién es \
cada PERSONA (stakeholder) y qué papel tiene en cada proyecto.

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
- Personas: incluye en participantes a quienes asisten y a quienes tienen un papel relevante (responsables \
de tareas, decisores, contactos del cliente...). Si coincide con una persona conocida ([P..]) usa su ID, \
aunque el nombre aparezca abreviado, mal transcrito o como uno de sus alias ("también: ..."); crea una nueva solo si no existe. Si se indican \
participantes al subir la reunión, dales prioridad. Usa en "responsable" de las tareas el mismo nombre que \
en participantes.
- En resumen_en_proyecto y perfil, conserva lo que ya se sabía y añade lo nuevo; no borres información útil.
- Usa los IDs exactamente como aparecen. Escribe todo en español.`;

export type KnownPerson = {
  id: number;
  name: string;
  company: string | null;
  job_title: string | null;
  profile: string | null;
  role: string | null;      // papel en este proyecto
  summary: string | null;   // qué hace en este proyecto
  inProject: boolean;
  aliases?: string[];
  department?: string | null;
  level?: string | null;     // nivel jerárquico (texto legible)
  influence?: string | null; // capacidad de decisión (texto legible)
  reportsTo?: string | null;
  notes?: string | null;     // notas del usuario
};

export type ProjectContext = {
  client: string;
  project: string;
  description: string | null;
  aiSummary?: string | null;
  people?: KnownPerson[];
  topics: {
    id: number;
    title: string;
    description: string | null;
    status: string;
    tasks: { id: number; title: string; owner: string | null; due_date: string | null; status: string }[];
  }[];
};

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function renderContext(ctx: ProjectContext): string {
  const owner = [process.env.OWNER_NAME, process.env.OWNER_ROLE].filter(Boolean).join(", ");
  const lines = owner ? [`USUARIO QUE GRABA LAS REUNIONES: ${owner}`, ""] : [];
  lines.push(`CLIENTE: ${ctx.client}`, `PROYECTO: ${ctx.project}`);
  if (ctx.description) lines.push(`DESCRIPCIÓN (escrita por el usuario): ${ctx.description}`);
  if (ctx.aiSummary) lines.push(`DESCRIPCIÓN ACTUAL DEL PROYECTO: ${clean(ctx.aiSummary)}`);

  const people = ctx.people ?? [];
  const inProject = people.filter((p) => p.inProject);
  const others = people.filter((p) => !p.inProject);
  lines.push("", "PERSONAS DEL PROYECTO:");
  if (!inProject.length) lines.push("(ninguna registrada todavía)");
  const aka = (p: KnownPerson) => (p.aliases?.length ? ` (también: ${p.aliases.join(", ")})` : "");
  for (const p of inProject) {
    const head = [p.name, p.company, p.job_title, p.department].filter(Boolean).join(" — ");
    lines.push(`[P${p.id}] ${head}${aka(p)}${p.role ? ` | papel: ${p.role}` : ""}`);
    const org = [p.level && `nivel: ${p.level}`, p.influence && `influencia: ${p.influence}`,
      p.reportsTo && `reporta a: ${p.reportsTo}`].filter(Boolean).join(" | ");
    if (org) lines.push(`   ${org}`);
    if (p.summary) lines.push(`   en el proyecto: ${clean(p.summary)}`);
    if (p.profile) lines.push(`   perfil: ${clean(p.profile)}`);
    if (p.notes) lines.push(`   notas del usuario: ${clean(p.notes)}`);
  }
  if (others.length) {
    lines.push("", "OTRAS PERSONAS CONOCIDAS (de otros proyectos):");
    for (const p of others) {
      lines.push(`[P${p.id}] ${[p.name, p.company, p.job_title].filter(Boolean).join(" — ")}${aka(p)}`);
    }
  }
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
  meeting: {
    title: string;
    date: string;
    transcript: string;
    recorderSummary?: string | null;
    participantsHint?: string | null;
  },
  client: Anthropic = anthropicClient(),
): Promise<Analysis> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AnalysisError("Falta ANTHROPIC_API_KEY en el archivo .env");
  }
  const user = [
    renderContext(ctx),
    "",
    `NUEVA REUNIÓN: "${meeting.title}" — fecha: ${meeting.date}`,
    meeting.participantsHint
      ? `\nPARTICIPANTES INDICADOS POR EL USUARIO:\n${meeting.participantsHint}`
      : "\nParticipantes: no indicados; dedúcelos de la conversación.",
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
