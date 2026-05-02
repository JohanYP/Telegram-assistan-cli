"""Comando hermano: envía SIGUSR1 al tgvoice corriendo para cancelar la grabación.

Uso:
    tgvoice-cancel

Pensado para ser bindeado como atajo global en el DE (KDE/GNOME/Hyprland/etc.)
para poder cancelar incluso con la ventana minimizada o sin foco.
"""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path


def run() -> None:
    project_root = Path(__file__).resolve().parents[2]
    pid_file = project_root / ".cache" / "tgvoice.pid"

    if not pid_file.exists():
        print("tgvoice no está corriendo (no hay .cache/tgvoice.pid)", file=sys.stderr)
        sys.exit(1)

    try:
        pid = int(pid_file.read_text().strip())
    except (ValueError, OSError) as e:
        print(f"PID inválido en {pid_file}: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        os.kill(pid, signal.SIGUSR1)
    except ProcessLookupError:
        pid_file.unlink(missing_ok=True)
        print("tgvoice no está corriendo (PID stale, lo limpio)", file=sys.stderr)
        sys.exit(1)
    except PermissionError:
        print(f"sin permiso para señalar PID {pid}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run()
