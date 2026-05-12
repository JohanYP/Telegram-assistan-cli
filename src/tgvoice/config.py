from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = PROJECT_ROOT / ".env"


@dataclass
class Settings:
    api_id: int
    api_hash: str
    bot_username: str
    wake_backend: str  # "openwakeword" | "vosk"
    wake_word: str
    wake_threshold: float
    wake_enabled: bool
    vosk_lang: str  # "es" | "en"
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


def _parse_bool(raw: str, default: bool) -> bool:
    s = raw.strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off"):
        return False
    return default


def load() -> Settings:
    # Cargamos el .env desde la raíz del proyecto explícitamente para que
    # `tgvoice` funcione desde cualquier cwd (por ejemplo, vía symlink en
    # ~/.local/bin) sin depender del directorio donde se invoque.
    # override=True: el .env siempre gana sobre variables del shell, así
    # un API_ID exportado vacío en .bashrc no enmascara el valor real.
    load_dotenv(ENV_PATH, override=True)
    cache_dir = PROJECT_ROOT / ".cache"
    cache_dir.mkdir(exist_ok=True)

    try:
        api_id = int(_require("API_ID"))
    except ValueError as e:
        raise SystemExit(f"API_ID debe ser un entero: {e}")

    bot = _require("BOT_USERNAME").lstrip("@")
    input_device_raw = os.environ.get("INPUT_DEVICE", "").strip()
    input_device = int(input_device_raw) if input_device_raw else None

    backend = os.environ.get("WAKE_BACKEND", "openwakeword").strip().lower()
    if backend not in ("openwakeword", "vosk"):
        raise SystemExit(f"WAKE_BACKEND inválido: {backend!r}. Usa 'openwakeword' o 'vosk'.")

    return Settings(
        api_id=api_id,
        api_hash=_require("API_HASH"),
        bot_username=bot,
        wake_backend=backend,
        wake_word=os.environ.get("WAKE_WORD", "hey_jarvis").strip(),
        wake_threshold=float(os.environ.get("WAKE_THRESHOLD", "0.5")),
        wake_enabled=_parse_bool(os.environ.get("WAKE_ENABLED", "true"), True),
        vosk_lang=os.environ.get("VOSK_LANG", "es").strip().lower(),
        vad_aggressiveness=int(os.environ.get("VAD_AGGRESSIVENESS", "2")),
        silence_timeout_ms=int(os.environ.get("SILENCE_TIMEOUT_MS", "1500")),
        max_recording_s=int(os.environ.get("MAX_RECORDING_S", "15")),
        input_device=input_device,
        session_path=PROJECT_ROOT / "tgvoice.session",
        cache_dir=cache_dir,
    )


def save_env(updates: dict[str, str]) -> None:
    """Actualiza claves en `.env` de forma atómica preservando comentarios y orden.

    - Reemplaza líneas existentes que empiecen con `KEY=`.
    - Añade al final las claves nuevas.
    """
    if not updates:
        return

    remaining = dict(updates)
    new_lines: list[str] = []

    if ENV_PATH.exists():
        with ENV_PATH.open("r", encoding="utf-8") as f:
            for line in f:
                stripped = line.lstrip()
                if stripped and not stripped.startswith("#") and "=" in stripped:
                    key = stripped.split("=", 1)[0].strip()
                    if key in remaining:
                        new_lines.append(f"{key}={remaining.pop(key)}\n")
                        continue
                new_lines.append(line)

    if remaining:
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines.append("\n")
        for key, value in remaining.items():
            new_lines.append(f"{key}={value}\n")

    # Escritura atómica: tmp en el mismo dir + rename.
    fd, tmp_path = tempfile.mkstemp(prefix=".env.", dir=str(PROJECT_ROOT))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
        os.replace(tmp_path, ENV_PATH)
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise
