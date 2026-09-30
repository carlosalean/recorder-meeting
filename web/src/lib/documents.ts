import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { askStructured } from "./analysis";
import { one, query } from "./db";

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

/** Parte un texto largo en "páginas" de ~4000 caracteres (por párrafos), para poder repartirlo. */
export function chunkText(text: string, size = 4000): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > size) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Une páginas con marcas "=== Página N ===" (solo las indicadas, si se pasan). */
export function joinPages(pages: string[], only?: number[]): string {
  const nums = only?.length ? only : pages.map((_, i) => i + 1);
  if (pages.length === 1 && nums.length === 1 && nums[0] === 1) return pages[0];
  return nums.filter((n) => n >= 1 && n <= pages.length)
    .map((n) => `=== Página ${n} ===\n${pages[n - 1]}`).join("\n\n");
}

const clean = (t: string) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Página "sin texto" (seguramente una imagen) si tiene menos caracteres que esto. */
const MIN_PAGE_CHARS = 20;
/** Límite de páginas que se envían a la IA en una sola petición. */
export const MAX_AI_PAGES = 100;

const OcrSchema = z.object({
  paginas: z.array(z.object({
    numero: z.number().int().describe("Número de página (empezando en 1)"),
    texto: z.string().describe("Todo el texto de la página. Las tablas, una fila por línea con celdas separadas por ' | '"),
  })),
});

const OCR_SYSTEM = `Eres un transcriptor de documentos. Recibirás un PDF (a menudo páginas escaneadas, capturas \
o exportaciones de OneNote). Transcribe fielmente TODO el texto de cada página, en su idioma original, sin \
resumir ni interpretar. Las tablas, una fila por línea con las celdas separadas por " | ". Si una página tiene \
imágenes con texto (capturas de pantalla, diagramas), incluye ese texto. Si una página no tiene texto, devuelve \
su texto vacío.`;

/** Lee un PDF con Claude (para PDFs escaneados o con el texto como imagen). */
async function readPdfWithAi(buf: Buffer, totalPages: number): Promise<string[]> {
  if (totalPages > MAX_AI_PAGES) {
    throw new Error(`El PDF parece escaneado y tiene ${totalPages} páginas; divídelo en partes de ${MAX_AI_PAGES} como máximo`);
  }
  const res = await askStructured(OcrSchema, OCR_SYSTEM, [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
    { type: "text", text: `Transcribe las ${totalPages} páginas de este documento.` },
  ], { effort: "low", maxTokens: 64000 });
  const pages = Array.from({ length: totalPages }, () => "");
  for (const p of res.paginas) if (p.numero >= 1 && p.numero <= totalPages) pages[p.numero - 1] = clean(p.texto);
  return pages;
}

/** Extrae el texto de un documento, por páginas (o por fragmentos si no es un PDF). Usa caché. */
export async function readDocumentPages(rel: string, opts: { useCache?: boolean } = {}):
  Promise<{ title: string; date: Date; pages: string[]; method: "texto" | "ia" }> {
  const full = safeDocPath(rel);
  const st = await fs.stat(/*turbopackIgnore: true*/ full);
  const ext = path.extname(full).toLowerCase();
  const title = path.basename(full, ext);
  if (opts.useCache !== false) {
    const hit = await one<{ pages: string[]; method: "texto" | "ia" }>(
      "SELECT pages, method FROM document_cache WHERE path = $1 AND mtime = $2 AND size = $3",
      [rel, st.mtime, st.size]).catch(() => null);
    if (hit) return { title, date: st.mtime, pages: hit.pages, method: hit.method };
  }
  const buf = await fs.readFile(/*turbopackIgnore: true*/ full);
  let pages: string[];
  let method: "texto" | "ia" = "texto";
  if (ext === ".pdf") {
    const { extractText } = await import("unpdf");
    const r = await extractText(new Uint8Array(buf), { mergePages: false });
    pages = r.text.map(clean);
    // Si la mayoría de las páginas no tienen texto, el PDF es escaneado (o imágenes): se lee con IA.
    const empty = pages.filter((p) => p.replace(/\s+/g, "").length < MIN_PAGE_CHARS).length;
    if (empty > r.totalPages / 2) {
      pages = await readPdfWithAi(buf, r.totalPages);
      method = "ia";
    }
  } else {
    let text: string;
    if (ext === ".docx") {
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
    pages = chunkText(clean(text));
  }
  if (!pages.some((p) => p.trim())) {
    throw new Error("No se ha podido extraer texto del documento");
  }
  await query(
    `INSERT INTO document_cache (path, mtime, size, pages, method) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (path) DO UPDATE SET mtime = $2, size = $3, pages = $4, method = $5, updated_at = now()`,
    [rel, st.mtime, st.size, JSON.stringify(pages), method]).catch((e) => console.error("[caché de documentos]", e));
  return { title, date: st.mtime, pages, method };
}

/** Extrae el texto completo de un documento (con marcas de página). */
export async function readDocument(rel: string): Promise<{ title: string; date: Date; text: string }> {
  const d = await readDocumentPages(rel);
  return { title: d.title, date: d.date, text: joinPages(d.pages) };
}

const UPLOAD_DIR = "Subidos";

/** Guarda un archivo subido desde la web en DOCUMENTOS_DIR/Subidos (sin sobrescribir). Devuelve su ruta relativa. */
export async function saveUploadedDocument(name: string, data: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (!EXT.includes(ext)) throw new Error(`Formato no admitido: ${name} (usa ${EXT.join(", ")})`);
  const base = path.basename(name, path.extname(name)).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 120) || "documento";
  const dir = path.join(/*turbopackIgnore: true*/ documentsRoot(), UPLOAD_DIR);
  await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  for (let i = 0; ; i++) {
    const file = `${base}${i ? ` (${i + 1})` : ""}${ext}`;
    try {
      await fs.writeFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, file), data, { flag: "wx" });
      return `${UPLOAD_DIR}/${file}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
