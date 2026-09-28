"""Transcripción local con faster-whisper (el audio nunca sale de tu PC)."""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterable

DEFAULT_MODEL = "small"


def format_timestamp(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def format_segments(segments: Iterable) -> str:
    lines = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            lines.append(f"[{format_timestamp(seg.start)}] {text}")
    return "\n".join(lines) + "\n"


def transcribe(
    audio_path: Path,
    model_size: str = DEFAULT_MODEL,
    language: str | None = None,
    on_progress: Callable[[float, float], None] | None = None,
) -> str:
    """Devuelve la transcripción con marcas de tiempo ``[hh:mm:ss] texto``.

    ``language=None`` detecta el idioma automáticamente.
    ``on_progress(procesado_seg, total_seg)`` se llama tras cada segmento.
    """
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="auto", compute_type="default")
    segments, info = model.transcribe(
        str(audio_path),
        language=language,
        vad_filter=True,  # salta silencios: más rápido y menos alucinaciones
        beam_size=5,
    )

    def tracked():
        for seg in segments:
            if on_progress:
                on_progress(seg.end, info.duration)
            yield seg

    return format_segments(tracked())
