from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import runtime_paths


def test_frontend_dist_can_be_overridden_for_packaged_apps(tmp_path, monkeypatch):
    target = tmp_path / "frontend-dist"
    monkeypatch.setenv("IA_FRONTEND_DIST", str(target))

    assert runtime_paths.frontend_dist() == str(target)


def test_frontend_dist_defaults_to_repository_layout(monkeypatch):
    monkeypatch.delenv("IA_FRONTEND_DIST", raising=False)

    assert runtime_paths.frontend_dist() == str(BACKEND_DIR.parent / "frontend" / "dist")
