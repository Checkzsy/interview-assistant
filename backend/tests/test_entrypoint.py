from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def test_packaged_backend_entrypoint_uses_managed_runner(monkeypatch):
    import entrypoint
    from core import server_runner

    captured = {}
    monkeypatch.setenv("PORT", "12345")
    monkeypatch.setenv("IA_ACCESS_LOG", "1")
    monkeypatch.setattr(server_runner, "run_managed", lambda **kwargs: captured.update(kwargs))

    entrypoint.main()

    assert captured == {"host": "127.0.0.1", "port": 12345, "access_log": True}


def test_entrypoint_honours_access_log_switch(monkeypatch):
    import entrypoint
    from core import server_runner

    captured = {}
    monkeypatch.setenv("IA_ACCESS_LOG", "0")
    monkeypatch.setattr(server_runner, "run_managed", lambda **kwargs: captured.update(kwargs))

    entrypoint.main()

    assert captured["access_log"] is False
