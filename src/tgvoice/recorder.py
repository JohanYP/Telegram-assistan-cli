from __future__ import annotations

import asyncio
import logging
import time
import wave
from pathlib import Path

import sounddevice as sd
import webrtcvad

from .config import Settings

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 480
LEADING_SILENCE_TIMEOUT_MS = 3_000


class Recorder:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def record(self) -> Path | None:
        """Graba hasta detectar silencio o llegar al máximo. None si no hubo voz."""
        return await asyncio.to_thread(self._record_blocking)

    def _record_blocking(self) -> Path | None:
        vad = webrtcvad.Vad(self._settings.vad_aggressiveness)
        audio = bytearray()
        voice_seen = False
        trailing_silence_ms = 0
        leading_silence_ms = 0
        elapsed_ms = 0
        max_ms = self._settings.max_recording_s * 1000

        try:
            with sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                blocksize=FRAME_SAMPLES,
                dtype="int16",
                channels=1,
                device=self._settings.input_device,
            ) as stream:
                while elapsed_ms < max_ms:
                    data, _overflowed = stream.read(FRAME_SAMPLES)
                    chunk = bytes(data)
                    audio.extend(chunk)
                    elapsed_ms += FRAME_MS

                    is_voice = vad.is_speech(chunk, SAMPLE_RATE)
                    if not voice_seen:
                        if is_voice:
                            voice_seen = True
                            trailing_silence_ms = 0
                        else:
                            leading_silence_ms += FRAME_MS
                            if leading_silence_ms > LEADING_SILENCE_TIMEOUT_MS:
                                break
                    else:
                        if is_voice:
                            trailing_silence_ms = 0
                        else:
                            trailing_silence_ms += FRAME_MS
                            if trailing_silence_ms > self._settings.silence_timeout_ms:
                                break
        except sd.PortAudioError as e:
            log.error("Error de PortAudio: %s", e)
            return None

        if not voice_seen:
            return None

        out_path = self._settings.cache_dir / f"out_{int(time.time())}.wav"
        with wave.open(str(out_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(bytes(audio))
        return out_path
