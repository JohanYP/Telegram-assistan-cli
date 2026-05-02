from __future__ import annotations

import logging
import threading
from contextlib import suppress

import numpy as np
import sounddevice as sd

log = logging.getLogger(__name__)

_SAMPLE_RATE = 22_050


def _tone(freq: float, duration_ms: int, volume: float = 0.25) -> np.ndarray:
    n = int(_SAMPLE_RATE * duration_ms / 1000)
    t = np.linspace(0.0, duration_ms / 1000.0, n, endpoint=False, dtype=np.float32)
    wave_arr = (np.sin(2 * np.pi * freq * t) * volume).astype(np.float32)
    fade = int(_SAMPLE_RATE * 0.01)  # 10 ms para evitar clicks
    if n > 2 * fade:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        wave_arr[:fade] *= ramp
        wave_arr[-fade:] *= ramp[::-1]
    return wave_arr


def _to_pcm16(samples: np.ndarray) -> bytes:
    return (samples * 32767).clip(-32768, 32767).astype(np.int16).tobytes()


_DING = _to_pcm16(np.concatenate([_tone(880, 70), _tone(1320, 110)]))
_CLOSE = _to_pcm16(np.concatenate([_tone(1320, 70), _tone(660, 110)]))


# OutputStream persistente. Cada play_*() solo escribe bytes a un stream
# ya conectado al device, sin overhead de spawn de proceso (paplay/ffplay
# = 100-500 ms) ni de apertura de stream nuevo.
#
# Why: en una versión previa se usaba sd.play() ad-hoc y los sonidos
# quedaban en cola mientras el RawInputStream del wake word/recorder tenía
# el device abierto, soltándose todos juntos al cerrarlo. Pre-abriendo el
# OutputStream ANTES del primer InputStream esa serialización no aplica:
# el stream ya está establecido cuando el input se abre.
_stream: sd.RawOutputStream | None = None
_open_lock = threading.Lock()
_write_lock = threading.Lock()


def prewarm() -> None:
    """Abre el output stream. Llamar al inicio, antes de los input streams."""
    global _stream
    with _open_lock:
        if _stream is not None:
            return
        try:
            s = sd.RawOutputStream(
                samplerate=_SAMPLE_RATE,
                channels=1,
                dtype="int16",
                latency="low",
            )
            s.start()
            _stream = s
        except Exception as e:
            log.warning("no se pudo abrir output stream: %s", e)


def stop() -> None:
    """Cierra el output stream. Llamar al apagar la app."""
    global _stream
    with _open_lock:
        if _stream is None:
            return
        with suppress(Exception):
            _stream.stop()
            _stream.close()
        _stream = None


def _play_blocking(data: bytes, label: str) -> None:
    if _stream is None:
        prewarm()
    if _stream is None:
        return
    try:
        with _write_lock:
            _stream.write(data)
    except Exception as e:
        log.warning("fallo al reproducir %s: %s", label, e)


def _play(data: bytes, label: str) -> None:
    threading.Thread(
        target=_play_blocking,
        args=(data, label),
        daemon=True,
        name=f"sound-{label}",
    ).start()


def play_ding() -> None:
    """Sonido al detectar la wake word (ascendente). No bloquea."""
    _play(_DING, "ding")


def play_close() -> None:
    """Sonido al cerrar la captura de voz (descendente). No bloquea."""
    _play(_CLOSE, "close")
