"""Ventana sencilla (tkinter) para grabar con un clic."""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, scrolledtext, ttk

from . import audio
from .pipeline import Settings, new_meeting_dir, process


def _open_folder(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.recorder: audio.Recorder | None = None
        self.folder: Path | None = None
        self.worker: threading.Thread | None = None
        self.events: queue.Queue[tuple[str, str]] = queue.Queue()

        root.title("Grabador de reuniones")
        root.geometry("760x600")
        root.minsize(520, 420)
        frm = ttk.Frame(root, padding=12)
        frm.pack(fill="both", expand=True)

        top = ttk.Frame(frm)
        top.pack(fill="x")
        ttk.Label(top, text="Título:").pack(side="left")
        self.title_var = tk.StringVar()
        ttk.Entry(top, textvariable=self.title_var).pack(side="left", fill="x", expand=True, padx=6)
        self.mic_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(top, text="Incluir mi micrófono", variable=self.mic_var).pack(side="left")

        ctl = ttk.Frame(frm)
        ctl.pack(fill="x", pady=10)
        self.button = ttk.Button(ctl, text="● Empezar a grabar", command=self.toggle)
        self.button.pack(side="left")
        self.open_btn = ttk.Button(ctl, text="Abrir carpeta", state="disabled",
                                   command=lambda: self.folder and _open_folder(self.folder))
        self.open_btn.pack(side="left", padx=6)
        self.status = tk.StringVar(value="Listo")
        ttk.Label(ctl, textvariable=self.status, font=("", 11, "bold")).pack(side="right")

        self.output = scrolledtext.ScrolledText(frm, wrap="word", font=("Consolas", 10))
        self.output.pack(fill="both", expand=True)
        self._write(
            "Pulsa «Empezar a grabar» cuando comience tu reunión (Meet, Teams, Zoom…).\n"
            "Se grabará lo que suena en tu PC y tu micrófono. Al detener, se transcribirá\n"
            "localmente y Claude generará el resumen con los puntos pendientes.\n\n"
            "Recuerda avisar a los participantes de que la reunión se está grabando.\n"
        )
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(200, self._poll)

    def _write(self, text: str, replace: bool = False) -> None:
        if replace:
            self.output.delete("1.0", "end")
        self.output.insert("end", text)
        self.output.see("end")

    def toggle(self) -> None:
        if self.recorder is None:
            self.start()
        else:
            self.stop()

    def start(self) -> None:
        self.folder = new_meeting_dir(self.title_var.get() or None)
        self.recorder = audio.Recorder(self.folder, use_mic=self.mic_var.get())
        try:
            self.recorder.start()
        except Exception as e:
            self.recorder = None
            self._write(f"\nNo se pudo iniciar la grabación: {e}\n")
            return
        self.button.configure(text="■ Detener y resumir")
        self.open_btn.configure(state="normal")
        self._write(f"● Grabando en {self.folder}\n", replace=True)
        self._tick()

    def _tick(self) -> None:
        if self.recorder:
            s = int(self.recorder.elapsed)
            self.status.set(f"● Grabando {s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}")
            self.root.after(500, self._tick)

    def stop(self) -> None:
        rec, self.recorder = self.recorder, None
        self.button.configure(state="disabled", text="Procesando…")
        self.status.set("Procesando…")
        title = self.title_var.get() or None
        self.worker = threading.Thread(target=self._finish, args=(rec, title), daemon=True)
        self.worker.start()

    def _finish(self, rec: audio.Recorder, title: str | None) -> None:
        log = lambda msg: self.events.put(("log", msg + "\n"))  # noqa: E731
        try:
            audio_path = rec.stop()
            log(f"Audio guardado en {audio_path}")
            _, summary = process(audio_path, Settings(), title=title, log=log)
            if summary:
                self.events.put(("summary", summary.read_text(encoding="utf-8")))
            self.events.put(("done", "Listo"))
        except Exception as e:
            log(f"\nError: {e}\nEl audio se conserva; puedes reintentar con:\n"
                f"  meeting-recorder procesar \"{rec.output_dir}\"")
            self.events.put(("done", "Error"))

    def _poll(self) -> None:
        while not self.events.empty():
            kind, payload = self.events.get()
            if kind == "log":
                self._write(payload)
            elif kind == "summary":
                self._write(payload, replace=True)
            elif kind == "done":
                self.status.set(payload)
                self.button.configure(state="normal", text="● Empezar a grabar")
        self.root.after(200, self._poll)

    def on_close(self) -> None:
        if self.recorder is not None:
            self.recorder.stop()  # guarda el audio antes de salir
            self.recorder = None
        elif self.worker and self.worker.is_alive() and not messagebox.askyesno(
            "Procesando",
            "Aún se está transcribiendo/resumiendo. ¿Salir igualmente?\n"
            "El audio queda guardado y podrás procesarlo después.",
        ):
            return
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
