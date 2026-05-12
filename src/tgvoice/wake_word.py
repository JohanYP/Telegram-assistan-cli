from __future__ import annotations

import asyncio
import json
import logging
import threading
import zipfile
from pathlib import Path
from urllib.request import urlretrieve

import numpy as np
import sounddevice as sd

from .config import Settings

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000


class WakeWord:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._stop = threading.Event()

    async def listen(self) -> bool:
        """Espera a que se diga la wake word. Devuelve True si se detectó,
        False si fue cancelada vía `cancel()`."""
        self._stop.clear()
        return await asyncio.to_thread(self._listen_blocking)

    def cancel(self) -> None:
        self._stop.set()

    def _listen_blocking(self) -> bool:
        raise NotImplementedError


class OpenWakeWordBackend(WakeWord):
    PREBUILT = ("alexa", "hey_jarvis", "hey_mycroft", "hey_rhasspy")
    FRAME_SAMPLES = 1280  # 80 ms

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
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
                f"Pre-entrenadas disponibles: {', '.join(self.PREBUILT)}.\n"
                f"Para una palabra personalizada usa WAKE_BACKEND=vosk."
            )
        loaded = list(getattr(self._model, "models", {}).keys())
        if not loaded or settings.wake_word not in loaded:
            raise SystemExit(
                f"Wake word '{settings.wake_word}' no se cargó (loaded={loaded}).\n"
                f"Pre-entrenadas disponibles: {', '.join(self.PREBUILT)}."
            )
        log.info("openWakeWord lista: %s", settings.wake_word)

    def _listen_blocking(self) -> bool:
        threshold = self._settings.wake_threshold
        word = self._settings.wake_word
        with sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            blocksize=self.FRAME_SAMPLES,
            dtype="int16",
            channels=1,
            device=self._settings.input_device,
        ) as stream:
            while not self._stop.is_set():
                data, _overflowed = stream.read(self.FRAME_SAMPLES)
                if self._stop.is_set():
                    return False
                arr = np.frombuffer(bytes(data), dtype=np.int16)
                preds = self._model.predict(arr)
                if preds.get(word, 0.0) >= threshold:
                    self._model.reset()
                    return True
        return False


class VoskBackend(WakeWord):
    """Usa Vosk con grammar restringida a la frase de wake word.

    Esto deja que cualquier frase (ej. 'hey il') funcione sin entrenar nada.
    El reconocedor solo puede emitir la frase configurada o '[unk]'.
    """

    MODELS = {
        "es": (
            "vosk-model-small-es-0.42",
            "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip",
        ),
        "en": (
            "vosk-model-small-en-us-0.15",
            "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
        ),
    }
    FRAME_SAMPLES = 4000  # 250 ms a 16 kHz

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        import vosk
        vosk.SetLogLevel(-1)
        if settings.vosk_lang not in self.MODELS:
            raise SystemExit(
                f"VOSK_LANG '{settings.vosk_lang}' no soportado. Usa 'es' o 'en'."
            )
        model_dirname, url = self.MODELS[settings.vosk_lang]
        model_path = settings.cache_dir / model_dirname
        if not model_path.exists():
            log.info("Descargando modelo Vosk %s (~40 MB)...", model_dirname)
            self._download_and_extract(url, settings.cache_dir)
        self._model = vosk.Model(str(model_path))
        self._wake_phrase = settings.wake_word.replace("_", " ").lower().strip()
        if not self._wake_phrase:
            raise SystemExit("WAKE_WORD vacío.")
        # Grammar: solo reconoce la frase o "[unk]" (palabra desconocida).
        self._grammar = json.dumps([self._wake_phrase, "[unk]"])
        log.info("Vosk lista. frase='%s' modelo=%s", self._wake_phrase, model_dirname)

    @staticmethod
    def _download_and_extract(url: str, target_dir: Path) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        zip_path = target_dir / "vosk_model.zip"
        try:
            urlretrieve(url, zip_path)
            with zipfile.ZipFile(zip_path) as z:
                z.extractall(target_dir)
        finally:
            zip_path.unlink(missing_ok=True)

    def _listen_blocking(self) -> bool:
        import vosk
        rec = vosk.KaldiRecognizer(self._model, SAMPLE_RATE, self._grammar)
        with sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            blocksize=self.FRAME_SAMPLES,
            dtype="int16",
            channels=1,
            device=self._settings.input_device,
        ) as stream:
            while not self._stop.is_set():
                data, _overflowed = stream.read(self.FRAME_SAMPLES)
                if self._stop.is_set():
                    return False
                if rec.AcceptWaveform(bytes(data)):
                    result = json.loads(rec.Result())
                    text = result.get("text", "").strip().lower()
                    if text and self._wake_phrase in text:
                        return True
        return False


def make_wake_word(settings: Settings) -> WakeWord:
    if settings.wake_backend == "vosk":
        return VoskBackend(settings)
    return OpenWakeWordBackend(settings)
