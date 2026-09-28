"""Une grabación → transcripción → resumen y organiza los archivos."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from . import summarize as summ
from . import transcribe as trans

AUDIO_EXTENSIONS = {".flac", ".wav", ".mp3", ".m4a", ".ogg", ".mp4", ".mkv", ".webm"}
TRANSCRIPT_FILE = "transcripcion.txt"
SUMMARY_FILE = "resumen.md"


def meetings_root() -> Path:
    return Path(os.environ.get("MEETING_RECORDER_DIR", Path.home() / "Reuniones"))


def new_meeting_dir(title: str | None = None, root: Path | None = None) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
    slug = re.sub(r"[^\w-]+", "-", title.strip().lower()).strip("-") if title else ""
    name = f"{stamp}_{slug}" if slug else stamp
    return (root or meetings_root()) / name


@dataclass
class Settings:
    whisper_model: str = trans.DEFAULT_MODEL
    audio_language: str | None = None
    summary_language: str = "español"
    ai_model: str = summ.DEFAULT_MODEL


def find_audio(meeting_dir: Path) -> Path:
    candidates = sorted(
        p for p in meeting_dir.iterdir()
        if p.suffix.lower() in AUDIO_EXTENSIONS and not p.name.startswith("_")
    )
    if not candidates:
        raise FileNotFoundError(f"No hay ningún audio en {meeting_dir}")
    return candidates[0]


def process(
    path: Path,
    settings: Settings,
    title: str | None = None,
    log: Callable[[str], None] = print,
) -> tuple[Path, Path | None]:
    """Transcribe y resume ``path`` (un audio o una carpeta de reunión).

    Los resultados se guardan junto al audio. Si la transcripción ya existe
    se reutiliza, así que reintentar un resumen fallido no vuelve a transcribir.
    """
    path = path.expanduser().resolve()
    audio = find_audio(path) if path.is_dir() else path
    folder = audio.parent
    title = title or f"Reunión {folder.name}"

    transcript_path = folder / TRANSCRIPT_FILE
    if transcript_path.exists():
        log(f"Usando transcripción existente: {transcript_path}")
        transcript = transcript_path.read_text(encoding="utf-8")
    else:
        log(f"Transcribiendo {audio.name} con Whisper '{settings.whisper_model}'…")
        last = [-10.0]

        def progress(done: float, total: float) -> None:
            if done - last[0] >= 30 or done >= total:
                last[0] = done
                log(f"  {trans.format_timestamp(done)} / {trans.format_timestamp(total)}")

        transcript = trans.transcribe(
            audio, settings.whisper_model, settings.audio_language, progress
        )
        transcript_path.write_text(transcript, encoding="utf-8")
        log(f"Transcripción guardada en {transcript_path}")

    if not transcript.strip():
        log("La transcripción está vacía (¿se grabó audio?). No se genera resumen.")
        return transcript_path, None

    log(f"Generando resumen con {settings.ai_model}…")
    summary = summ.summarize(
        transcript, title=title, language=settings.summary_language, model=settings.ai_model
    )
    summary_path = folder / SUMMARY_FILE
    summary_path.write_text(summary, encoding="utf-8")
    log(f"Resumen guardado en {summary_path}")
    return transcript_path, summary_path
