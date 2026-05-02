from __future__ import annotations

import logging
from typing import Awaitable, Callable

from prompt_toolkit import PromptSession
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.patch_stdout import patch_stdout
from rich.console import Console

log = logging.getLogger(__name__)

OnText = Callable[[str], Awaitable[None]]


class TUI:
    def __init__(self) -> None:
        self._console = Console()
        self._session: PromptSession = PromptSession()
        self._status: str = "💤 esperando wake word"

    def set_status(self, status: str) -> None:
        self._status = status
        app = self._session.app if self._session else None
        if app is not None:
            try:
                app.invalidate()
            except Exception:
                pass

    def print_me(self, text: str) -> None:
        self._console.print(f"[bold cyan]yo[/]  {text}")

    def print_bot(self, text: str) -> None:
        self._console.print(f"[bold green]bot[/] {text}")

    def print_bot_voice(self) -> None:
        self._console.print("[bold green]bot[/] [italic dim]🔊 audio[/]")

    def print_info(self, text: str) -> None:
        self._console.print(f"[dim]· {text}[/]")

    def print_error(self, text: str) -> None:
        self._console.print(f"[bold red]![/] {text}")

    async def input_loop(self, on_text: OnText) -> None:
        with patch_stdout(raw=True):
            while True:
                try:
                    text = await self._session.prompt_async(
                        "› ",
                        bottom_toolbar=lambda: HTML(f"<b>{self._status}</b>"),
                        refresh_interval=0.5,
                    )
                except (EOFError, KeyboardInterrupt):
                    return
                text = (text or "").strip()
                if text:
                    await on_text(text)
