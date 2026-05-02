from __future__ import annotations

import asyncio
import logging
from pathlib import Path

log = logging.getLogger(__name__)


async def wav_to_opus_ogg(wav_path: Path) -> Path:
    """Convierte WAV a OGG/Opus 32 kbps. Telegram lo muestra como voice message."""
    out = wav_path.with_suffix(".ogg")
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-y",
        "-i", str(wav_path),
        "-c:a", "libopus",
        "-b:a", "32k",
        "-application", "voip",
        str(out),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        log.error("ffmpeg falló (rc=%s): %s", proc.returncode, stderr.decode(errors="replace"))
        raise RuntimeError("No se pudo codificar a opus/ogg")
    return out
