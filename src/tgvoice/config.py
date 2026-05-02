from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    api_id: int
    api_hash: str
    bot_username: str
    wake_word: str
    wake_threshold: float
    vad_aggressiveness: int
    silence_timeout_ms: int
    max_recording_s: int
    input_device: int | None
    session_path: Path
    cache_dir: Path


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(
            f"Falta la variable {name} en el entorno o en .env. "
            f"Copia .env.example a .env y rellénala."
        )
    return value


def load() -> Settings:
    load_dotenv()
    project_root = Path(__file__).resolve().parents[2]
    cache_dir = project_root / ".cache"
    cache_dir.mkdir(exist_ok=True)

    try:
        api_id = int(_require("API_ID"))
    except ValueError as e:
        raise SystemExit(f"API_ID debe ser un entero: {e}")

    bot = _require("BOT_USERNAME").lstrip("@")
    input_device_raw = os.environ.get("INPUT_DEVICE", "").strip()
    input_device = int(input_device_raw) if input_device_raw else None

    return Settings(
        api_id=api_id,
        api_hash=_require("API_HASH"),
        bot_username=bot,
        wake_word=os.environ.get("WAKE_WORD", "hey_jarvis").strip(),
        wake_threshold=float(os.environ.get("WAKE_THRESHOLD", "0.5")),
        vad_aggressiveness=int(os.environ.get("VAD_AGGRESSIVENESS", "2")),
        silence_timeout_ms=int(os.environ.get("SILENCE_TIMEOUT_MS", "1500")),
        max_recording_s=int(os.environ.get("MAX_RECORDING_S", "15")),
        input_device=input_device,
        session_path=project_root / "tgvoice.session",
        cache_dir=cache_dir,
    )
