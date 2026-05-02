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


PREBUILT = ("alexa", "hey_jarvis", "hey_mycroft", "hey_rhasspy")


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
        try:
            self._model = Model(
                wakeword_models=[settings.wake_word],
                inference_framework="onnx",
            )
        except Exception as e:
            raise SystemExit(
                f"No se pudo cargar la wake word '{settings.wake_word}': {e}\n"
                f"Pre-entrenadas disponibles: {', '.join(PREBUILT)}.\n"
                f"Para una palabra personalizada hay que entrenar un modelo aparte."
            )
        loaded = list(getattr(self._model, "models", {}).keys())
        if not loaded or settings.wake_word not in loaded:
            raise SystemExit(
                f"Wake word '{settings.wake_word}' no se cargó (loaded={loaded}).\n"
                f"Pre-entrenadas disponibles: {', '.join(PREBUILT)}."
            )
        log.info("Wake word lista: %s", settings.wake_word)

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
