from __future__ import annotations

import asyncio
import logging
from pathlib import Path

log = logging.getLogger(__name__)


class Player:
    """Cola serial: reproduce un audio a la vez con ffplay."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[Path | None] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._on_state: callable | None = None  # type: ignore[assignment]
        self._current: asyncio.subprocess.Process | None = None

    def on_state(self, cb) -> None:
        """cb(playing: bool) — llamado cuando empieza/termina la reproducción."""
        self._on_state = cb

    async def start(self) -> None:
        self._task = asyncio.create_task(self._worker(), name="player-worker")

    async def stop(self) -> None:
        await self._queue.put(None)
        if self._current and self._current.returncode is None:
            self._current.terminate()
        if self._task:
            await self._task

    async def enqueue(self, path: Path) -> None:
        await self._queue.put(path)

    async def _worker(self) -> None:
        while True:
            item = await self._queue.get()
            if item is None:
                return
            try:
                if self._on_state:
                    self._on_state(True)
                self._current = await asyncio.create_subprocess_exec(
                    "ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(item),
                )
                await self._current.wait()
            except FileNotFoundError:
                log.error("ffplay no está instalado. Instala ffmpeg.")
            except Exception:
                log.exception("Fallo reproduciendo %s", item)
            finally:
                self._current = None
                if self._on_state:
                    self._on_state(False)
