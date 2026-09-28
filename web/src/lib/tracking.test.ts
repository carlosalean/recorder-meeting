import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis } from "./analysis";

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;

vi.mock("./analysis", async (orig) => ({
  ...(await orig<typeof import("./analysis")>()),
  analyzeMeeting: vi.fn(),
}));

const { pool, query, one, tx } = await import("./db");
const { migrate } = await import("./migrations");
const { applyAnalysis, loadProjectContext, processMeeting } = await import("./tracking");
const { analyzeMeeting } = await import("./analysis");

const empty: Analysis = { resumen: "", temas_nuevos: [], cambios_temas: [], tareas_nuevas: [], cambios_tareas: [] };

async function seed() {
  const c = await one<{ id: string }>("INSERT INTO clients (name) VALUES ('ACME') RETURNING id");
  const p = await one<{ id: string }>(
    "INSERT INTO projects (client_id, name) VALUES ($1, 'Web') RETURNING id", [c!.id]);
  const m = await one<{ id: string }>(
    "INSERT INTO meetings (project_id, title, transcript) VALUES ($1, 'Kickoff', 'hola') RETURNING id", [p!.id]);
  return { projectId: Number(p!.id), meetingId: Number(m!.id) };
}

describe.skipIf(!url)("seguimiento de temas y tareas", () => {
  beforeAll(async () => {
    await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate();
    await migrate(); // idempotente
  });
  beforeEach(async () => {
    await query("TRUNCATE clients RESTART IDENTITY CASCADE");
  });
  afterAll(async () => {
    await pool().end();
  });

  it("crea temas y tareas nuevos y los registra en el historial", async () => {
    const { projectId, meetingId } = await seed();
    const res = await tx((db) => applyAnalysis(db, projectId, meetingId, {
      ...empty,
      temas_nuevos: [{ clave: "N1", titulo: "Diseño", descripcion: "Maquetas" }],
      tareas_nuevas: [
        { tema_id: null, tema_clave: "N1", titulo: "Hacer mockups", descripcion: "", responsable: "Ana",
          fecha_limite: "2026-10-03", estado: "pendiente", evidencia: "[00:01:00] Ana hace los mockups" },
        { tema_id: 999, tema_clave: null, titulo: "Sin tema", descripcion: "", responsable: null,
          fecha_limite: "el viernes", estado: "pendiente", evidencia: "" },
      ],
    }));
    expect(res).toMatchObject({ newTopics: 2, newTasks: 2 }); // "Diseño" + "General"
    const tasks = await query<{ title: string; owner: string; due: string; topic: string }>(
      `SELECT k.title, k.owner, to_char(k.due_date,'YYYY-MM-DD') AS due, t.title AS topic
       FROM tasks k JOIN topics t ON t.id = k.topic_id ORDER BY k.id`);
    expect(tasks).toEqual([
      { title: "Hacer mockups", owner: "Ana", due: "2026-10-03", topic: "Diseño" },
      { title: "Sin tema", owner: null, due: null, topic: "General" }, // fecha no válida → null
    ]);
    const changes = await query("SELECT * FROM changes WHERE meeting_id = $1", [meetingId]);
    expect(changes).toHaveLength(4);
  });

  it("actualiza estados, responsables y cierra temas en reuniones posteriores", async () => {
    const { projectId, meetingId } = await seed();
    await tx((db) => applyAnalysis(db, projectId, meetingId, {
      ...empty,
      temas_nuevos: [{ clave: "N1", titulo: "Diseño", descripcion: "" }],
      tareas_nuevas: [{ tema_id: null, tema_clave: "N1", titulo: "Mockups", descripcion: "", responsable: null,
        fecha_limite: null, estado: "pendiente", evidencia: "" }],
    }));
    const m2 = await one<{ id: string }>(
      "INSERT INTO meetings (project_id, title, transcript) VALUES ($1, 'Seguimiento', 'x') RETURNING id", [projectId]);
    const ctx = await loadProjectContext(projectId, pool());
    const topicId = ctx.topics[0].id;
    const taskId = ctx.topics[0].tasks[0].id;

    const res = await tx((db) => applyAnalysis(db, projectId, Number(m2!.id), {
      ...empty,
      cambios_tareas: [
        { tarea_id: taskId, estado: "completada", responsable: "Luis", fecha_limite: null,
          nota: "Entregados", evidencia: "[00:05:00] ya están los mockups" },
        { tarea_id: 12345, estado: "completada", responsable: null, fecha_limite: null, nota: "", evidencia: "" },
      ],
      cambios_temas: [{ tema_id: topicId, estado: "cerrado", nota: "Diseño aprobado" }],
    }));
    expect(res.statusChanges).toBe(2);

    const task = await one<{ status: string; owner: string; closed: boolean; last: string }>(
      "SELECT status, owner, closed_at IS NOT NULL AS closed, last_meeting_id AS last FROM tasks WHERE id=$1", [taskId]);
    expect(task).toEqual({ status: "completada", owner: "Luis", closed: true, last: m2!.id });
    const topic = await one<{ status: string }>("SELECT status FROM topics WHERE id=$1", [topicId]);
    expect(topic!.status).toBe("cerrado");

    // Una tarea nueva en un tema cerrado lo reabre.
    const m3 = await one<{ id: string }>(
      "INSERT INTO meetings (project_id, title, transcript) VALUES ($1, 'Otra', 'x') RETURNING id", [projectId]);
    await tx((db) => applyAnalysis(db, projectId, Number(m3!.id), {
      ...empty,
      tareas_nuevas: [{ tema_id: topicId, tema_clave: null, titulo: "Ajustar logo", descripcion: "",
        responsable: null, fecha_limite: null, estado: "pendiente", evidencia: "" }],
    }));
    expect((await one<{ status: string }>("SELECT status FROM topics WHERE id=$1", [topicId]))!.status).toBe("abierto");
  });

  it("processMeeting guarda el resumen o el error", async () => {
    const { meetingId } = await seed();
    vi.mocked(analyzeMeeting).mockResolvedValueOnce({ ...empty, resumen: "## Resumen" });
    await processMeeting(meetingId);
    expect(await one("SELECT status, ai_summary FROM meetings WHERE id=$1", [meetingId]))
      .toEqual({ status: "procesada", ai_summary: "## Resumen" });

    vi.mocked(analyzeMeeting).mockRejectedValueOnce(new Error("sin red"));
    await processMeeting(meetingId);
    expect(await one("SELECT status, error FROM meetings WHERE id=$1", [meetingId]))
      .toEqual({ status: "error", error: "sin red" });
  });
});

describe("normTaskStatus", () => {
  it("acepta variantes y rechaza valores desconocidos", async () => {
    const { normTaskStatus } = await import("./tracking");
    expect(normTaskStatus("En progreso")).toBe("en_progreso");
    expect(normTaskStatus("COMPLETADA")).toBe("completada");
    expect(normTaskStatus("hecho")).toBeNull();
  });
});
