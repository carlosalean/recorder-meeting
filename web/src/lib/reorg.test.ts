import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Proposal } from "./reorg";

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;

const { query, one, pool } = await import("./db");
const { migrate } = await import("./migrations");
const { applyProposal, validateProposals } = await import("./reorg");

const base: Proposal = {
  tipo: "", tema_id: null, tarea_id: null, reunion_id: null, temas_ids: [], proyecto_origen_id: null,
  proyecto_destino_id: null, tema_destino_id: null, nuevo_titulo: null, motivo: "porque sí",
};

describe("validateProposals", () => {
  const catalog = {
    projects: [{ id: "1" }, { id: "2" }],
    topics: [{ id: "10", project_id: "1" }, { id: "11", project_id: "1" }],
    tasks: [{ id: "100", topic_id: "10" }],
    meetings: [{ id: "50", project_id: "1" }],
  } as never;
  it("descarta IDs inexistentes, no-cambios y tipos desconocidos", () => {
    const ok = validateProposals([
      { ...base, tipo: "MOVER_TEMA", tema_id: 10, proyecto_destino_id: 2 },   // válida (tipo normalizado)
      { ...base, tipo: "mover_tema", tema_id: 10, proyecto_destino_id: 1 },   // ya está ahí
      { ...base, tipo: "mover_tema", tema_id: 99, proyecto_destino_id: 2 },   // tema inexistente
      { ...base, tipo: "mover_tarea", tarea_id: 100, proyecto_destino_id: 2, nuevo_titulo: "Nuevo" },
      { ...base, tipo: "mover_tarea", tarea_id: 100, proyecto_destino_id: 2 }, // falta título
      { ...base, tipo: "fusionar_temas", temas_ids: [10, 10] },               // un solo tema
      { ...base, tipo: "fusionar_proyectos", proyecto_origen_id: 2, proyecto_destino_id: 1 },
      { ...base, tipo: "borrar_todo" },
    ], catalog);
    expect(ok.map((p) => p.tipo)).toEqual(["mover_tema", "mover_tarea", "fusionar_proyectos"]);
  });
});

describe.skipIf(!url)("applyProposal", () => {
  let web: number, app: number, tDesign: number, tLogin: number, tDup: number, task: number, meeting: number;

  beforeAll(async () => {
    await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate();
  });
  beforeEach(async () => {
    await query("TRUNCATE clients, people, reorg_runs RESTART IDENTITY CASCADE");
    const c = await one<{ id: string }>("INSERT INTO clients (name) VALUES ('ACME') RETURNING id");
    web = Number((await one<{ id: string }>("INSERT INTO projects (client_id, name) VALUES ($1,'Web') RETURNING id", [c!.id]))!.id);
    app = Number((await one<{ id: string }>("INSERT INTO projects (client_id, name) VALUES ($1,'App') RETURNING id", [c!.id]))!.id);
    tDesign = Number((await one<{ id: string }>("INSERT INTO topics (project_id, title) VALUES ($1,'Diseño') RETURNING id", [web]))!.id);
    tLogin = Number((await one<{ id: string }>("INSERT INTO topics (project_id, title) VALUES ($1,'Login app') RETURNING id", [web]))!.id);
    tDup = Number((await one<{ id: string }>("INSERT INTO topics (project_id, title, status) VALUES ($1,'Diseño UI','cerrado') RETURNING id", [web]))!.id);
    const person = await one<{ id: string }>("INSERT INTO people (name) VALUES ('Ana') RETURNING id");
    task = Number((await one<{ id: string }>(
      "INSERT INTO tasks (topic_id, title, owner_person_id) VALUES ($1,'Pantalla SSO',$2) RETURNING id", [tLogin, person!.id]))!.id);
    await query("INSERT INTO tasks (topic_id, title) VALUES ($1,'Paleta de colores')", [tDup]);
    meeting = Number((await one<{ id: string }>(
      "INSERT INTO meetings (project_id, title, transcript) VALUES ($1,'Daily app','x') RETURNING id", [web]))!.id);
    await query("INSERT INTO reorg_runs (status) VALUES ('lista')");
  });
  afterAll(async () => {
    await pool().end();
  });

  const propose = async (p: Partial<Proposal> & { tipo: string }) => {
    const r = await one<{ id: string }>(
      "INSERT INTO reorg_proposals (run_id, kind, payload, reason) VALUES (1, $1, $2, 'motivo') RETURNING id",
      [p.tipo, JSON.stringify({ ...base, ...p })]);
    await applyProposal(Number(r!.id));
    return one<{ status: string; error: string | null }>("SELECT status, error FROM reorg_proposals WHERE id=$1", [r!.id]);
  };

  it("mueve un tema con sus tareas y vincula a los responsables al proyecto nuevo", async () => {
    expect(await propose({ tipo: "mover_tema", tema_id: tLogin, proyecto_destino_id: app }))
      .toEqual({ status: "aplicada", error: null });
    expect(await one("SELECT project_id FROM topics WHERE id=$1", [tLogin])).toEqual({ project_id: String(app) });
    expect(await one("SELECT count(*)::int AS n FROM project_people WHERE project_id=$1", [app])).toEqual({ n: 1 });
    const log = await query<{ project_id: string; action: string }>(
      "SELECT project_id, action FROM changes WHERE entity='tema' ORDER BY project_id");
    expect(log).toEqual([{ project_id: String(web), action: "movido" }, { project_id: String(app), action: "movido" }]);
  });

  it("mueve una tarea a un tema nuevo de otro proyecto", async () => {
    await propose({ tipo: "mover_tarea", tarea_id: task, proyecto_destino_id: app, nuevo_titulo: "Autenticación" });
    expect(await one(
      "SELECT t.title, t.project_id FROM tasks k JOIN topics t ON t.id = k.topic_id WHERE k.id=$1", [task]))
      .toEqual({ title: "Autenticación", project_id: String(app) });
  });

  it("mueve una reunión y fusiona temas duplicados (reabriendo si hay tareas pendientes)", async () => {
    await propose({ tipo: "mover_reunion", reunion_id: meeting, proyecto_destino_id: app });
    expect(await one("SELECT project_id FROM meetings WHERE id=$1", [meeting])).toEqual({ project_id: String(app) });

    await propose({ tipo: "fusionar_temas", temas_ids: [tDesign, tDup], nuevo_titulo: "Diseño y UI" });
    expect(await query("SELECT title, status FROM topics WHERE project_id=$1 ORDER BY id", [web]))
      .toEqual([{ title: "Diseño y UI", status: "abierto" }, { title: "Login app", status: "abierto" }]);
    expect(await one("SELECT count(*)::int AS n FROM tasks WHERE topic_id=$1", [tDesign])).toEqual({ n: 1 });
  });

  it("fusiona proyectos y marca como error lo que ya no se puede aplicar", async () => {
    expect((await propose({ tipo: "fusionar_proyectos", proyecto_origen_id: app, proyecto_destino_id: web }))!.status)
      .toBe("aplicada");
    expect(await query("SELECT name FROM projects")).toEqual([{ name: "Web" }]);
    // Propuesta sobre un proyecto que ya no existe → error, sin romper nada.
    const r = await propose({ tipo: "mover_tema", tema_id: tLogin, proyecto_destino_id: app });
    expect(r!.status).toBe("error");
    expect(await one("SELECT project_id FROM topics WHERE id=$1", [tLogin])).toEqual({ project_id: String(web) });
  });
});
