from __future__ import annotations

import logging

import numpy as np
import sounddevice as sd

log = logging.getLogger(__name__)

_SAMPLE_RATE = 22_050


def _tone(freq: float, duration_ms: int, volume: float = 0.25) -> np.ndarray:
    n = int(_SAMPLE_RATE * duration_ms / 1000)
    t = np.linspace(0.0, duration_ms / 1000.0, n, endpoint=False, dtype=np.float32)
    wave = (np.sin(2 * np.pi * freq * t) * volume).astype(np.float32)
    fade = int(_SAMPLE_RATE * 0.01)  # 10 ms para evitar clicks
    if n > 2 * fade:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        wave[:fade] *= ramp
        wave[-fade:] *= ramp[::-1]
    return wave


# Ding doble ascendente: marca el inicio de la captura de voz.
_DING = np.concatenate([_tone(880, 70), _tone(1320, 110)])
# Tono doble descendente: marca el cierre de la captura.
_CLOSE = np.concatenate([_tone(1320, 70), _tone(660, 110)])


def _play(buffer: np.ndarray, label: str) -> None:
    try:
        sd.play(buffer, _SAMPLE_RATE)
        sd.wait()
    except sd.PortAudioError as e:
        log.warning("no se pudo reproducir %s: %s", label, e)


def play_ding() -> None:
    """Sonido al detectar la wake word (subiendo)."""
    _play(_DING, "ding")


def play_close() -> None:
    """Sonido al cerrar la captura de voz (bajando)."""
    _play(_CLOSE, "close")
