import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Triage } from "./triage";

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.ANTHROPIC_API_KEY ||= "sk-test";

// Carpeta de grabaciones de prueba.
const dir = mkdtempSync(path.join(os.tmpdir(), "reuniones-"));
process.env.REUNIONES_DIR = dir;
for (const f of ["2026-09-21_09-00_kickoff", "2026-09-22_10-00_varios", "2026-09-23_11-00_dudosa"]) {
  mkdirSync(path.join(dir, f));
  writeFileSync(path.join(dir, f, "transcripcion.txt"), `[00:00:01] transcripción de ${f}`);
}

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
const { decide, scanRecordings, triageRecording } = await import("./triage");
const { askStructured } = await import("./analysis");
const { processMeeting } = await import("./tracking");

const triage = (proyectos: Triage["proyectos"]): Triage => ({ resumen: "Resumen", proyectos, proyecto_nuevo: null });
const p = (id: number, confianza: string, alcance = "") => ({ proyecto_id: id, confianza, motivo: "m", alcance });

describe("decide", () => {
  const ids = new Set(["1", "2", "3"]);
  it("asigna solo con confianza alta", () => {
    expect(decide(triage([p(1, "alta"), p(2, "media")]), ids)).toMatchObject({
      status: "asignada", assign: [{ project_id: "1" }],
    });
  });
  it("duda si no hay ninguna alta, e ignora IDs inventados", () => {
    const d = decide(triage([p(9, "alta"), p(2, "Media")]), ids);
    expect(d.status).toBe("dudosa");
    expect(d.suggestions).toEqual([{ project_id: "2", confidence: "media", reason: "m", scope: "" }]);
  });
  it("sin sugerencias → sin proyecto", () => {
    expect(decide(triage([]), ids).status).toBe("sin_proyecto");
  });
});

describe.skipIf(!url)("triageRecording", () => {
  let projects: string[] = [];
  beforeAll(async () => {
    await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate();
  });
  beforeEach(async () => {
    await query("TRUNCATE clients, recording_triage RESTART IDENTITY CASCADE");
    const c = await one<{ id: string }>("INSERT INTO clients (name) VALUES ('ACME') RETURNING id");
    projects = [];
    for (const n of ["Web", "App", "Datos"]) {
      projects.push((await one<{ id: string }>(
        "INSERT INTO projects (client_id, name) VALUES ($1, $2) RETURNING id", [c!.id, n]))!.id);
    }
    vi.mocked(processMeeting).mockClear();
  });
  afterAll(async () => {
    await pool().end();
  });

  it("asigna a varios proyectos con nota de alcance y los procesa", async () => {
    vi.mocked(askStructured).mockResolvedValueOnce(
      triage([p(Number(projects[0]), "alta", "rediseño de la home"), p(Number(projects[1]), "alta", "login"),
        p(Number(projects[2]), "baja")]));
    await triageRecording("2026-09-22_10-00_varios");

    const meetings = await query<{ project_id: string; scope_note: string; status: string }>(
      "SELECT project_id, scope_note, status FROM meetings ORDER BY project_id");
    expect(meetings.map((m) => m.project_id)).toEqual([projects[0], projects[1]]);
    expect(meetings[0].scope_note).toContain('SOLO de lo relativo a "Web": rediseño de la home');
    expect(meetings[0].scope_note).toContain('"App"');
    expect(processMeeting).toHaveBeenCalledTimes(2);
    expect(await one("SELECT status FROM recording_triage")).toEqual({ status: "asignada" });

    // El catálogo enviado a la IA incluye los proyectos.
    const user = vi.mocked(askStructured).mock.calls[0][2];
    expect(user).toContain(`[PR${projects[0]}] Web — cliente: ACME`);
  });

  it("si duda, guarda sugerencias sin crear reuniones", async () => {
    vi.mocked(askStructured).mockResolvedValueOnce(triage([p(Number(projects[2]), "media")]));
    await triageRecording("2026-09-23_11-00_dudosa");
    expect(await query("SELECT id FROM meetings")).toEqual([]);
    expect(await one("SELECT status, suggestions->0->>'confidence' AS c FROM recording_triage"))
      .toEqual({ status: "dudosa", c: "media" });
    expect(processMeeting).not.toHaveBeenCalled();
  });

  it("scanRecordings solo clasifica las grabaciones nuevas y guarda los errores", async () => {
    await query("INSERT INTO recording_triage (folder, status) VALUES ('2026-09-23_11-00_dudosa', 'dudosa')");
    vi.mocked(askStructured).mockReset()
      .mockResolvedValueOnce(triage([p(Number(projects[0]), "alta")]))
      .mockRejectedValueOnce(new Error("sin red"));
    expect(await scanRecordings()).toBe(2); // kickoff y varios; "dudosa" ya estaba clasificada
    expect(await query("SELECT folder, status, error FROM recording_triage ORDER BY folder")).toEqual([
      { folder: "2026-09-21_09-00_kickoff", status: "asignada", error: null },
      { folder: "2026-09-22_10-00_varios", status: "error", error: "sin red" },
      { folder: "2026-09-23_11-00_dudosa", status: "dudosa", error: null },
    ]);
    // Una segunda pasada no repite nada.
    expect(await scanRecordings()).toBe(0);
  });

  it("reintenta las que no encajaban cuando se crea un proyecto nuevo", async () => {
    await query(`INSERT INTO recording_triage (folder, status, updated_at) VALUES
      ('2026-09-21_09-00_kickoff', 'sin_proyecto', now() - interval '1 hour'),
      ('2026-09-22_10-00_varios', 'dudosa', now() - interval '1 hour'),
      ('2026-09-23_11-00_dudosa', 'sin_proyecto', now() + interval '1 hour')`);
    vi.mocked(askStructured).mockReset().mockResolvedValueOnce(triage([]));
    expect(await scanRecordings()).toBe(1); // solo kickoff: es anterior a la creación de los proyectos
  });

  it("sin proyectos no clasifica nada", async () => {
    await query("TRUNCATE clients RESTART IDENTITY CASCADE");
    vi.mocked(askStructured).mockReset();
    expect(await scanRecordings()).toBe(0);
    expect(askStructured).not.toHaveBeenCalled();
  });
});
