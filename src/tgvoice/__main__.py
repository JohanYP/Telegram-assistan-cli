from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import threading
from pathlib import Path

from . import config
from .telegram import Telegram
from .tui import TgvoiceApp

log = logging.getLogger(__name__)


def _setup_logging(cache_dir: Path) -> None:
    log_file = cache_dir / "tgvoice.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.FileHandler(log_file, mode="a")],
    )
    logging.getLogger("telethon").setLevel(logging.WARNING)


async def _amain() -> None:
    settings = config.load()
    _setup_logging(settings.cache_dir)

    # Login interactivo ANTES de la TUI: Textual captura stdin y rompería
    # los input() que Telethon usa para pedir teléfono / código / 2FA.
    print(f"conectando a Telegram… (sesión: {settings.session_path.name})")
    print("si es la primera vez te pedirá teléfono y un código por Telegram.\n")
    tg = Telegram(settings)
    await tg.start()
    print(f"✓ conectado. hablando con @{settings.bot_username}\n")

    app = TgvoiceApp(settings, tg)
    try:
        await app.run_async()
    finally:
        await app.cleanup()


def _install_signal_handlers() -> None:
    # SIGHUP (cierre de terminal) o SIGTERM: forzamos salida en 2s por si
    # algun thread de PortAudio queda bloqueado en stream.read().
    def _handler(signum, _frame):
        threading.Timer(2.0, lambda: os._exit(0)).start()
        raise KeyboardInterrupt

    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, _handler)


def run() -> None:
    _install_signal_handlers()
    exit_code = 0
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("error fatal")
        print(f"\n❌ {type(e).__name__}: {e}", file=sys.stderr)
        print("   Detalle completo en .cache/tgvoice.log", file=sys.stderr)
        exit_code = 1
    # os._exit en vez de sys.exit: salta el shutdown del executor por si
    # quedo algun thread de PortAudio bloqueado en read().
    os._exit(exit_code)


if __name__ == "__main__":
    run()
