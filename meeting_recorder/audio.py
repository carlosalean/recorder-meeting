"""Captura simultánea del audio del sistema (loopback) y del micrófono.

Grabar el *loopback* del altavoz es lo que permite capturar cualquier
aplicación de reuniones (Meet, Teams, Zoom, TeamViewer, Discord...): se graba
lo que suena por los altavoces/auriculares más lo que dices por el micrófono.

- Windows: WASAPI loopback (funciona sin instalar nada extra).
- Linux: monitor de PulseAudio/PipeWire.
- macOS: requiere un dispositivo virtual como BlackHole (ver README).
"""

from __future__ import annotations

import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 16_000  # Whisper trabaja a 16 kHz; grabar así ahorra disco.
BLOCK_SECONDS = 0.5
# Desfase máximo tolerado entre el reloj real y las muestras escritas.
MAX_DRIFT_SECONDS = 0.25


def _init_com_for_thread() -> None:
    """soundcard solo inicializa COM en el hilo principal; en Windows cada
    hilo de captura necesita hacerlo por su cuenta."""
    if sys.platform == "win32":
        import ctypes

        ctypes.windll.ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED


def list_devices() -> dict[str, list[str]]:
    import soundcard as sc

    return {
        "microfonos": [m.name for m in sc.all_microphones(include_loopback=False)],
        "altavoces": [s.name for s in sc.all_speakers()],
        "microfono_por_defecto": [sc.default_microphone().name],
        "altavoz_por_defecto": [sc.default_speaker().name],
    }


def _get_sources(mic_name: str | None, speaker_name: str | None, use_mic: bool):
    import soundcard as sc

    speaker = sc.get_speaker(speaker_name) if speaker_name else sc.default_speaker()
    loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    sources = {"sistema": loopback}
    if use_mic:
        sources["microfono"] = (
            sc.get_microphone(mic_name) if mic_name else sc.default_microphone()
        )
    return sources


@dataclass
class _Track:
    name: str
    path: Path
    frames_written: int = 0
    error: BaseException | None = None


@dataclass
class Recorder:
    """Graba en segundo plano hasta que se llama a :meth:`stop`.

    Cada fuente se escribe incrementalmente en su propio WAV (no se acumula
    en memoria, así que sirve para reuniones largas) y al parar se mezclan
    en un único archivo.
    """

    output_dir: Path
    mic_name: str | None = None
    speaker_name: str | None = None
    use_mic: bool = True
    samplerate: int = SAMPLE_RATE
    _stop: threading.Event = field(default_factory=threading.Event, init=False)
    _threads: list[threading.Thread] = field(default_factory=list, init=False)
    _tracks: list[_Track] = field(default_factory=list, init=False)
    _started_at: float = field(default=0.0, init=False)

    def start(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        sources = _get_sources(self.mic_name, self.speaker_name, self.use_mic)
        self._stop.clear()
        self._started_at = time.monotonic()
        for name, device in sources.items():
            track = _Track(name, self.output_dir / f"_{name}.wav")
            self._tracks.append(track)
            t = threading.Thread(
                target=self._capture, args=(device, track), name=f"rec-{name}", daemon=True
            )
            self._threads.append(t)
            t.start()

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self._started_at if self._started_at else 0.0

    def stop(self) -> Path:
        """Detiene la grabación y devuelve la ruta del audio mezclado."""
        self._stop.set()
        for t in self._threads:
            t.join()
        failed = [t for t in self._tracks if t.error]
        ok = [t for t in self._tracks if not t.error and t.path.exists()]
        if not ok:
            raise RuntimeError(f"No se pudo grabar ninguna fuente: {failed[0].error}")
        for t in failed:
            print(f"[aviso] La fuente '{t.name}' falló: {t.error}", file=sys.stderr)

        out = self.output_dir / "reunion.flac"
        mix_tracks([t.path for t in ok], out)
        for t in self._tracks:
            t.path.unlink(missing_ok=True)
        return out

    def _capture(self, device, track: _Track) -> None:
        try:
            _init_com_for_thread()
            blocksize = int(self.samplerate * BLOCK_SECONDS)
            max_drift = int(self.samplerate * MAX_DRIFT_SECONDS)
            with sf.SoundFile(
                track.path, "w", samplerate=self.samplerate, channels=1, subtype="PCM_16"
            ) as f, device.recorder(samplerate=self.samplerate, channels=1) as rec:
                while not self._stop.is_set():
                    data = rec.record(numframes=blocksize)[:, 0]
                    expected = int(self.elapsed * self.samplerate)
                    track.frames_written = _write_aligned(
                        f, data, track.frames_written, expected, max_drift
                    )
        except BaseException as e:  # noqa: BLE001 - se informa al parar
            track.error = e


def _write_aligned(f, data: np.ndarray, written: int, expected: int, max_drift: int) -> int:
    """Escribe ``data`` manteniendo la pista alineada con el reloj real.

    El loopback de algunos sistemas deja de entregar muestras cuando no suena
    nada (o entrega silencio de golpe). Sin corregirlo, la voz del micrófono y
    la de los demás acabarían desincronizadas en la mezcla.
    """
    behind = expected - (written + len(data))
    if behind > max_drift:
        f.write(np.zeros(behind, dtype=np.float32))
        written += behind
    elif -behind > max_drift and not np.any(data):
        return written  # bloque de silencio que nos adelantaría: se descarta
    f.write(data)
    return written + len(data)


def mix_tracks(paths: list[Path], out: Path, chunk_frames: int = SAMPLE_RATE * 30) -> None:
    """Mezcla varias pistas mono en una sola, por bloques y sin saturar."""
    readers = [sf.SoundFile(p) for p in paths]
    try:
        sr = readers[0].samplerate
        with sf.SoundFile(out, "w", samplerate=sr, channels=1, format="FLAC") as w:
            while True:
                blocks = [r.read(chunk_frames, dtype="float32") for r in readers]
                n = max(len(b) for b in blocks)
                if n == 0:
                    break
                mixed = np.zeros(n, dtype=np.float32)
                for b in blocks:
                    mixed[: len(b)] += b
                np.clip(mixed, -1.0, 1.0, out=mixed)
                w.write(mixed)
    finally:
        for r in readers:
            r.close()
