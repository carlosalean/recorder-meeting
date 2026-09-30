import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanResult } from "./docplan";

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.ANTHROPIC_API_KEY ||= "sk-test";

/** PDF mínimo con una página por texto (sin texto = página "escaneada"). */
function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const lines = text.split("\n").map((l, j) => `BT /F1 12 Tf 50 ${750 - j * 16} Td (${l}) Tj ET`).join("\n");
    const stream = text ? lines : "";
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> ` +
      `/Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const dir = mkdtempSync(path.join(os.tmpdir(), "documentos-"));
process.env.DOCUMENTOS_DIR = dir;
mkdirSync(path.join(dir, "OneNote"));
writeFileSync(path.join(dir, "OneNote", "Traspaso.pdf"), makePdf([
  "Estado de proyectos: AGB en produccion, NUEVO en arranque",
  "AGB: migracion a Kubernetes pendiente. Responsable: Ana Ruiz (DevOps)",
  "Portal Proveedores (cliente Lumen): kickoff el 15/10, Pedro Gil es el PO",
]));
writeFileSync(path.join(dir, "Escaneado.pdf"), makePdf(["", ""]));

vi.mock("./analysis", async (orig) => ({
  ...(await orig<typeof import("./analysis")>()),
  askStructured: vi.fn(),
}));
vi.mock("./tracking", async (orig) => ({
  ...(await orig<typeof import("./tracking")>()),
  processMeeting: vi.fn(async () => {}),
}));

const { query, one, pool } = await import("./db");
const { migrate } = await import("./migrations");
const { canAutoApply, normalizePlan, planText, runDocPlan, applyDocPlan } = await import("./docplan");
const { chunkText, joinPages, readDocumentPages, saveUploadedDocument } = await import("./documents");
const { scanRecordings } = await import("./triage");
const { askStructured } = await import("./analysis");
const { processMeeting } = await import("./tracking");

type Item = PlanResult["proyectos"][number];
const item = (x: Partial<Item>): Item => ({
  proyecto_id: null, nombre: "X", cliente_id: null, cliente_nombre: "C", descripcion: "d", paginas: [1],
  confianza: "alta", motivo: "m", ...x,
});

describe("utilidades de documentos", () => {
  it("parte textos largos por párrafos y une páginas con marcas", () => {
    const parts = chunkText(["a".repeat(3000), "b".repeat(3000), "c"].join("\n\n"), 4000);
    expect(parts).toHaveLength(2);
    expect(joinPages(["uno", "dos", "tres"], [1, 3])).toBe("=== Página 1 ===\nuno\n\n=== Página 3 ===\ntres");
    expect(joinPages(["solo"])).toBe("solo");
  });
  it("recorta cada página si el documento no cabe", () => {
    const t = planText(["x".repeat(1000), "y".repeat(1000)], 800);
    expect(t).toContain("=== Página 2 ===");
    expect(t.length).toBeLessThan(1000);
  });
});

describe("normalizePlan", () => {
  const catalog = {
    clients: [{ id: "1", name: "ACME" }, { id: "2", name: "Lumen" }],
    projects: [{ id: "10", name: "AGB", client_id: "1", client: "ACME", status: "activo", about: null }],
  };
  it("valida IDs, reconoce proyectos y clientes existentes por nombre y limita las páginas", () => {
    const items = normalizePlan({ resumen: "r", proyectos: [
      item({ proyecto_id: 10, nombre: "otro nombre", paginas: [1, 2, 9, 2] }),
      item({ proyecto_id: 99, nombre: "agb", cliente_nombre: "acme", paginas: [3] }), // inventado → existente
      item({ nombre: "Portal Proveedores", cliente_id: 77, cliente_nombre: "lumen", paginas: [], confianza: "Media" }),
      item({ nombre: "Nuevo", cliente_nombre: "Otra SA", confianza: "rarísima" }),
    ] }, catalog, 3);
    expect(items).toEqual([
      expect.objectContaining({ project_id: "10", name: "AGB", client_id: "1", pages: [1, 2, 3] }),
      expect.objectContaining({ project_id: null, name: "Portal Proveedores", client_id: "2", client_name: "Lumen",
        pages: [1, 2, 3], confidence: "media" }),
      expect.objectContaining({ project_id: null, client_id: null, client_name: "Otra SA", confidence: "baja" }),
    ]);
    expect(canAutoApply(items)).toBe(false);
    expect(canAutoApply(items.slice(0, 1))).toBe(true);
  });
});

describe.skipIf(!url)("importación de documentos", () => {
  let agb = "";
  beforeAll(async () => {
    await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate();
  });
  beforeEach(async () => {
    vi.mocked(askStructured).mockReset();
    vi.mocked(processMeeting).mockClear();
    await query("TRUNCATE clients, doc_plans, document_cache RESTART IDENTITY CASCADE");
    const c = await one<{ id: string }>("INSERT INTO clients (name) VALUES ('ACME') RETURNING id");
    agb = (await one<{ id: string }>(
      "INSERT INTO projects (client_id, name) VALUES ($1, 'AGB') RETURNING id", [c!.id]))!.id;
  });
  afterAll(async () => {
    await pool().end();
  });

  it("lee el PDF por páginas y lo guarda en caché", async () => {
    const d = await readDocumentPages("OneNote/Traspaso.pdf");
    expect(d.method).toBe("texto");
    expect(d.pages).toHaveLength(3);
    expect(d.pages[2]).toContain("Portal Proveedores");
    expect(await one("SELECT 1 FROM document_cache WHERE path = 'OneNote/Traspaso.pdf'")).toBeTruthy();
  });

  it("lee con IA los PDF escaneados (una sola vez)", async () => {
    vi.mocked(askStructured).mockResolvedValueOnce({ paginas: [
      { numero: 1, texto: "Acta escaneada" }, { numero: 2, texto: "Página 2 | tabla" }] });
    const d = await readDocumentPages("Escaneado.pdf");
    expect(d).toMatchObject({ method: "ia", pages: ["Acta escaneada", "Página 2 | tabla"] });
    const content = vi.mocked(askStructured).mock.calls[0][2] as { type: string }[];
    expect(content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    await readDocumentPages("Escaneado.pdf");
    expect(askStructured).toHaveBeenCalledTimes(1);
  });

  it("propone un proyecto nuevo: espera confirmación y al aplicarlo crea cliente, proyecto y reuniones por páginas", async () => {
    vi.mocked(askStructured).mockResolvedValueOnce({ resumen: "Traspaso", proyectos: [
      item({ proyecto_id: Number(agb), nombre: "AGB", paginas: [1, 2] }),
      item({ nombre: "Portal Proveedores", cliente_nombre: "Lumen", descripcion: "Portal para proveedores", paginas: [1, 3] }),
    ] });
    const key = "doc:OneNote/Traspaso.pdf";
    await runDocPlan(key);
    const row = await one<{ status: string; plan: { items: unknown[] } }>(
      "SELECT status, plan FROM doc_plans WHERE source_key = $1", [key]);
    expect(row!.status).toBe("lista");
    expect(row!.plan.items).toHaveLength(2);
    expect(await one("SELECT 1 FROM meetings")).toBeFalsy();
    const catalog = vi.mocked(askStructured).mock.calls[0][2] as string;
    expect(catalog).toContain(`[PR${agb}] AGB`);
    expect(catalog).toContain("=== Página 3 ===");

    const ids = await applyDocPlan(key, [{ index: 0 }, { index: 1, name: "Portal de Proveedores" }]);
    expect(ids).toHaveLength(2);
    const meetings = await query<{ project: string; client: string; transcript: string; description: string | null; source: string }>(
      `SELECT p.name AS project, c.name AS client, m.transcript, p.description, m.source
       FROM meetings m JOIN projects p ON p.id = m.project_id JOIN clients c ON c.id = p.client_id ORDER BY m.id`);
    expect(meetings.map((m) => [m.client, m.project, m.source])).toEqual([
      ["ACME", "AGB", "documento"], ["Lumen", "Portal de Proveedores", "documento"]]);
    expect(meetings[0].transcript).toContain("Kubernetes");
    expect(meetings[0].transcript).not.toContain("Pedro Gil");
    expect(meetings[1].transcript).toContain("Pedro Gil");
    expect(meetings[1].transcript).not.toContain("Kubernetes");
    expect(meetings[1].description).toBe("Portal para proveedores");
    expect((await one<{ status: string }>("SELECT status FROM doc_plans WHERE source_key = $1", [key]))!.status)
      .toBe("aplicada");
  });

  it("si todo va a proyectos existentes con seguridad, se incorpora solo (también al revisar la carpeta)", async () => {
    vi.mocked(askStructured).mockImplementation(async (schema, sys) => {
      if (sys.includes("transcriptor")) return { paginas: [{ numero: 1, texto: "x" }, { numero: 2, texto: "y" }] };
      return { resumen: "r", proyectos: [item({ proyecto_id: Number(agb), paginas: [2] })] };
    });
    const uploaded = await saveUploadedDocument("notas AGB.txt", Buffer.from("AGB: revisar backups"));
    expect(uploaded).toBe("Subidos/notas AGB.txt");
    expect(await saveUploadedDocument("notas AGB.txt", Buffer.from("otra"))).toBe("Subidos/notas AGB (2).txt");
    await expect(saveUploadedDocument("virus.exe", Buffer.from(""))).rejects.toThrow("Formato no admitido");

    expect(await scanRecordings()).toBe(4);
    const rows = await query<{ source_path: string }>("SELECT source_path FROM meetings ORDER BY source_path");
    expect(rows.map((r) => r.source_path)).toEqual([
      "doc:Escaneado.pdf", "doc:OneNote/Traspaso.pdf", "doc:Subidos/notas AGB (2).txt", "doc:Subidos/notas AGB.txt"]);
    expect(processMeeting).toHaveBeenCalledTimes(4);
    // Ya analizados: no se vuelven a enviar.
    expect(await scanRecordings()).toBe(0);
  });
});
