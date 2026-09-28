"""Resumen de la reunión con Claude (API de Anthropic)."""

from __future__ import annotations

import os

import anthropic

DEFAULT_MODEL = os.environ.get("MEETING_RECORDER_MODEL", "claude-opus-5")

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
        system=SYSTEM_PROMPT.format(idioma=language, titulo=title),
        messages=[
            {
                "role": "user",
                "content": f"<transcripcion>\n{transcript}\n</transcripcion>",
            }
        ],
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
