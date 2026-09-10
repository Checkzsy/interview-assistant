from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def test_packaged_backend_entrypoint_starts_local_uvicorn(monkeypatch):
    import entrypoint

    captured = {}
    monkeypatch.setenv("PORT", "12345")
    monkeypatch.setattr(
        entrypoint.uvicorn,
        "run",
        lambda app, **kwargs: captured.update({"app": app, **kwargs}),
    )

    entrypoint.main()

    assert captured["app"] is entrypoint.app
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 12345
    assert captured["reload"] is False
