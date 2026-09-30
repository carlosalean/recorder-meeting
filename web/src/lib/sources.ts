import { DOC_PREFIX, readDocument } from "./documents";
import { THREAD_PREFIX, threadText } from "./emails";
import { readRecording } from "./recordings";

/**
 * Una "fuente" es cualquier cosa de la que la IA extrae temas, tareas y personas:
 * una grabación (clave = carpeta), un hilo de correo ("correo:<hilo>") o un
 * documento ("doc:<ruta>"). Todas acaban como una reunión (fila de meetings)
 * en uno o varios proyectos.
 */

export type SourceKind = "grabadora" | "correo" | "documento";

export type Source = {
  kind: SourceKind;
  title: string;
  date: Date | null;
  text: string;
  summary: string | null;
  audio: string | null;
};

export const sourceKind = (key: string): SourceKind =>
  key.startsWith(THREAD_PREFIX) ? "correo" : key.startsWith(DOC_PREFIX) ? "documento" : "grabadora";

export async function loadSource(key: string): Promise<Source> {
  const kind = sourceKind(key);
  if (kind === "correo") {
    const t = await threadText(key.slice(THREAD_PREFIX.length));
    return { kind, title: `✉️ ${t.subject}`, date: t.date, text: t.text, summary: null, audio: null };
  }
  if (kind === "documento") {
    const d = await readDocument(key.slice(DOC_PREFIX.length));
    return { kind, title: `📄 ${d.title}`, date: d.date, text: d.text, summary: null, audio: null };
  }
  const r = await readRecording(key);
  return { kind, title: r.title, date: r.date, text: r.transcript, summary: r.summary, audio: r.audio };
}

/** Explicación para la IA de qué tipo de fuente está leyendo. */
export const SOURCE_NATURE: Record<SourceKind, string | null> = {
  grabadora: null,
  correo:
    "Esta fuente NO es una reunión: es un HILO DE CORREO (mensajes en orden cronológico con remitente, " +
    "destinatarios y fecha). Los participantes son remitentes y destinatarios; sus emails son datos de contacto fiables.",
  documento:
    "Esta fuente NO es una reunión: es un DOCUMENTO (p. ej. notas de OneNote, un acta o una especificación). " +
    "No tiene marcas de tiempo; como evidencia cita el fragmento relevante. Puede contener información de varios " +
    "proyectos, tablas de estado y listas de pendientes.",
};
