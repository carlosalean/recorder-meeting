import { z } from "zod";

/**
 * Proveedor alternativo: DeepSeek (API compatible con OpenAI, /chat/completions).
 * Se activa con AI_PROVIDER=deepseek. La salida estructurada se pide en modo JSON
 * con el esquema en el prompt y se valida con Zod; si no es válida, se pide una
 * corrección una vez.
 */

export class ProviderError extends Error {}

export const aiProvider = () => ((process.env.AI_PROVIDER || "claude").trim().toLowerCase() === "deepseek"
  ? "deepseek" : "claude");

type Msg = { role: "system" | "user" | "assistant"; content: string };

/** Quita un posible bloque ```json … ``` alrededor de la respuesta. */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(t);
}

/** Lee la respuesta en streaming (SSE) para no cortar por timeout en análisis largos. */
async function complete(messages: Msg[], maxTokens: number): Promise<{ content: string; finish: string | null }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new ProviderError("Falta DEEPSEEK_API_KEY en el archivo .env");
  const model = process.env.DEEPSEEK_MODEL;
  if (!model) throw new ProviderError("Falta DEEPSEEK_MODEL en el archivo .env (el ID exacto del modelo de DeepSeek)");
  const base = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model, messages, stream: true, max_tokens: maxTokens, response_format: { type: "json_object" },
    }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => "")).slice(0, 400);
    const hint = res.status === 401 ? " (revisa DEEPSEEK_API_KEY)"
      : /model/i.test(body) ? ` (revisa DEEPSEEK_MODEL: los modelos disponibles están en ${base}/models)` : "";
    throw new ProviderError(`DeepSeek respondió ${res.status}${hint}: ${body}`);
  }
  let content = "", finish: string | null = null, buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, "");
      if (!line.trim().startsWith("data:") || data === "[DONE]") continue;
      const ev = JSON.parse(data) as { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] };
      const c = ev.choices?.[0];
      if (c?.delta?.content) content += c.delta.content;
      if (c?.finish_reason) finish = c.finish_reason;
    }
  }
  return { content, finish };
}

export async function askDeepSeek<S extends z.ZodType>(
  schema: S, system: string, user: string, opts: { maxTokens?: number } = {},
): Promise<z.infer<S>> {
  const limit = Number(process.env.DEEPSEEK_MAX_TOKENS) || 32768;
  const maxTokens = Math.min(opts.maxTokens ?? limit, limit);
  const messages: Msg[] = [
    {
      role: "system",
      content: `${system}\n\nFORMATO DE RESPUESTA: responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ` +
        `ni bloques de código, que cumpla este JSON Schema (incluye todas las propiedades; usa null donde se ` +
        `permita si no hay dato):\n${JSON.stringify(z.toJSONSchema(schema))}`,
    },
    { role: "user", content: user },
  ];
  for (let attempt = 0; ; attempt++) {
    const { content, finish } = await complete(messages, maxTokens);
    if (finish === "length") {
      throw new ProviderError("La respuesta del modelo se cortó por longitud (sube DEEPSEEK_MAX_TOKENS si tu modelo lo permite).");
    }
    try {
      return schema.parse(extractJson(content));
    } catch (e) {
      const why = e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? e.message : String(e);
      if (attempt >= 1) throw new ProviderError(`El modelo no devolvió un resultado válido: ${why.slice(0, 300)}`);
      messages.push({ role: "assistant", content }, {
        role: "user",
        content: `Tu respuesta no cumple el formato pedido:\n${why}\nDevuelve de nuevo SOLO el objeto JSON corregido.`,
      });
    }
  }
}
