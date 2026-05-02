from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from telethon import TelegramClient, events
from telethon.tl.types import Message

from .config import Settings

log = logging.getLogger(__name__)


@dataclass
class IncomingText:
    text: str


@dataclass
class IncomingVoice:
    path: Path


IncomingHandler = Callable[[IncomingText | IncomingVoice], Awaitable[None]]


class Telegram:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = TelegramClient(
            str(settings.session_path),
            settings.api_id,
            settings.api_hash,
        )
        self._bot = None  # entity, resolved after start()
        self._handler: IncomingHandler | None = None

    async def start(self) -> None:
        await self._client.start()  # interactive login on first run
        self._bot = await self._client.get_entity(self._settings.bot_username)
        log.info("Conectado como %s; bot=%s", (await self._client.get_me()).username, self._settings.bot_username)
        self._client.add_event_handler(
            self._on_new_message,
            events.NewMessage(from_users=self._bot, incoming=True),
        )

    def on_incoming(self, handler: IncomingHandler) -> None:
        self._handler = handler

    async def send_text(self, text: str) -> None:
        await self._client.send_message(self._bot, text)

    async def send_voice(self, ogg_path: Path) -> None:
        await self._client.send_file(self._bot, str(ogg_path), voice_note=True)

    async def run_until_disconnected(self) -> None:
        await self._client.run_until_disconnected()

    async def disconnect(self) -> None:
        await self._client.disconnect()

    async def _on_new_message(self, event: events.NewMessage.Event) -> None:
        msg: Message = event.message
        if not self._handler:
            return
        try:
            if msg.voice or msg.audio:
                target = self._settings.cache_dir / f"in_{msg.id}.ogg"
                await msg.download_media(file=str(target))
                await self._handler(IncomingVoice(path=target))
            elif msg.text:
                await self._handler(IncomingText(text=msg.text))
        except Exception:  # don't let one bad message kill the listener
            log.exception("Fallo al procesar mensaje entrante id=%s", msg.id)
