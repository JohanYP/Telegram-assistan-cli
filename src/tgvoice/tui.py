from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.reactive import reactive
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, Select, Static

from . import config as config_mod
from . import encoder, sounds
from .config import Settings
from .player import Player
from .recorder import Recorder
from .telegram import IncomingText, Telegram
from .wake_word import OpenWakeWordBackend, make_wake_word

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


class ConfigScreen(ModalScreen[dict | None]):
    DEFAULT_CSS = """
    ConfigScreen {
        align: center middle;
    }
    #config-dialog {
        width: 64;
        height: auto;
        max-height: 90%;
        padding: 1 2;
        border: thick $accent;
        background: $surface;
    }
    #config-dialog Label.field-label {
        margin-top: 1;
        color: $text-muted;
    }
    #config-error {
        color: red;
        margin-top: 1;
    }
    #config-buttons {
        margin-top: 2;
        height: 3;
        align: right middle;
    }
    #config-buttons Button {
        margin-left: 2;
    }
    """

    BINDINGS = [Binding("escape", "dismiss_cancel", "cancelar", priority=True)]

    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self._settings = settings

    def compose(self) -> ComposeResult:
        with Vertical(id="config-dialog"):
            yield Label("[b]Configuración[/]")

            yield Label("Wake backend:", classes="field-label")
            yield Select(
                options=[("openwakeword", "openwakeword"), ("vosk", "vosk")],
                value=self._settings.wake_backend,
                id="cfg-backend",
                allow_blank=False,
            )

            yield Label("Wake word:", classes="field-label")
            yield Input(value=self._settings.wake_word, id="cfg-word")

            yield Label("Threshold (0–1, solo openwakeword):", classes="field-label")
            yield Input(value=str(self._settings.wake_threshold), id="cfg-threshold")

            yield Label("Idioma Vosk:", classes="field-label")
            yield Select(
                options=[("es", "es"), ("en", "en")],
                value=self._settings.vosk_lang,
                id="cfg-lang",
                allow_blank=False,
            )

            yield Static("", id="config-error")

            with Horizontal(id="config-buttons"):
                yield Button("Cancelar", id="cfg-cancel")
                yield Button("Guardar", variant="primary", id="cfg-save")

    def on_mount(self) -> None:
        self.query_one("#cfg-word", Input).focus()

    def action_dismiss_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cfg-cancel":
            self.dismiss(None)
            return
        if event.button.id == "cfg-save":
            self._try_save()

    def _try_save(self) -> None:
        backend = self.query_one("#cfg-backend", Select).value
        word = self.query_one("#cfg-word", Input).value.strip()
        threshold_raw = self.query_one("#cfg-threshold", Input).value.strip()
        lang = self.query_one("#cfg-lang", Select).value

        error = self.query_one("#config-error", Static)

        if not word:
            error.update("[red]La wake word no puede estar vacía.[/]")
            return

        try:
            threshold = float(threshold_raw)
        except ValueError:
            error.update("[red]Threshold debe ser un número.[/]")
            return
        if not 0.0 <= threshold <= 1.0:
            error.update("[red]Threshold debe estar entre 0 y 1.[/]")
            return

        if backend == "openwakeword" and word not in OpenWakeWordBackend.PREBUILT:
            error.update(
                f"[red]Con openwakeword la palabra debe ser una de: "
                f"{', '.join(OpenWakeWordBackend.PREBUILT)}. "
                f"Para frases libres usa el backend vosk.[/]"
            )
            return

        self.dismiss(
            {
                "wake_backend": backend,
                "wake_word": word,
                "wake_threshold": threshold,
                "vosk_lang": lang,
            }
        )


class TgvoiceApp(App):
    ENABLE_COMMAND_PALETTE = False  # liberamos Ctrl+P para nuestro modal de config

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
        Binding("escape", "cancel_recording", "cancelar voz"),
        Binding("ctrl+w", "toggle_wake", "voz on/off"),
        Binding("ctrl+p", "open_config", "config"),
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
        self._wake_event = asyncio.Event()
        if settings.wake_enabled:
            self._wake_event.set()

    def _header_text(self) -> str:
        wake_state = "on" if self._settings.wake_enabled else "[red]off[/]"
        return (
            f"[b]tgvoice[/]    bot: [b]@{self._settings.bot_username}[/]    "
            f"wake: [b]{self._settings.wake_word}[/] "
            f"[dim][{self._settings.wake_backend}][/]    "
            f"voz: {wake_state}"
        )

    def _refresh_header(self) -> None:
        try:
            self.query_one(HeaderBar).update(self._header_text())
        except Exception:
            pass

    def compose(self) -> ComposeResult:
        yield HeaderBar(self._header_text())
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
            # Pre-abrir el output stream ANTES de que cualquier input stream
            # (wake word/recorder) tome el device. Si no, el primer ding/close
            # se queda en cola hasta que el input se cierre.
            await asyncio.to_thread(sounds.prewarm)
            self.add_info(f"conectado. hablando con @{self._settings.bot_username}")
            self._player = Player()
            await self._player.start()
            self._recorder = Recorder(self._settings)
            self._tg.on_incoming(self._handle_incoming)

            if self._settings.wake_enabled:
                self._set_status("💤 esperando wake word")
            else:
                self.add_info("wake word desactivada (Ctrl+W para activar)")
                self._set_status("voz: off")

            self._voice_task = asyncio.create_task(self._voice_loop(), name="voice-loop")
        except SystemExit as e:
            self.add_error(str(e))
            self.bell()
        except Exception as e:
            log.exception("startup")
            self.add_error(f"{type(e).__name__}: {e}")

    async def _ensure_wake(self) -> bool:
        if self._wake is not None:
            return True
        try:
            self.add_info(
                f"cargando wake word '{self._settings.wake_word}' "
                f"[{self._settings.wake_backend}]…"
            )
            self._wake = await asyncio.to_thread(make_wake_word, self._settings)
            self.add_info(
                f"di '{self._settings.wake_word.replace('_', ' ')}' "
                f"para hablar, o escribe abajo."
            )
            return True
        except SystemExit as e:
            self.add_error(str(e))
            self._settings.wake_enabled = False
            self._wake_event.clear()
            self._refresh_header()
            self._set_status("voz: off")
            return False
        except Exception as e:
            log.exception("load wake")
            self.add_error(f"wake word: {e}")
            self._settings.wake_enabled = False
            self._wake_event.clear()
            self._refresh_header()
            self._set_status("voz: off")
            return False

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
        assert self._recorder and self._tg
        while True:
            try:
                await self._wake_event.wait()
                if not await self._ensure_wake():
                    # No se pudo cargar; espera a que el usuario reintente.
                    await asyncio.sleep(0.5)
                    continue
                assert self._wake is not None
                self._set_status("💤 esperando wake word")
                detected = await self._wake.listen()
                if not detected:
                    # Cancelado por Ctrl+W o por recarga de config.
                    continue
                sounds.play_ding()
                self._set_status("🎙 grabando…")
                wav = await self._recorder.record()
                sounds.play_close()
                if self._recorder.was_cancelled:
                    self.add_info("voz cancelada")
                    continue
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

    def action_toggle_wake(self) -> None:
        new_state = not self._settings.wake_enabled
        self._settings.wake_enabled = new_state
        try:
            config_mod.save_env({"WAKE_ENABLED": "true" if new_state else "false"})
        except Exception as e:
            self.add_error(f"no se pudo guardar .env: {e}")
        if new_state:
            self._wake_event.set()
            self.add_info("voz activada (Ctrl+W)")
            self._set_status("💤 esperando wake word")
        else:
            self._wake_event.clear()
            if self._wake is not None:
                self._wake.cancel()
            self.add_info("voz desactivada (Ctrl+W)")
            self._set_status("voz: off")
        self._refresh_header()

    def action_open_config(self) -> None:
        self.push_screen(ConfigScreen(self._settings), self._on_config_saved)

    def _on_config_saved(self, result: dict | None) -> None:
        if result is None:
            return
        changed_wake = (
            result["wake_backend"] != self._settings.wake_backend
            or result["wake_word"] != self._settings.wake_word
            or result["wake_threshold"] != self._settings.wake_threshold
            or result["vosk_lang"] != self._settings.vosk_lang
        )
        self._settings.wake_backend = result["wake_backend"]
        self._settings.wake_word = result["wake_word"]
        self._settings.wake_threshold = result["wake_threshold"]
        self._settings.vosk_lang = result["vosk_lang"]
        try:
            config_mod.save_env(
                {
                    "WAKE_BACKEND": result["wake_backend"],
                    "WAKE_WORD": result["wake_word"],
                    "WAKE_THRESHOLD": str(result["wake_threshold"]),
                    "VOSK_LANG": result["vosk_lang"],
                }
            )
        except Exception as e:
            self.add_error(f"no se pudo guardar .env: {e}")
            return

        if changed_wake and self._wake is not None:
            old = self._wake
            self._wake = None
            old.cancel()  # aborta listen() en curso; el loop recreará el wake
            self.add_info("config guardada — recargando wake word…")
        else:
            self.add_info("config guardada")
        self._refresh_header()

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
        sounds.stop()

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

    def action_cancel_recording(self) -> None:
        if self._recorder is not None:
            self._recorder.cancel()

    async def action_clear_chat(self) -> None:
        chat = self.query_one("#chat", VerticalScroll)
        await chat.remove_children()
