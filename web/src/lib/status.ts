export const TASK_STATUSES = ["pendiente", "en_progreso", "bloqueada", "completada", "cancelada"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const CLOSED_TASK: readonly TaskStatus[] = ["completada", "cancelada"];

export const TOPIC_STATUSES = ["abierto", "cerrado"] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const PROJECT_STATUSES = ["activo", "en_pausa", "cerrado"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  en_progreso: "En progreso",
  bloqueada: "Bloqueada",
  completada: "Completada",
  cancelada: "Cancelada",
  abierto: "Abierto",
  cerrado: "Cerrado",
  activo: "Activo",
  en_pausa: "En pausa",
  procesando: "Procesando…",
  procesada: "Procesada",
  error: "Error",
};

export const label = (s: string | null | undefined) => (s ? (LABELS[s] ?? s) : "—");

export const isClosedTask = (s: string) => (CLOSED_TASK as readonly string[]).includes(s);

// Nivel jerárquico y capacidad de decisión de una persona.
export const HIERARCHY_LEVELS = [
  "alta_direccion", "direccion", "gerencia", "mando_intermedio", "tecnico", "operativo", "externo",
] as const;
export const INFLUENCE_LEVELS = ["decisor", "influyente", "participante", "informado"] as const;

export const PERSON_LABELS: Record<string, string> = {
  alta_direccion: "Alta dirección (CEO, director general)",
  direccion: "Dirección (director de área)",
  gerencia: "Gerencia / responsable de departamento",
  mando_intermedio: "Mando intermedio (jefe de equipo, PM)",
  tecnico: "Técnico / especialista",
  operativo: "Operativo / soporte",
  externo: "Externo (proveedor, consultor…)",
  decisor: "Decisor: aprueba y decide",
  influyente: "Influyente: su opinión pesa en las decisiones",
  participante: "Participante: ejecuta o usa",
  informado: "Informado: solo hay que mantenerle al tanto",
};
export const PERSON_SHORT: Record<string, string> = {
  alta_direccion: "Alta dirección", direccion: "Dirección", gerencia: "Gerencia",
  mando_intermedio: "Mando intermedio", tecnico: "Técnico", operativo: "Operativo", externo: "Externo",
  decisor: "Decisor", influyente: "Influyente", participante: "Participante", informado: "Informado",
};
