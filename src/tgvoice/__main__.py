from __future__ import annotations

import asyncio
import logging
import signal
import sys
from pathlib import Path

from . import config, encoder
from .player import Player
from .recorder import Recorder
from .telegram import IncomingText, IncomingVoice, Telegram
from .tui import TUI
from .wake_word import WakeWord

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

    tui = TUI()
    tui.print_info(f"conectando a Telegram… (sesión: {settings.session_path.name})")

    tg = Telegram(settings)
    await tg.start()
    tui.print_info(f"listo. hablando con @{settings.bot_username}")

    player = Player()
    await player.start()

    recorder = Recorder(settings)

    async def handle_incoming(msg: IncomingText | IncomingVoice) -> None:
        if isinstance(msg, IncomingText):
            tui.print_bot(msg.text)
        else:
            tui.print_bot_voice()
            await player.enqueue(msg.path)

    tg.on_incoming(handle_incoming)

    async def on_user_text(text: str) -> None:
        tui.print_me(text)
        try:
            await tg.send_text(text)
        except Exception as e:
            tui.print_error(f"no se pudo enviar: {e}")

    tui.print_info(f"cargando wake word '{settings.wake_word}'… (puede tardar la primera vez)")
    wake = WakeWord(settings)
    tui.print_info(f"di '{settings.wake_word.replace('_', ' ')}' para hablar por voz, o escribe abajo.")

    async def voice_loop() -> None:
        while True:
            try:
                tui.set_status("💤 esperando wake word")
                await wake.listen()
                tui.set_status("🎙 grabando…")
                wav = await recorder.record()
                if wav is None:
                    tui.print_info("no detecté voz; vuelvo a escuchar")
                    continue
                tui.set_status("🎚 codificando…")
                try:
                    ogg = await encoder.wav_to_opus_ogg(wav)
                except RuntimeError as e:
                    tui.print_error(f"codificación: {e}")
                    wav.unlink(missing_ok=True)
                    continue
                tui.set_status("⬆ enviando…")
                try:
                    await tg.send_voice(ogg)
                    tui.print_me("🔊 [audio enviado]")
                except Exception as e:
                    tui.print_error(f"envío: {e}")
                finally:
                    wav.unlink(missing_ok=True)
                    ogg.unlink(missing_ok=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("voice loop")
                tui.print_error(f"voz: {e}")
                await asyncio.sleep(1)

    voice_task = asyncio.create_task(voice_loop(), name="voice-loop")

    try:
        await tui.input_loop(on_user_text)
    finally:
        voice_task.cancel()
        try:
            await voice_task
        except (asyncio.CancelledError, Exception):
            pass
        await player.stop()
        await tg.disconnect()
        tui.print_info("hasta luego.")


def run() -> None:
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
        sys.exit(1)


if __name__ == "__main__":
    run()
