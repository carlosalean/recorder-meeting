import { promises as fs } from "node:fs";
import path from "node:path";

/** Carpeta donde la grabadora (meeting-recorder) guarda las reuniones. En Docker se monta en /reuniones. */
export const recordingsRoot = () => process.env.REUNIONES_DIR || "/reuniones";

const AUDIO_EXT = [".flac", ".wav", ".mp3", ".m4a", ".ogg", ".webm", ".mp4"];

export type Recording = {
  folder: string;
  title: string;
  date: Date;
  audio: string | null;
  hasSummary: boolean;
  transcriptChars: number;
};

/** "2026-09-28_10-21_reunion-inicial" → fecha 2026-09-28 10:21 y título "Reunion inicial". */
export function parseFolderName(folder: string): { date: Date | null; title: string } {
  const m = folder.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:_(.+))?$/);
  if (!m) return { date: null, title: folder };
  const [, y, mo, d, h, mi, slug] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const words = slug ? slug.replace(/[-_]+/g, " ").trim() : "";
  const title = words ? words[0].toUpperCase() + words.slice(1) : `Reunión ${y}-${mo}-${d} ${h}:${mi}`;
  return { date, title };
}

/** Resuelve una carpeta de grabación impidiendo salir de la raíz (../ etc.). */
export function safeResolve(rel: string): string {
  const root = path.resolve(/*turbopackIgnore: true*/ recordingsRoot());
  const full = path.resolve(/*turbopackIgnore: true*/ root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Ruta no válida");
  return full;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(/*turbopackIgnore: true*/ file, "utf-8");
  } catch {
    return null;
  }
}

export async function listRecordings(): Promise<{ available: boolean; items: Recording[] }> {
  let entries;
  try {
    entries = await fs.readdir(/*turbopackIgnore: true*/ recordingsRoot(), { withFileTypes: true });
  } catch {
    return { available: false, items: [] };
  }
  const items: Recording[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = safeResolve(e.name);
    const files = await fs.readdir(/*turbopackIgnore: true*/ dir).catch(() => [] as string[]);
    if (!files.includes("transcripcion.txt")) continue;
    const stat = await fs.stat(/*turbopackIgnore: true*/ path.join(dir, "transcripcion.txt"));
    const { date, title } = parseFolderName(e.name);
    items.push({
      folder: e.name,
      title,
      date: date ?? stat.mtime,
      audio: files.find((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()) && !f.startsWith("_")) ?? null,
      hasSummary: files.includes("resumen.md"),
      transcriptChars: stat.size,
    });
  }
  return { available: true, items: items.sort((a, b) => b.date.getTime() - a.date.getTime()) };
}

export async function readRecording(folder: string) {
  const dir = safeResolve(folder);
  const transcript = await readIfExists(path.join(dir, "transcripcion.txt"));
  if (transcript === null) throw new Error(`La carpeta ${folder} no tiene transcripcion.txt`);
  const files = await fs.readdir(/*turbopackIgnore: true*/ dir);
  const audio = files.find((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()) && !f.startsWith("_"));
  return {
    ...parseFolderName(folder),
    transcript,
    summary: await readIfExists(path.join(dir, "resumen.md")),
    audio: audio ? path.posix.join(folder, audio) : null,
  };
}
