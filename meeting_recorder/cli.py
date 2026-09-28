"""Interfaz de línea de comandos: ``meeting-recorder <comando>``."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import audio
from . import summarize as summ
from .pipeline import SUMMARY_FILE, Settings, new_meeting_dir, process


def _add_processing_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--modelo-whisper", default=Settings.whisper_model,
                   help="tiny, base, small, medium, large-v3, turbo… (defecto: %(default)s)")
    p.add_argument("--idioma-audio", default=None,
                   help="Código del idioma hablado, p. ej. 'es' (defecto: autodetectar)")
    p.add_argument("--idioma-resumen", default=Settings.summary_language,
                   help="Idioma del resumen (defecto: %(default)s)")
    p.add_argument("--modelo-ia", default=Settings.ai_model,
                   help="Modelo de Claude para el resumen (defecto: %(default)s)")


def _settings(args: argparse.Namespace) -> Settings:
    return Settings(args.modelo_whisper, args.idioma_audio, args.idioma_resumen, args.modelo_ia)


def cmd_record(args: argparse.Namespace) -> int:
    folder = new_meeting_dir(args.titulo, Path(args.carpeta) if args.carpeta else None)
    rec = audio.Recorder(folder, mic_name=args.mic, speaker_name=args.altavoz,
                         use_mic=not args.sin_microfono)
    rec.start()
    print(f"● Grabando en {folder}\n  Pulsa Ctrl+C para terminar la reunión.")
    try:
        while True:
            time.sleep(1)
            print(f"\r  Duración: {int(rec.elapsed // 60):02d}:{int(rec.elapsed % 60):02d}",
                  end="", flush=True)
    except KeyboardInterrupt:
        print("\n■ Deteniendo…")
    audio_path = rec.stop()
    print(f"Audio guardado en {audio_path}")
    if args.no_procesar:
        return 0
    return _run_process(audio_path, args)


def _run_process(path: Path, args: argparse.Namespace) -> int:
    try:
        _, summary = process(path, _settings(args), title=getattr(args, "titulo", None))
    except summ.SummaryError as e:
        print(f"Error al resumir: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # p. ej. falta ANTHROPIC_API_KEY o no hay red
        print(f"Error: {e}\nPuedes reintentar con: meeting-recorder procesar \"{path}\"",
              file=sys.stderr)
        return 1
    if summary:
        print("\n" + summary.read_text(encoding="utf-8"))
    return 0


def cmd_process(args: argparse.Namespace) -> int:
    return _run_process(Path(args.ruta), args)


def cmd_summarize(args: argparse.Namespace) -> int:
    path = Path(args.transcripcion)
    text = summ.summarize(path.read_text(encoding="utf-8"), language=args.idioma_resumen,
                          model=args.modelo_ia)
    out = path.parent / SUMMARY_FILE
    out.write_text(text, encoding="utf-8")
    print(text)
    print(f"Guardado en {out}")
    return 0


def cmd_devices(_: argparse.Namespace) -> int:
    for group, names in audio.list_devices().items():
        print(f"{group}:")
        for n in names:
            print(f"  - {n}")
    return 0


def cmd_gui(_: argparse.Namespace) -> int:
    from .gui import main

    main()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="meeting-recorder",
        description="Graba reuniones de cualquier aplicación, las transcribe y las resume con IA.",
    )
    sub = parser.add_subparsers(dest="cmd")

    p = sub.add_parser("grabar", help="Grabar una reunión (Ctrl+C para terminar)")
    p.add_argument("-t", "--titulo", help="Título de la reunión")
    p.add_argument("--carpeta", help="Carpeta raíz donde guardar (defecto: ~/Reuniones)")
    p.add_argument("--mic", help="Nombre (o parte) del micrófono a usar")
    p.add_argument("--altavoz", help="Nombre (o parte) de la salida de audio a capturar")
    p.add_argument("--sin-microfono", action="store_true", help="Grabar solo el audio del sistema")
    p.add_argument("--no-procesar", action="store_true", help="Solo grabar, sin transcribir/resumir")
    _add_processing_args(p)
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("procesar", help="Transcribir y resumir un audio o carpeta de reunión")
    p.add_argument("ruta")
    p.add_argument("-t", "--titulo")
    _add_processing_args(p)
    p.set_defaults(func=cmd_process)

    p = sub.add_parser("resumir", help="Resumir una transcripción de texto ya existente")
    p.add_argument("transcripcion")
    _add_processing_args(p)
    p.set_defaults(func=cmd_summarize)

    sub.add_parser("dispositivos", help="Listar micrófonos y salidas de audio").set_defaults(
        func=cmd_devices)
    sub.add_parser("gui", help="Abrir la ventana gráfica").set_defaults(func=cmd_gui)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not getattr(args, "func", None):
        return cmd_gui(args)  # sin argumentos: abrir la interfaz gráfica
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
