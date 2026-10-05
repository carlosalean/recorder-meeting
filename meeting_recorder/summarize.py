"""Resumen de la reunión con Claude (API de Anthropic) o, con AI_PROVIDER=deepseek, con DeepSeek."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import anthropic


def provider() -> str:
    """Proveedor de IA: ``claude`` (por defecto) o ``deepseek`` (variable AI_PROVIDER)."""
    return "deepseek" if os.environ.get("AI_PROVIDER", "").strip().lower() == "deepseek" else "claude"


DEFAULT_MODEL = (
    os.environ.get("DEEPSEEK_MODEL", "")
    if provider() == "deepseek"
    else os.environ.get("MEETING_RECORDER_MODEL", "claude-opus-5")
)

SYSTEM_PROMPT = """\
Eres un asistente experto en analizar reuniones de trabajo. Recibirás la \
transcripción automática de una reunión (con marcas de tiempo [hh:mm:ss]). \
La transcripción puede tener errores de reconocimiento de voz y no indica \
quién habla: deduce los participantes por el contexto (nombres mencionados, \
presentaciones, "yo me encargo", etc.) y, si no puedes saberlo, no lo inventes.

Redacta un informe en {idioma}, en Markdown, con exactamente estas secciones:

# {titulo}

## Resumen ejecutivo
3-6 frases con el propósito de la reunión y sus conclusiones principales.

## Temas tratados
Lista de los temas relevantes, cada uno con 1-3 viñetas de detalle.

## Decisiones tomadas
Solo decisiones explícitas o claramente acordadas. Si no hay, escribe "Ninguna registrada".

## Tareas y puntos pendientes
Tabla Markdown con columnas: Tarea | Responsable | Fecha límite | Referencia.
Usa "Sin asignar" / "Sin fecha" cuando no se mencione. En Referencia pon la \
marca de tiempo donde se habló de ello.

## Preguntas abiertas y riesgos
Asuntos sin resolver, dudas, bloqueos o riesgos mencionados.

## Próximos pasos
Siguiente reunión, entregables o hitos acordados, si se mencionan.

Sé conciso y concreto. Prioriza lo accionable. Ignora charla trivial \
(saludos, problemas de audio, etc.)."""


class SummaryError(RuntimeError):
    pass


def make_client() -> anthropic.Anthropic:
    """Cliente de Anthropic. Si la clave no está asociada a un workspace, la
    API exige indicarlo: se toma de ``ANTHROPIC_WORKSPACE_ID``."""
    workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID")
    headers = {"anthropic-workspace-id": workspace} if workspace else None
    return anthropic.Anthropic(default_headers=headers)


def summarize(
    transcript: str,
    title: str = "Resumen de la reunión",
    language: str = "español",
    model: str = DEFAULT_MODEL,
    client: anthropic.Anthropic | None = None,
) -> str:
    """Genera el informe en Markdown a partir de la transcripción."""
    if not transcript.strip():
        raise SummaryError("La transcripción está vacía: no hay nada que resumir.")

    system = SYSTEM_PROMPT.format(idioma=language, titulo=title)
    user = f"<transcripcion>\n{transcript}\n</transcripcion>"
    if client is None and provider() == "deepseek":
        return _summarize_deepseek(system, user, model)

    client = client or make_client()
    # Streaming: las reuniones largas generan entradas grandes y evita timeouts.
    with client.beta.messages.stream(
        model=model,
        max_tokens=32000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        # Si el filtro de seguridad rechazara la petición (falso positivo),
        # la API la reintenta automáticamente con otro modelo.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=system,
        messages=[{"role": "user", "content": user}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        raise SummaryError("El modelo rechazó procesar esta transcripción.")

    text = "".join(b.text for b in message.content if b.type == "text").strip()
    if not text:
        raise SummaryError(f"Respuesta vacía del modelo (stop_reason={message.stop_reason}).")
    if message.stop_reason == "max_tokens":
        text += "\n\n> ⚠️ El resumen se cortó por longitud."
    return text + "\n"


def _summarize_deepseek(system: str, user: str, model: str) -> str:
    """Resumen con DeepSeek (API compatible con OpenAI), en streaming para evitar timeouts."""
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise SummaryError("Falta la variable de entorno DEEPSEEK_API_KEY.")
    model = model or os.environ.get("DEEPSEEK_MODEL", "")
    if not model:
        raise SummaryError("Falta la variable de entorno DEEPSEEK_MODEL (el ID del modelo de DeepSeek).")
    base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    body = {
        "model": model,
        "stream": True,
        "max_tokens": int(os.environ.get("DEEPSEEK_MAX_TOKENS") or 32768),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    parts: list[str] = []
    finish = None
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            for raw in resp:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data:") or line == "data: [DONE]":
                    continue
                choice = (json.loads(line[5:]).get("choices") or [{}])[0]
                parts.append((choice.get("delta") or {}).get("content") or "")
                finish = choice.get("finish_reason") or finish
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise SummaryError(f"DeepSeek respondió {e.code}: {detail}") from e

    text = "".join(parts).strip()
    if not text:
        raise SummaryError(f"Respuesta vacía del modelo (finish_reason={finish}).")
    if finish == "length":
        text += "\n\n> ⚠️ El resumen se cortó por longitud."
    return text + "\n"
