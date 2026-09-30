import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PSTFolder } from "pst-extractor";
import { one, query } from "./db";

/**
 * Importación de correos desde exportaciones de Outlook (.pst / .ost).
 *
 * Los correos se guardan en la base de datos agrupados en hilos (por asunto
 * normalizado). Cada hilo es una "fuente" que la IA puede asignar a un proyecto
 * y analizar igual que una reunión (clave de fuente: "correo:<hilo>").
 */

export const emailsRoot = () => process.env.CORREOS_DIR || "/correos";

/** Carpetas de Outlook que no aportan contexto de proyecto. */
const SKIP_FOLDERS = /^(elementos eliminados|deleted items|correo no deseado|junk|spam|borradores|drafts|bandeja de salida|outbox|calendario|calendar|contactos|contacts|tareas|tasks|notas|notes|diario|journal|rss|conversation history|historial de conversaciones|sync issues|problemas de sincronización)/i;
/** Remitentes automáticos (notificaciones, boletines…). */
const NOISE_SENDER = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|notificaciones@|newsletter|bounce)/i;

/** "RE: RV: [EXT] Asunto" → "asunto". */
export function threadKey(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/^\s*\[[^\]]{1,20}\]\s*/, "")
      .replace(/^\s*(re|fw|fwd|rv|reenv|reenviado|aw|wg|tr|r)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim() || "(sin asunto)";
}

/** Quita el historial citado ("De: … Enviado: …", "-----Original Message-----", líneas con ">"). */
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^-{2,}\s*(original message|mensaje original)/i.test(l)) break;
    if (/^(de|from)\s*:/i.test(l) && out.some((x) => x.trim()) &&
      lines.slice(i + 1, i + 5).some((n) => /^(enviado|sent|fecha|date|para|to)\s*:/i.test(n))) break;
    if (/^(el|on)\s.{5,120}(escribió|wrote):\s*$/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const stripHtml = (html: string) =>
  html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export type PstFile = { file: string; size: number; status: string | null; emails: number; error: string | null;
  since: string | null };

export async function listPstFiles(): Promise<{ available: boolean; files: PstFile[] }> {
  let entries: string[];
  try {
    entries = await fs.readdir(/*turbopackIgnore: true*/ emailsRoot());
  } catch {
    return { available: false, files: [] };
  }
  const status = new Map((await query<{ file: string; status: string; emails: number; error: string | null; since: string | null }>(
    "SELECT file, status, emails, error, to_char(since, 'YYYY-MM-DD') AS since FROM email_sources")).map((r) => [r.file, r]));
  const files: PstFile[] = [];
  for (const f of entries) {
    if (!/\.(pst|ost)$/i.test(f)) continue;
    const st = await fs.stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ emailsRoot(), f)).catch(() => null);
    if (!st?.isFile()) continue;
    const s = status.get(f);
    files.push({ file: f, size: st.size, status: s?.status ?? null, emails: s?.emails ?? 0, error: s?.error ?? null,
      since: s?.since ?? null });
  }
  return { available: true, files };
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * Importa un .pst (puede tardar con archivos grandes; cede el control al servidor
 * periódicamente para no bloquearlo). Los correos ya importados se omiten.
 */
export async function importPst(file: string, since: Date | null): Promise<number> {
  if (path.basename(file) !== file || !/\.(pst|ost)$/i.test(file)) throw new Error("Archivo no válido");
  await query(
    `INSERT INTO email_sources (file, status, since, emails) VALUES ($1, 'importando', $2, 0)
     ON CONFLICT (file) DO UPDATE SET status = 'importando', since = $2, error = NULL, imported_at = now()`,
    [file, since]);
  let count = 0;
  try {
    const { PSTFile } = await import("pst-extractor");
    const pst = new PSTFile(path.join(/*turbopackIgnore: true*/ emailsRoot(), file));
    let batch: unknown[][] = [];
    const flush = async () => {
      if (!batch.length) return;
      const cols = 11;
      const values = batch.map((_, i) =>
        `(${Array.from({ length: cols }, (__, j) => `$${i * cols + j + 1}${j === 8 ? "::timestamptz" : ""}`).join(",")})`);
      const res = await query<{ id: string }>(
        `INSERT INTO emails (source_file, message_key, thread_key, subject, from_name, from_email, to_text, cc_text,
                             sent_at, folder, body)
         VALUES ${values.join(",")} ON CONFLICT (message_key) DO NOTHING RETURNING id`,
        batch.flatMap((row) => [file, ...row]));
      count += res.length;
      batch = [];
      await query("UPDATE email_sources SET emails = emails + $2 WHERE file = $1", [file, res.length]);
    };
    const walk = async (folder: PSTFolder, where: string) => {
      if (folder.hasSubfolders) {
        for (const child of folder.getSubFolders()) {
          if (SKIP_FOLDERS.test(child.displayName.trim())) continue;
          await walk(child, where ? `${where}/${child.displayName}` : child.displayName);
        }
      }
      if (folder.contentCount <= 0) return;
      let m = folder.getNextChild();
      let n = 0;
      while (m) {
        if (++n % 50 === 0) await tick();
        const date = m.clientSubmitTime ?? m.messageDeliveryTime ?? null;
        const isNote = (m.messageClass ?? "").startsWith("IPM.Note");
        const sender = `${m.senderName ?? ""} ${m.senderEmailAddress ?? ""}`;
        if (isNote && !(since && date && date < since) && !NOISE_SENDER.test(sender)) {
          const raw = m.body?.trim() ? m.body : stripHtml(m.bodyHTML ?? "");
          const body = stripQuoted(raw).slice(0, 8000);
          const subject = (m.subject ?? "").trim() || "(sin asunto)";
          const key = m.internetMessageId?.trim() ||
            createHash("sha1").update(`${subject}|${date?.toISOString()}|${sender}`).digest("hex");
          if (body || subject) {
            batch.push([key, threadKey(m.conversationTopic || subject), subject, m.senderName || null,
              m.senderEmailAddress || null, m.displayTo || null, m.displayCC || null, date, where, body]);
          }
          if (batch.length >= 200) await flush();
        }
        m = folder.getNextChild();
      }
    };
    await walk(pst.getRootFolder(), "");
    await flush();
    pst.close();
    await query("UPDATE email_sources SET status = 'importado' WHERE file = $1", [file]);
    return count;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[correos ${file}]`, e);
    await query("UPDATE email_sources SET status = 'error', error = $2 WHERE file = $1", [file, msg]);
    return count;
  }
}

// ---------------------------------------------------------------------------
// Hilos
// ---------------------------------------------------------------------------

export type Thread = {
  thread_key: string; subject: string; emails: number; first_at: Date | null; last_at: Date | null;
  senders: string[];
};

export const THREAD_PREFIX = "correo:";

export async function listThreads(opts: { limit?: number; offset?: number; q?: string } = {}) {
  const params: unknown[] = [];
  const where = opts.q ? `WHERE subject ILIKE $${params.push(`%${opts.q}%`)} OR from_name ILIKE $${params.length}` : "";
  return query<Thread>(
    `SELECT thread_key, (array_agg(subject ORDER BY sent_at))[1] AS subject, count(*)::int AS emails,
       min(sent_at) AS first_at, max(sent_at) AS last_at,
       (array_agg(DISTINCT coalesce(from_name, from_email)))[1:6] AS senders
     FROM emails ${where} GROUP BY thread_key ORDER BY max(sent_at) DESC NULLS LAST
     LIMIT ${Number(opts.limit ?? 50)} OFFSET ${Number(opts.offset ?? 0)}`, params);
}

export const countThreads = () =>
  one<{ threads: number; emails: number }>(
    "SELECT count(DISTINCT thread_key)::int AS threads, count(*)::int AS emails FROM emails");

/** Texto del hilo en orden cronológico, listo para la IA. */
export async function threadText(key: string, maxChars = 120_000) {
  const rows = await query<{ subject: string; from_name: string | null; from_email: string | null; to_text: string | null;
    cc_text: string | null; sent_at: Date | null; body: string }>(
    "SELECT subject, from_name, from_email, to_text, cc_text, sent_at, body FROM emails WHERE thread_key = $1 ORDER BY sent_at",
    [key]);
  if (!rows.length) throw new Error("El hilo de correo ya no existe");
  const parts = rows.map((r) => [
    `### ${r.sent_at ? r.sent_at.toISOString().slice(0, 16).replace("T", " ") : "sin fecha"} — De: ${
      [r.from_name, r.from_email && `<${r.from_email}>`].filter(Boolean).join(" ")}`,
    r.to_text ? `Para: ${r.to_text}` : "",
    r.cc_text ? `CC: ${r.cc_text}` : "",
    `Asunto: ${r.subject}`,
    "",
    r.body,
  ].filter((l, i) => l || i === 4).join("\n"));
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = `[… hilo largo: se omiten los mensajes más antiguos …]\n\n${text.slice(-maxChars)}`;
  return { subject: rows[0].subject, date: rows[rows.length - 1].sent_at, text, count: rows.length };
}

export type ThreadRow = Thread & { status: string | null };

/** Hilos con su estado de clasificación ('pendiente' si la IA aún no los ha visto). */
export async function listThreadsWithState(opts: { estado?: string; q?: string; limit?: number; offset?: number }) {
  const params: unknown[] = [THREAD_PREFIX];
  const where: string[] = [];
  if (opts.q) {
    const p = params.push(`%${opts.q}%`);
    where.push(`(subject ILIKE $${p} OR from_name ILIKE $${p} OR from_email ILIKE $${p})`);
  }
  const state = `CASE WHEN EXISTS (SELECT 1 FROM meetings m WHERE m.source_path = $1 || g.thread_key) THEN 'asignada'
                      ELSE coalesce(t.status, 'pendiente') END`;
  const filter = opts.estado && opts.estado !== "todos" ? `WHERE ${state} = $${params.push(opts.estado)}` : "";
  return query<ThreadRow>(
    `SELECT g.*, ${state} AS status FROM (
       SELECT thread_key, (array_agg(subject ORDER BY sent_at))[1] AS subject, count(*)::int AS emails,
         min(sent_at) AS first_at, max(sent_at) AS last_at,
         (array_agg(DISTINCT coalesce(from_name, from_email)))[1:6] AS senders
       FROM emails ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY thread_key
     ) g LEFT JOIN recording_triage t ON t.folder = $1 || g.thread_key
     ${filter} ORDER BY g.last_at DESC NULLS LAST
     LIMIT ${Number(opts.limit ?? 50)} OFFSET ${Number(opts.offset ?? 0)}`, params);
}

export const threadStats = () =>
  query<{ status: string; n: number }>(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM meetings m WHERE m.source_path = $1 || g.thread_key) THEN 'asignada'
                 ELSE coalesce(t.status, 'pendiente') END AS status, count(*)::int AS n
     FROM (SELECT DISTINCT thread_key FROM emails) g LEFT JOIN recording_triage t ON t.folder = $1 || g.thread_key
     GROUP BY 1`, [THREAD_PREFIX]);
