import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { one } from "@/lib/db";
import { safeResolve } from "@/lib/recordings";

const TYPES: Record<string, string> = {
  ".flac": "audio/flac", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".webm": "audio/webm", ".mp4": "video/mp4",
};

/** Sirve el audio de una reunión, con soporte de rangos para poder saltar en el reproductor. */
export async function GET(req: Request, ctx: RouteContext<"/api/audio/[id]">) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return new Response("No encontrado", { status: 404 });
  const m = await one<{ audio_file: string | null }>("SELECT audio_file FROM meetings WHERE id = $1", [id]);
  if (!m?.audio_file) return new Response("No encontrado", { status: 404 });

  let file: string;
  let size: number;
  try {
    file = safeResolve(m.audio_file);
    size = (await fs.stat(/*turbopackIgnore: true*/ file)).size;
  } catch {
    return new Response("El archivo de audio ya no está disponible", { status: 404 });
  }
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);

  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }
  const stream = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ file)) as ReadableStream;
  return new Response(stream, {
    headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" },
  });
}
