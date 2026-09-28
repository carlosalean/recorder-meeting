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
