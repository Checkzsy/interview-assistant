"""Launcher behaviour when backend dependencies are missing.

A managed backend child must fail directly when uvicorn is absent.  The old
fallback silently re-launched a subprocess, which detached the real server
from Electron's stdin EOF lifeline.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_launcher_imports_when_uvicorn_is_absent_without_creating_stub(monkeypatch):
    import start  # noqa: F401 - the launcher must be importable to even run

    # None in sys.modules makes `import uvicorn` raise ImportError, and it
    # proves the launcher does not install a fake module in its place.
    monkeypatch.setitem(sys.modules, "uvicorn", None)

    spec = importlib.util.spec_from_file_location("start_without_uvicorn", ROOT / "start.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    assert module.uvicorn is None
    assert sys.modules["uvicorn"] is None
    assert module.get_local_ip()


def test_hosted_backend_without_uvicorn_fails_clearly_without_subprocess_fallback(monkeypatch):
    import start

    monkeypatch.setattr(start, "uvicorn", None)
    monkeypatch.setenv("IA_MANAGED_BACKEND", "1")
    monkeypatch.setattr(start, "ensure_port_free", lambda *_args: None)
    calls = []
    monkeypatch.setattr(start.subprocess, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(
        start.importlib,
        "import_module",
        lambda _name: (_ for _ in ()).throw(ImportError("missing")),
    )

    with pytest.raises(SystemExit) as excinfo:
        start.start_server("127.0.0.1", 18080)

    assert excinfo.value.code == 1
    assert calls == []
