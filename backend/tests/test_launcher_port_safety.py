"""Port safety for the launcher: never kill unrelated listeners.

The launcher is handed a port by a parent (Electron) or the user. If that port
is already taken, startup must fail clearly instead of terminating whoever
owns it -- the old `kill_port` behaviour killed arbitrary processes by PID.
"""

from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture()
def start_module():
    import start

    return start


def test_kill_port_helper_is_gone(start_module):
    assert not hasattr(start_module, "kill_port"), (
        "start.py must not terminate processes by port ownership"
    )


def test_ensure_port_free_reports_the_listening_process_without_killing_it(start_module):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    try:
        with pytest.raises(start_module.PortInUseError) as excinfo:
            start_module.ensure_port_free("127.0.0.1", port)

        assert excinfo.value.port == port
        assert "占用" in str(excinfo.value) or "in use" in str(excinfo.value).lower()
        # 监听者必须仍然存活：探测只能 bind 试一次，不能探测后杀掉。
        assert listener.getsockname()[1] == port
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(OSError):
                probe.bind(("127.0.0.1", port))
        finally:
            probe.close()
    finally:
        listener.close()


def test_ensure_port_free_allows_a_free_port(start_module):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    start_module.ensure_port_free("127.0.0.1", port)


def test_start_server_refuses_an_occupied_port_and_keeps_the_listener_alive(
    start_module, monkeypatch
):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    launched = []
    monkeypatch.setattr(
        start_module.uvicorn,
        "run",
        lambda *args, **kwargs: launched.append((args, kwargs)),
    )
    try:
        with pytest.raises(start_module.PortInUseError):
            start_module.start_server("127.0.0.1", port)
    finally:
        listener.close()

    assert launched == [], "occupied port must fail before uvicorn is started"


def test_run_network_mode_keeps_the_requested_host_and_port(start_module, monkeypatch):
    calls = []
    monkeypatch.setattr(
        start_module, "start_server", lambda host, port: calls.append((host, port))
    )

    # run_network_mode 会 setdefault IA_AUTH_ENABLE=1。测试结束后必须把它恢复成
    # 原始状态（包括原本不存在），否则后续 API 测试会意外开启鉴权。
    saved_auth = os.environ.pop("IA_AUTH_ENABLE", None)
    try:
        start_module.run_network_mode(19531)
    finally:
        if saved_auth is None:
            os.environ.pop("IA_AUTH_ENABLE", None)
        else:
            os.environ["IA_AUTH_ENABLE"] = saved_auth

    assert calls == [("0.0.0.0", 19531)]
