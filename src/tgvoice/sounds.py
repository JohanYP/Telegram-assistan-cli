from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

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


_DING = np.concatenate([_tone(880, 70), _tone(1320, 110)])
_CLOSE = np.concatenate([_tone(1320, 70), _tone(660, 110)])

_TMP = Path(tempfile.gettempdir())
_DING_PATH = _TMP / "tgvoice_ding.wav"
_CLOSE_PATH = _TMP / "tgvoice_close.wav"

_PLAYER: list[str] | None = None  # se resuelve la primera vez


def _write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = (samples * 32767).clip(-32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(_SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())


def _ensure_files() -> None:
    if not _DING_PATH.exists():
        _write_wav(_DING_PATH, _DING)
    if not _CLOSE_PATH.exists():
        _write_wav(_CLOSE_PATH, _CLOSE)


def _detect_player() -> list[str] | None:
    """Reproductor más ligero disponible. paplay > ffplay > aplay."""
    if shutil.which("paplay"):
        return ["paplay"]
    if shutil.which("ffplay"):
        return ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]
    if shutil.which("aplay"):
        return ["aplay", "-q"]
    return None


def _play(path: Path, label: str) -> None:
    global _PLAYER
    _ensure_files()
    if _PLAYER is None:
        _PLAYER = _detect_player()
        if _PLAYER is None:
            log.warning("no encontré paplay/ffplay/aplay para reproducir %s", label)
            return
    try:
        subprocess.run(
            _PLAYER + [str(path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        log.warning("no se pudo reproducir %s: %s", label, e)


def play_ding() -> None:
    """Sonido al detectar la wake word (ascendente)."""
    _play(_DING_PATH, "ding")


def play_close() -> None:
    """Sonido al cerrar la captura de voz (descendente)."""
    _play(_CLOSE_PATH, "close")
