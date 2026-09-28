from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from meeting_recorder import pipeline, summarize
from meeting_recorder.audio import _write_aligned, mix_tracks
from meeting_recorder.transcribe import format_segments, format_timestamp


def test_mix_tracks_sums_and_pads_shorter_track(tmp_path: Path):
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    sf.write(a, np.full(16000, 0.25, dtype=np.float32), 16000)
    sf.write(b, np.full(8000, 0.5, dtype=np.float32), 16000)
    out = tmp_path / "out.flac"

    mix_tracks([a, b], out, chunk_frames=3000)

    data, sr = sf.read(out, dtype="float32")
    assert sr == 16000 and len(data) == 16000
    assert data[:8000] == pytest.approx(0.75, abs=1e-3)
    assert data[8000:] == pytest.approx(0.25, abs=1e-3)


def test_mix_tracks_clips(tmp_path: Path):
    paths = []
    for i in range(3):
        p = tmp_path / f"{i}.wav"
        sf.write(p, np.full(100, 0.6, dtype=np.float32), 16000)
        paths.append(p)
    mix_tracks(paths, tmp_path / "o.flac")
    data, _ = sf.read(tmp_path / "o.flac", dtype="float32")
    assert data.max() <= 1.0


class _Sink:
    def __init__(self):
        self.frames = 0

    def write(self, data):
        self.frames += len(data)


def test_write_aligned_pads_when_stream_falls_behind():
    f = _Sink()
    written = _write_aligned(f, np.ones(100, np.float32), written=0, expected=1000, max_drift=50)
    assert written == f.frames == 1000


def test_write_aligned_drops_silence_when_ahead():
    f = _Sink()
    written = _write_aligned(f, np.zeros(100, np.float32), written=1000, expected=0, max_drift=50)
    assert written == 1000 and f.frames == 0
    # Audio real nunca se descarta aunque vaya adelantado.
    written = _write_aligned(f, np.ones(100, np.float32), written=1000, expected=0, max_drift=50)
    assert written == 1100


def test_format_segments():
    segs = [SimpleNamespace(start=5.2, end=7, text=" Hola "), SimpleNamespace(start=3725, end=3730, text="  ")]
    assert format_timestamp(3725) == "01:02:05"
    assert format_segments(segs) == "[00:00:05] Hola\n"


def test_new_meeting_dir_slug(tmp_path: Path):
    d = pipeline.new_meeting_dir("Sprint Review: Q3!", root=tmp_path)
    assert d.parent == tmp_path and d.name.endswith("_sprint-review-q3")


class _FakeStream:
    def __init__(self, message, calls, kwargs):
        self.message, self.calls, self.kwargs = message, calls, kwargs

    def __enter__(self):
        self.calls.append(self.kwargs)
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self.message


def _fake_client(message, calls):
    stream = lambda **kw: _FakeStream(message, calls, kw)  # noqa: E731
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))


def test_summarize_sends_transcript_and_returns_text():
    calls = []
    msg = SimpleNamespace(
        stop_reason="end_turn",
        content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text="# Resumen")],
    )
    out = summarize.summarize("[00:00:01] Hola", title="Demo", client=_fake_client(msg, calls))
    assert out == "# Resumen\n"
    assert "[00:00:01] Hola" in calls[0]["messages"][0]["content"]
    assert "# Demo" in calls[0]["system"]
    assert calls[0]["fallbacks"] == "default"


def test_summarize_refusal_raises():
    msg = SimpleNamespace(stop_reason="refusal", content=[])
    with pytest.raises(summarize.SummaryError):
        summarize.summarize("texto", client=_fake_client(msg, []))


def test_summarize_empty_transcript_raises():
    with pytest.raises(summarize.SummaryError):
        summarize.summarize("   ")


def test_process_reuses_existing_transcript(tmp_path: Path, monkeypatch):
    (tmp_path / "reunion.flac").write_bytes(b"")
    (tmp_path / "transcripcion.txt").write_text("[00:00:01] Hola", encoding="utf-8")
    monkeypatch.setattr(pipeline.trans, "transcribe", lambda *a, **k: pytest.fail("no debe transcribir"))
    monkeypatch.setattr(pipeline.summ, "summarize", lambda t, **k: f"RESUMEN de {t}")

    _, summary = pipeline.process(tmp_path, pipeline.Settings(), log=lambda m: None)

    assert summary.read_text(encoding="utf-8") == "RESUMEN de [00:00:01] Hola"


class _FakeDevice:
    """Imita un dispositivo de soundcard que entrega un tono constante."""

    def __init__(self, level):
        self.level = level

    def recorder(self, samplerate, channels):
        dev = self

        class _Rec:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def record(self, numframes):
                import time

                time.sleep(numframes / samplerate)
                return np.full((numframes, channels), dev.level, dtype=np.float32)

        return _Rec()


def test_recorder_records_and_mixes_sources(tmp_path: Path, monkeypatch):
    import time

    from meeting_recorder import audio

    monkeypatch.setattr(audio, "_get_sources", lambda *a: {
        "sistema": _FakeDevice(0.1), "microfono": _FakeDevice(0.2)})
    rec = audio.Recorder(tmp_path)
    rec.start()
    time.sleep(1.2)
    out = rec.stop()

    data, sr = sf.read(out, dtype="float32")
    assert out.name == "reunion.flac" and sr == audio.SAMPLE_RATE
    assert len(data) >= sr  # al menos ~1 s grabado
    assert np.median(data) == pytest.approx(0.3, abs=1e-3)
    assert not list(tmp_path.glob("_*.wav"))  # pistas temporales borradas


def test_make_client_sends_workspace_header(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_123")
    assert summarize.make_client().default_headers["anthropic-workspace-id"] == "wrkspc_123"
    monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID")
    assert "anthropic-workspace-id" not in summarize.make_client().default_headers
