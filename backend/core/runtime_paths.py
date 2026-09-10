"""Runtime path helpers that support both repository and packaged layouts."""
from __future__ import annotations

import os
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]


def frontend_dist() -> str:
    override = os.environ.get("IA_FRONTEND_DIST", "").strip()
    if override:
        return override
    return str(_BACKEND_DIR.parent / "frontend" / "dist")
