import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.ANTHROPIC_API_KEY ||= "sk-test";
const mail = mkdtempSync(path.join(os.tmpdir(), "correos-"));
const docs = mkdtempSync(path.join(os.tmpdir(), "docs-"));
process.env.CORREOS_DIR = mail;
process.env.DOCUMENTOS_DIR = docs;
process.env.REUNIONES_DIR = mkdtempSync(path.join(os.tmpdir(), "reu-"));
copyFileSync(path.resolve("node_modules/pst-extractor/example/testdata/enron.pst"), path.join(mail, "buzon.pst"));

vi.mock("./analysis", async (orig) => ({ ...(await orig<typeof import("./analysis")>()), askStructured: vi.fn() }));
vi.mock("./tracking", async (orig) => ({
  ...(await orig<typeof import("./tracking")>()), processMeeting: vi.fn(async () => {}),
}));

const { query, one, pool } = await import("./db");
const { migrate } = await import("./migrations");
const { importPst, stripQuoted, threadKey, threadText } = await import("./emails");
const { htmlToText, mhtToText, listDocuments, readDocument } = await import("./documents");
const { triageEmailThreads, scanRecordings } = await import("./triage");
const { askStructured } = await import("./analysis");
const { processMeeting } = await import("./tracking");

describe("utilidades de correo", () => {
  it("threadKey agrupa respuestas y reenvíos", () => {
    expect(threadKey("RE: RV: [EXT] Entrega Fase 2")).toBe("entrega fase 2");
    expect(threadKey("Fw: entrega  FASE 2")).toBe("entrega fase 2");
    expect(threadKey("")).toBe("(sin asunto)");
  });
  it("stripQuoted elimina el historial citado", () => {
    const body = "Hola Ana,\nte confirmo el viernes.\n\nDe: Ana García\nEnviado: lunes\nPara: Carlos\nAsunto: x\n\nMensaje viejo";
    expect(stripQuoted(body)).toBe("Hola Ana,\nte confirmo el viernes.");
    expect(stripQuoted("Ok\n> citado\n-----Original Message-----\nviejo")).toBe("Ok");
  });
});

describe("documentos", () => {
  it("extrae el texto de un .mht exportado de OneNote (quoted-printable)", () => {
    const mht = [
      'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="----=_NextPart_01"', "",
      "------=_NextPart_01", "Content-Type: text/html; charset=\"utf-8\"", "Content-Transfer-Encoding: quoted-printable", "",
      "<html><body><h1>_TRASPASO CARLOS</h1><table><tr><td>AGB</td><td>despliegue en TEST=",
      " el 2-oct</td></tr></table><p>Revisi=C3=B3n pendiente</p></body></html>",
      "------=_NextPart_01--",
    ].join("\r\n");
    const text = mhtToText(mht);
    expect(text).toContain("_TRASPASO CARLOS");
    expect(text).toContain("AGB | despliegue en TEST el 2-oct |");
    expect(text).toContain("Revisión pendiente");
  });
  it("lista y lee documentos de la carpeta", async () => {
    mkdirSync(path.join(docs, "OneNote"));
    writeFileSync(path.join(docs, "OneNote", "Seguimiento.html"), "<h2>Seguimiento</h2><ul><li>Llamar a Ana</li></ul>");
    writeFileSync(path.join(docs, "notas.txt"), "Notas sueltas");
    writeFileSync(path.join(docs, "foto.png"), "x");
    const { files } = await listDocuments();
    expect(files.map((f) => f.path).sort()).toEqual(["OneNote/Seguimiento.html", "notas.txt"]);
    expect((await readDocument("OneNote/Seguimiento.html")).text).toBe("Seguimiento\n- Llamar a Ana");
    await expect(readDocument("../etc/passwd")).rejects.toThrow();
    expect(htmlToText("a&nbsp;&amp;&nbsp;b")).toBe("a & b");
  });
});

describe.skipIf(!url)("importación y clasificación de correos", () => {
  beforeAll(async () => {
    await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate();
  });
  afterAll(async () => {
    await pool().end();
  });

  it("importa un .pst real, agrupa en hilos y no duplica al reimportar", async () => {
    const n = await importPst("buzon.pst", null);
    expect(n).toBeGreaterThan(50);
    expect(await one("SELECT status, emails FROM email_sources")).toEqual({ status: "importado", emails: n });
    expect(await importPst("buzon.pst", null)).toBe(0);
    const since = await importPst("buzon.pst", new Date("2030-01-01"));
    expect(since).toBe(0);
    const t = await one<{ thread_key: string }>("SELECT thread_key FROM emails GROUP BY thread_key ORDER BY count(*) DESC LIMIT 1");
    const th = await threadText(t!.thread_key);
    expect(th.text).toMatch(/^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} — De: /);
    await expect(importPst("../secreto.pst", null)).rejects.toThrow();
  });

  it("clasifica hilos por lotes, asigna los claros y deja sugerencias en los dudosos", async () => {
    const c = await one<{ id: string }>("INSERT INTO clients (name) VALUES ('Enron') RETURNING id");
    const p = await one<{ id: string }>("INSERT INTO projects (client_id, name) VALUES ($1, 'Capacidad gas') RETURNING id", [c!.id]);
    const pid = Number(p!.id);
    vi.mocked(askStructured).mockImplementation(async (_s, _sys, input) => {
      const user = String(input);
      const n = (user.match(/=== \[H\d+\]/g) ?? []).length;
      return {
        hilos: Array.from({ length: n }, (_, i) => ({
          hilo: `H${i + 1}`, resumen: "r", proyecto_nuevo: null,
          proyectos: i === 0 ? [{ proyecto_id: pid, confianza: "alta", motivo: "m", alcance: "" }]
            : i === 1 ? [{ proyecto_id: pid, confianza: "media", motivo: "m", alcance: "" }] : [],
        })),
      };
    });
    const done = await triageEmailThreads({ limit: 25, batchSize: 10 });
    expect(done).toBe(25);
    expect(askStructured).toHaveBeenCalledTimes(3); // 10 + 10 + 5
    const st = await query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM recording_triage GROUP BY status ORDER BY status");
    expect(st).toEqual([
      { status: "asignada", n: 3 }, { status: "dudosa", n: 3 }, { status: "sin_proyecto", n: 19 },
    ]);
    const m = await query<{ source: string; scope_note: string }>("SELECT source, scope_note FROM meetings");
    expect(m).toHaveLength(3);
    expect(m[0].source).toBe("correo");
    expect(m[0].scope_note).toContain("HILO DE CORREO");
    expect(processMeeting).toHaveBeenCalledTimes(3);
    // Una segunda pasada solo coge los hilos que quedan sin clasificar.
    vi.mocked(askStructured).mockClear();
    await triageEmailThreads({ limit: 5, batchSize: 10 });
    expect(vi.mocked(askStructured).mock.calls[0][2]).not.toContain("=== [H6]");
  });

  it("la revisión automática también analiza los documentos", async () => {
    vi.mocked(askStructured).mockReset().mockResolvedValue({ resumen: "doc", proyectos: [] });
    expect(await scanRecordings()).toBe(2);
    expect(await query("SELECT source_key, status FROM doc_plans ORDER BY source_key")).toEqual([
      { source_key: "doc:OneNote/Seguimiento.html", status: "lista" }, { source_key: "doc:notas.txt", status: "lista" },
    ]);
    expect(vi.mocked(askStructured).mock.calls[0][2]).toContain("DOCUMENTO");
  });
});
