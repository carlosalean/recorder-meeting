import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisError, analyzeMeeting, renderContext, type ProjectContext } from "./analysis";
import { parseFolderName, safeResolve } from "./recordings";

process.env.ANTHROPIC_API_KEY ||= "sk-test";

const ctx: ProjectContext = {
  client: "ACME",
  project: "Web",
  description: null,
  topics: [{ id: 3, title: "Diseño", description: null, status: "abierto",
    tasks: [{ id: 7, title: "Mockups", owner: "Ana", due_date: null, status: "pendiente" }] }],
};

function fakeClient(message: object, calls: unknown[]) {
  return {
    beta: { messages: { stream: (params: unknown) => {
      calls.push(params);
      return { finalMessage: async () => message };
    } } },
  } as unknown as Anthropic;
}

describe("analyzeMeeting", () => {
  const meeting = { title: "Kickoff", date: "2026-09-28", transcript: "[00:00:01] hola" };

  it("envía el estado del proyecto y la transcripción y devuelve el resultado parseado", async () => {
    const calls: Record<string, unknown>[] = [];
    const parsed = { resumen: "ok", temas_nuevos: [], cambios_temas: [], tareas_nuevas: [], cambios_tareas: [] };
    const out = await analyzeMeeting(ctx, meeting,
      fakeClient({ stop_reason: "end_turn", parsed_output: parsed }, calls));
    expect(out).toEqual(parsed);
    const params = calls[0] as { messages: { content: string }[]; fallbacks: string; output_config: { format: unknown } };
    expect(params.messages[0].content).toContain("[T3] (abierto) Diseño");
    expect(params.messages[0].content).toContain("[#7] (pendiente) Mockups");
    expect(params.messages[0].content).toContain("[00:00:01] hola");
    expect(params.fallbacks).toBe("default");
    expect(params.output_config.format).toBeTruthy();
  });

  it("lanza un error claro si el modelo rechaza la petición", async () => {
    await expect(analyzeMeeting(ctx, meeting, fakeClient({ stop_reason: "refusal", content: [] }, [])))
      .rejects.toBeInstanceOf(AnalysisError);
  });
});

describe("utilidades", () => {
  it("renderContext indica cuando no hay temas", () => {
    expect(renderContext({ ...ctx, topics: [] })).toContain("primera reunión");
  });

  it("parseFolderName interpreta las carpetas de la grabadora", () => {
    const r = parseFolderName("2026-09-28_10-21_reunion-inicial");
    expect(r.title).toBe("Reunion inicial");
    expect(r.date?.getHours()).toBe(10);
    expect(parseFolderName("otra-cosa")).toEqual({ date: null, title: "otra-cosa" });
  });

  it("safeResolve impide salir de la carpeta de grabaciones", () => {
    process.env.REUNIONES_DIR = "/reuniones";
    expect(safeResolve("2026-09-28_10-21/reunion.flac")).toBe("/reuniones/2026-09-28_10-21/reunion.flac");
    expect(() => safeResolve("../etc/passwd")).toThrow();
  });
});
