import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Documentos (exportaciones de OneNote, actas, especificaciones…) que la IA puede
 * asignar a proyectos y analizar igual que una reunión. Clave de fuente: "doc:<ruta>".
 */

export const documentsRoot = () => process.env.DOCUMENTOS_DIR || "/documentos";
export const DOC_PREFIX = "doc:";
const EXT = [".pdf", ".docx", ".txt", ".md", ".html", ".htm", ".mht", ".mhtml"];

export type DocFile = { path: string; name: string; ext: string; size: number; modified: Date };

function safeDocPath(rel: string): string {
  const root = path.resolve(/*turbopackIgnore: true*/ documentsRoot());
  const full = path.resolve(/*turbopackIgnore: true*/ root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error("Ruta no válida");
  return full;
}

/** Lista los documentos (también en subcarpetas, hasta 3 niveles). */
export async function listDocuments(): Promise<{ available: boolean; files: DocFile[] }> {
  const root = documentsRoot();
  try {
    await fs.access(/*turbopackIgnore: true*/ root);
  } catch {
    return { available: false, files: [] };
  }
  const files: DocFile[] = [];
  const walk = async (rel: string, depth: number) => {
    const entries = await fs.readdir(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, rel), { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) await walk(r, depth + 1);
      const ext = path.extname(e.name).toLowerCase();
      if (!e.isFile() || !EXT.includes(ext)) continue;
      const st = await fs.stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, r));
      files.push({ path: r, name: e.name.slice(0, -ext.length), ext, size: st.size, modified: st.mtime });
    }
  };
  await walk("", 0);
  return { available: true, files: files.sort((a, b) => b.modified.getTime() - a.modified.getTime()) };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    // Contenido de cada celda en una sola línea, para que cada fila de la tabla quede en una línea.
    .replace(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, inner: string) =>
      `<${tag}>${inner.replace(/<\/?(p|div|br)[^>]*>/gi, " ").replace(/\s+/g, " ").trim()}</${tag}>`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<\/t[dh]>[ \t]*/gi, " | ")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeQuotedPrintable(s: string): Buffer {
  const clean = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "=" && /^[0-9A-F]{2}$/i.test(clean.slice(i + 1, i + 3))) {
      bytes.push(parseInt(clean.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(clean.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** .mht (página web de un solo archivo, formato de exportación de OneNote): extrae la parte HTML. */
export function mhtToText(raw: string): string {
  const boundary = raw.match(/boundary="?([^"\r\n;]+)"?/i)?.[1];
  const parts = boundary ? raw.split(`--${boundary}`) : [raw];
  const texts: string[] = [];
  for (const part of parts) {
    const [head, ...rest] = part.split(/\r?\n\r?\n/);
    if (!/content-type:\s*text\/html/i.test(head)) continue;
    const body = rest.join("\n\n");
    const enc = head.match(/content-transfer-encoding:\s*([\w-]+)/i)?.[1]?.toLowerCase();
    const charset = head.match(/charset="?([\w-]+)/i)?.[1]?.toLowerCase() ?? "utf-8";
    const buf = enc === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64")
      : enc === "quoted-printable" ? decodeQuotedPrintable(body) : Buffer.from(body, "latin1");
    const decoded = new TextDecoder(charset === "utf-8" || charset === "utf8" ? "utf-8" : charset).decode(buf);
    texts.push(htmlToText(decoded));
  }
  return texts.join("\n\n").trim();
}

/** Extrae el texto de un documento. */
export async function readDocument(rel: string): Promise<{ title: string; date: Date; text: string }> {
  const full = safeDocPath(rel);
  const [buf, st] = await Promise.all([
    fs.readFile(/*turbopackIgnore: true*/ full), fs.stat(/*turbopackIgnore: true*/ full),
  ]);
  const ext = path.extname(full).toLowerCase();
  let text: string;
  if (ext === ".pdf") {
    const { extractText } = await import("unpdf");
    text = (await extractText(new Uint8Array(buf), { mergePages: true })).text;
  } else if (ext === ".docx") {
    const mammoth = await import("mammoth");
    // Vía HTML para conservar las tablas (una fila por línea, celdas separadas por "|").
    text = htmlToText((await mammoth.convertToHtml({ buffer: buf })).value);
  } else if (ext === ".mht" || ext === ".mhtml") {
    text = mhtToText(buf.toString("latin1"));
  } else if (ext === ".html" || ext === ".htm") {
    text = htmlToText(buf.toString("utf-8"));
  } else {
    text = buf.toString("utf-8");
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("No se ha podido extraer texto del documento (¿es una imagen escaneada?)");
  return { title: path.basename(full, ext), date: st.mtime, text };
}
