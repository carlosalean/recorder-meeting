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

const empty: Analysis = {
  resumen: "", resumen_proyecto: "", participantes: [],
  temas_nuevos: [], cambios_temas: [], tareas_nuevas: [], cambios_tareas: [],
};
const persona = (x: Partial<Analysis["participantes"][number]> & { nombre: string }) => ({
  persona_id: null, empresa: null, cargo: null, email: null, telefono: null, asistio: true,
  rol_en_proyecto: null, resumen_en_proyecto: "", perfil: null, ...x,
});

async function seed() {
  const c = await one<{ id: string }>("INSERT INTO clients (name) VALUES ('ACME') RETURNING id");
  const p = await one<{ id: string }>(
    "INSERT INTO projects (client_id, name) VALUES ($1, 'Web') RETURNING id", [c!.id]);
  const m = await one<{ id: string }>(
    "INSERT INTO meetings (project_id, title, transcript) VALUES ($1, 'Kickoff', 'hola') RETURNING id", [p!.id]);
  return { projectId: Number(p!.id), meetingId: Number(m!.id) };
}

beforeAll(async () => {
  if (!url) return;
  await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate();
  await migrate(); // idempotente
});
afterAll(async () => {
  if (url) await pool().end();
});

describe.skipIf(!url)("seguimiento de temas y tareas", () => {
  beforeEach(async () => {
    await query("TRUNCATE clients RESTART IDENTITY CASCADE");
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
    const changes = await query<{ entity: string }>("SELECT entity FROM changes WHERE meeting_id = $1", [meetingId]);
    // 2 temas + 2 tareas + la persona "Ana" (responsable nueva)
    expect(changes.map((c) => c.entity).sort()).toEqual(["persona", "tarea", "tarea", "tema", "tema"]);
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

describe.skipIf(!url)("personas", () => {
  beforeEach(async () => {
    await query("TRUNCATE clients, people RESTART IDENTITY CASCADE");
  });

  it("crea personas, las vincula al proyecto y a la reunión y asigna responsables", async () => {
    const { projectId, meetingId } = await seed();
    const res = await tx((db) => applyAnalysis(db, projectId, meetingId, {
      ...empty,
      resumen_proyecto: "Rediseño de la web corporativa de ACME.",
      participantes: [
        persona({ nombre: "Ana García", empresa: "ACME", cargo: "Product Owner", email: "ana@acme.com",
          rol_en_proyecto: "PO del cliente", resumen_en_proyecto: "Valida el diseño", perfil: "PO de ACME" }),
        persona({ nombre: "Luis", asistio: false, resumen_en_proyecto: "Gestiona el hosting" }),
      ],
      temas_nuevos: [{ clave: "N1", titulo: "Diseño", descripcion: "" }],
      tareas_nuevas: [
        // "ana" (nombre de pila, sin tilde ni mayúscula) debe resolverse a Ana García.
        { tema_id: null, tema_clave: "N1", titulo: "Validar mockups", descripcion: "", responsable: "ana",
          fecha_limite: null, estado: "pendiente", evidencia: "" },
        // Un responsable que no está en participantes se crea.
        { tema_id: null, tema_clave: "N1", titulo: "Textos", descripcion: "", responsable: "María",
          fecha_limite: null, estado: "pendiente", evidencia: "" },
      ],
    }));
    expect(res.newPeople).toBe(3);
    const people = await query<{ name: string; company: string; email: string; role: string; summary: string }>(
      `SELECT p.name, p.company, p.email, pp.role, pp.summary FROM people p
       JOIN project_people pp ON pp.person_id = p.id ORDER BY p.id`);
    expect(people).toEqual([
      { name: "Ana García", company: "ACME", email: "ana@acme.com", role: "PO del cliente", summary: "Valida el diseño" },
      { name: "Luis", company: null, email: null, role: null, summary: "Gestiona el hosting" },
      { name: "María", company: null, email: null, role: null, summary: null },
    ]);
    const attended = await query<{ name: string }>(
      "SELECT p.name FROM meeting_people mp JOIN people p ON p.id = mp.person_id WHERE mp.meeting_id = $1", [meetingId]);
    expect(attended.map((x) => x.name)).toEqual(["Ana García"]);
    const tasks = await query<{ title: string; owner: string; person: string }>(
      `SELECT k.title, k.owner, p.name AS person FROM tasks k JOIN people p ON p.id = k.owner_person_id ORDER BY k.id`);
    expect(tasks).toEqual([
      { title: "Validar mockups", owner: "Ana García", person: "Ana García" },
      { title: "Textos", owner: "María", person: "María" },
    ]);
    expect((await one<{ ai_summary: string }>("SELECT ai_summary FROM projects WHERE id=$1", [projectId]))!.ai_summary)
      .toBe("Rediseño de la web corporativa de ACME.");
  });

  it("reutiliza personas por ID sin pisar los datos escritos a mano", async () => {
    const { projectId, meetingId } = await seed();
    const p = await one<{ id: string }>(
      "INSERT INTO people (name, company, job_title) VALUES ('Ana García', 'ACME', 'CTO') RETURNING id");
    await tx((db) => applyAnalysis(db, projectId, meetingId, {
      ...empty,
      participantes: [persona({ persona_id: Number(p!.id), nombre: "Ana Garsia", cargo: "Product Owner",
        telefono: "600 000 000", resumen_en_proyecto: "Aprueba el presupuesto" })],
    }));
    expect(await query("SELECT name, job_title, phone FROM people")).toEqual([
      { name: "Ana García", job_title: "CTO", phone: "600 000 000" },
    ]);
    // El contexto de la IA incluye a la persona con su papel en el proyecto.
    const ctx = await loadProjectContext(projectId, pool());
    expect(ctx.people).toMatchObject([{ name: "Ana García", inProject: true, summary: "Aprueba el presupuesto" }]);
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
