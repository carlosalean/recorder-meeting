import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnalysisSchema, askStructured } from "./analysis";
import { extractJson } from "./deepseek";

// Servidor que imita /chat/completions de DeepSeek (streaming SSE).
let replies: { content: string; finish?: string; status?: number }[] = [];
const requests: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    requests.push({ headers: req.headers, body: JSON.parse(raw) });
    const r = replies.shift()!;
    if (r.status) {
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(r.content);
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < r.content.length; i += 7) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: r.content.slice(i, i + 7) }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: r.finish ?? "stop" }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});

const Schema = z.object({ resumen: z.string(), n: z.number().int().nullable() });

describe("DeepSeek", () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.AI_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    process.env.DEEPSEEK_MODEL = "modelo-x";
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  beforeEach(() => {
    replies = [];
    requests.length = 0;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(() => {
    delete process.env.AI_PROVIDER;
    server.close();
  });

  it("pide JSON con el esquema y valida la respuesta", async () => {
    replies.push({ content: '```json\n{"resumen": "ok", "n": 3}\n```' });
    expect(await askStructured(Schema, "Sistema", "Hola", { maxTokens: 64000 })).toEqual({ resumen: "ok", n: 3 });
    const { headers, body } = requests[0];
    expect(headers.authorization).toBe("Bearer sk-ds");
    expect(body).toMatchObject({ model: "modelo-x", stream: true, max_tokens: 32768, response_format: { type: "json_object" } });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0].content).toContain('"resumen"');
    expect(messages[1]).toEqual({ role: "user", content: "Hola" });
  });

  it("si el JSON no cumple el esquema, pide una corrección", async () => {
    replies.push({ content: '{"resumen": 5}' }, { content: '{"resumen": "bien", "n": null}' });
    expect(await askStructured(Schema, "S", "U")).toEqual({ resumen: "bien", n: null });
    expect((requests[1].body.messages as unknown[]).length).toBe(4);
  });

  it("errores claros: modelo inexistente, respuesta cortada, PDF escaneado sin Claude", async () => {
    replies.push({ status: 400, content: '{"error":{"message":"Model Not Exist"}}' });
    await expect(askStructured(Schema, "S", "U")).rejects.toThrow(/revisa DEEPSEEK_MODEL/);
    replies.push({ content: '{"resumen": "a', finish: "length" });
    await expect(askStructured(Schema, "S", "U")).rejects.toThrow(/cortó por longitud/);
    await expect(askStructured(Schema, "S", [{ type: "text", text: "pdf" }])).rejects.toThrow(/escaneado/);
  });

  it("el esquema del análisis de reuniones se puede convertir a JSON Schema", () => {
    expect(JSON.stringify(z.toJSONSchema(AnalysisSchema))).toContain("tareas_nuevas");
    expect(extractJson(' {"a":1} ')).toEqual({ a: 1 });
  });
});
