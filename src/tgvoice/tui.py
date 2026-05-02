from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.reactive import reactive
from textual.widgets import Footer, Input, Static

from . import encoder, sounds
from .config import Settings
from .player import Player
from .recorder import Recorder
from .telegram import IncomingText, IncomingVoice, Telegram
from .wake_word import make_wake_word

log = logging.getLogger(__name__)


class MessageBox(Static):
    DEFAULT_CSS = """
    MessageBox {
        margin: 0 1;
        padding: 0 1;
        border: round $accent;
        height: auto;
        width: 100%;
    }
    MessageBox.-me { border: round cyan; }
    MessageBox.-bot { border: round green; }
    MessageBox.-info {
        border: round $surface-lighten-2;
        color: $text-muted;
    }
    MessageBox.-error {
        border: round red;
        color: red;
    }
    """

    def __init__(self, role: str, content: str, *, kind: str) -> None:
        ts = datetime.now().strftime("%H:%M")
        body = f"[bold]{role}[/]  [dim]{ts}[/]\n{content}"
        super().__init__(body)
        self.add_class(f"-{kind}")


class HeaderBar(Static):
    DEFAULT_CSS = """
    HeaderBar {
        height: 1;
        background: $primary;
        color: $text;
        padding: 0 1;
    }
    """


class StatusBar(Static):
    DEFAULT_CSS = """
    StatusBar {
        height: 1;
        background: $boost;
        color: $text;
        padding: 0 1;
    }
    """

    status: reactive[str] = reactive("conectando…", layout=True)

    def render(self) -> str:
        return self.status


class TgvoiceApp(App):
    CSS = """
    Screen { background: $surface; }

    #chat {
        height: 1fr;
        padding: 1 0;
    }

    #input-frame {
        height: 3;
        border: round $accent;
        margin: 0 1;
        background: $surface;
    }

    Input {
        background: transparent;
        border: none;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "salir", priority=True),
        Binding("ctrl+l", "clear_chat", "limpiar"),
    ]

    def __init__(self, settings: Settings, tg: Telegram) -> None:
        super().__init__()
        self._settings = settings
        self._tg = tg
        self._player: Player | None = None
        self._recorder: Recorder | None = None
        self._wake = None
        self._voice_task = None

    def compose(self) -> ComposeResult:
        yield HeaderBar(
            f"[b]tgvoice[/]    bot: [b]@{self._settings.bot_username}[/]    "
            f"wake: [b]{self._settings.wake_word}[/] "
            f"[dim][{self._settings.wake_backend}][/]"
        )
        yield VerticalScroll(id="chat")
        with Horizontal(id="input-frame"):
            yield Input(placeholder="escribe un mensaje y Enter para enviar…", id="prompt")
        yield StatusBar()
        yield Footer()

    async def on_mount(self) -> None:
        self.query_one(Input).focus()
        self.run_worker(self._startup(), name="startup", exit_on_error=False)

    async def _startup(self) -> None:
        try:
            self.add_info(f"conectado. hablando con @{self._settings.bot_username}")
            self._player = Player()
            await self._player.start()
            self._recorder = Recorder(self._settings)
            self._tg.on_incoming(self._handle_incoming)

            self.add_info(
                f"cargando wake word '{self._settings.wake_word}' "
                f"[{self._settings.wake_backend}]…"
            )
            self._wake = await asyncio.to_thread(make_wake_word, self._settings)
            self.add_info(
                f"di '{self._settings.wake_word.replace('_', ' ')}' "
                f"para hablar, o escribe abajo."
            )

            self._set_status("💤 esperando wake word")
            self._voice_task = asyncio.create_task(self._voice_loop(), name="voice-loop")
        except SystemExit as e:
            self.add_error(str(e))
            self.bell()
        except Exception as e:
            log.exception("startup")
            self.add_error(f"{type(e).__name__}: {e}")

    async def _handle_incoming(self, msg) -> None:
        if isinstance(msg, IncomingText):
            self.add_bot(msg.text)
        else:
            self.add_bot_voice()
            assert self._player is not None
            await self._player.enqueue(msg.path)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if not text:
            return
        event.input.value = ""
        self.add_me(text)
        try:
            await self._tg.send_text(text)
        except Exception as e:
            self.add_error(f"no se pudo enviar: {e}")

    async def _voice_loop(self) -> None:
        assert self._wake and self._recorder and self._tg
        while True:
            try:
                self._set_status("💤 esperando wake word")
                await self._wake.listen()
                await asyncio.to_thread(sounds.play_ding)
                self._set_status("🎙 grabando…")
                wav = await self._recorder.record()
                await asyncio.to_thread(sounds.play_close)
                if wav is None:
                    self.add_info("no detecté voz")
                    continue
                self._set_status("🎚 codificando…")
                try:
                    ogg = await encoder.wav_to_opus_ogg(wav)
                except RuntimeError as e:
                    self.add_error(f"codificación: {e}")
                    wav.unlink(missing_ok=True)
                    continue
                self._set_status("⬆ enviando…")
                try:
                    await self._tg.send_voice(ogg)
                    self.add_me("🔊 [audio enviado]")
                except Exception as e:
                    self.add_error(f"envío: {e}")
                finally:
                    wav.unlink(missing_ok=True)
                    ogg.unlink(missing_ok=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("voice loop")
                self.add_error(f"voz: {e}")
                await asyncio.sleep(1)

    async def cleanup(self) -> None:
        if self._voice_task:
            self._voice_task.cancel()
            try:
                await self._voice_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._player:
            await self._player.stop()
        if self._tg:
            await self._tg.disconnect()

    # UI helpers (síncronos: el mount se encola y se procesa en orden).

    def _set_status(self, status: str) -> None:
        self.query_one(StatusBar).status = status

    def add_me(self, text: str) -> None:
        self._append("yo", text, "me")

    def add_bot(self, text: str) -> None:
        self._append("bot", text, "bot")

    def add_bot_voice(self) -> None:
        self._append("bot", "[italic]🔊 audio[/]", "bot")

    def add_info(self, text: str) -> None:
        self._append("·", text, "info")

    def add_error(self, text: str) -> None:
        self._append("!", text, "error")

    def _append(self, role: str, text: str, kind: str) -> None:
        chat = self.query_one("#chat", VerticalScroll)
        chat.mount(MessageBox(role, text, kind=kind))
        chat.scroll_end(animate=False)

    async def action_clear_chat(self) -> None:
        chat = self.query_one("#chat", VerticalScroll)
        await chat.remove_children()
