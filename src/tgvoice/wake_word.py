from __future__ import annotations

import asyncio
import logging

import numpy as np
import sounddevice as sd

from .config import Settings

log = logging.getLogger(__name__)

# openWakeWord espera frames de 80 ms a 16 kHz, int16 mono.
SAMPLE_RATE = 16_000
WAKE_FRAME_SAMPLES = 1280


class WakeWord:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # Lazy import: openwakeword carga modelos al instanciar.
        import openwakeword
        try:
            openwakeword.utils.download_models()
        except Exception:
            log.debug("download_models() no necesario o ya en cache.")
        from openwakeword.model import Model
        self._model = Model(
            wakeword_models=[settings.wake_word],
            inference_framework="onnx",
        )
        loaded = list(getattr(self._model, "models", {}).keys())
        if loaded and settings.wake_word not in loaded:
            raise SystemExit(
                f"Wake word '{settings.wake_word}' no se cargó. "
                f"Modelos disponibles: {loaded}. "
                f"Pre-entrenados típicos: alexa, hey_jarvis, hey_mycroft, hey_rhasspy."
            )
        log.info("Wake word lista: %s (modelos: %s)", settings.wake_word, loaded)

    async def listen(self) -> None:
        """Bloquea hasta que se detecte la wake word, entonces vuelve."""
        await asyncio.to_thread(self._listen_blocking)

    def _listen_blocking(self) -> None:
        threshold = self._settings.wake_threshold
        word = self._settings.wake_word
        with sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            blocksize=WAKE_FRAME_SAMPLES,
            dtype="int16",
            channels=1,
            device=self._settings.input_device,
        ) as stream:
            while True:
                data, _overflowed = stream.read(WAKE_FRAME_SAMPLES)
                arr = np.frombuffer(bytes(data), dtype=np.int16)
                preds = self._model.predict(arr)
                if preds.get(word, 0.0) >= threshold:
                    self._model.reset()
                    return
