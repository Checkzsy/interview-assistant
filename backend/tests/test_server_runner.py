"""Managed backend runner: stdin EOF watchdog + launch-ready marker.

These tests drive the runner without uvicorn's real server loop by injecting a
fake server object, so they are deterministic and do not bind ports.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import server_runner


@pytest.fixture(autouse=True)
def no_real_exit_timer(monkeypatch):
    monkeypatch.setattr(
        server_runner.ManagedParentMonitor, '_threaded_timer',
        staticmethod(lambda _delay, _fn: None),
    )


class FakeServer:
    def __init__(self) -> None:
        self.started = False
        self.should_exit = False
        self.force_exit = False

    def mark_started(self) -> None:
        self.started = True


def run(coro):
    return asyncio.run(coro)


def test_manager_requests_exit_when_parent_stdin_reaches_eof():
    scheduled = []
    manager = server_runner.ManagedParentMonitor(
        exited=asyncio.Event(),
        schedule=lambda delay, fn: scheduled.append((delay, fn)),
        hard_exit=lambda: None,
    )

    manager.note_eof()

    assert manager.exited.is_set() is True, "the event records that the parent was lost"
    assert manager.parent_lost() is True
    assert scheduled and scheduled[0][0] == pytest.approx(server_runner.EXIT_GRACE_SECONDS)


def test_parent_loss_before_server_construction_blocks_startup():
    manager = server_runner.ManagedParentMonitor(exited=asyncio.Event())

    manager.note_eof()
    server = FakeServer()
    applied = manager.bind_subject(server)

    assert applied is True
    assert server.should_exit is True, "a lost parent must not start serving"


def test_parent_loss_after_server_construction_sets_should_exit():
    manager = server_runner.ManagedParentMonitor(exited=asyncio.Event())
    server = FakeServer()
    manager.bind_subject(server)

    manager.note_eof()

    assert server.should_exit is True


def test_ready_marker_is_only_emitted_once_server_reports_started(monkeypatch):
    emitted = []
    manager = server_runner.ManagedParentMonitor(
        exited=asyncio.Event(),
        launch_id="launch-test1",
        emit=lambda line: emitted.append(line),
    )
    server = FakeServer()
    manager.bind_subject(server)

    async def scenario() -> None:
        task = asyncio.create_task(manager.watch_ready(interval_ms=5))
        await asyncio.sleep(0.03)
        assert emitted == [], "no marker before the server actually binds"

        server.mark_started()
        await asyncio.sleep(0.03)
        server.should_exit = True
        await asyncio.sleep(0.03)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    run(scenario())

    assert emitted == ["IA_BACKEND_READY launch-test1"]


def test_ready_marker_is_not_emitted_when_exit_was_requested_first():
    emitted = []
    manager = server_runner.ManagedParentMonitor(
        exited=asyncio.Event(),
        launch_id="launch-test2",
        emit=lambda line: emitted.append(line),
    )
    server = FakeServer()
    manager.bind_subject(server)

    async def scenario() -> None:
        task = asyncio.create_task(manager.watch_ready(interval_ms=5))
        manager.note_eof()
        server.mark_started()
        await asyncio.sleep(0.03)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    run(scenario())

    assert emitted == [], "a server already heading for exit must not announce readiness"


def test_exit_deadline_counts_from_eof_not_from_process_start(monkeypatch):
    from core import server_runner as runner_module

    scheduled = []
    killed = []
    manager = runner_module.ManagedParentMonitor(
        exited=asyncio.Event(),
        exit_grace_seconds=20.0,
        schedule=lambda delay, fn: scheduled.append((delay, fn)),
        hard_exit=lambda: killed.append(True),
    )

    manager.note_eof()

    assert scheduled and scheduled[0][0] == pytest.approx(20.0)
    scheduled[0][1]()
    assert killed == [True]


def test_normal_exit_cancels_the_parent_loss_deadline():
    scheduled = []
    killed = []
    manager = server_runner.ManagedParentMonitor(
        schedule=lambda delay, fn: scheduled.append((delay, fn)),
        hard_exit=lambda: killed.append(True),
    )
    manager.note_eof()
    manager.finish()
    scheduled[0][1]()
    assert killed == []


def test_runner_starts_eof_watch_before_loading_app_and_rechecks_after_construction(monkeypatch):
    order = []
    server = FakeServer()
    manager = server_runner.ManagedParentMonitor(schedule=lambda *_args: None)
    monkeypatch.setenv(server_runner.MANAGED_ENV, '1')
    monkeypatch.setattr(server_runner, 'ManagedParentMonitor', lambda **_kwargs: manager)
    monkeypatch.setattr(manager, 'start_stdin_watch', lambda: order.append('watch'))

    def load_app():
        order.append('import')
        manager.note_eof()
        return object()

    import uvicorn
    monkeypatch.setattr(uvicorn, 'Config', lambda *_args, **_kwargs: object())
    monkeypatch.setattr(uvicorn, 'Server', lambda _cfg: order.append('construct') or server)

    server_runner.run_managed(
        host='127.0.0.1', port=18080, access_log=False,
        app_loader=load_app, log_config={},
    )
    assert order == ['watch', 'import', 'construct']
    assert server.should_exit is True


def test_watch_stdin_ignores_binary_noise_and_flags_eof(monkeypatch):
    read_fd, write_fd = os.pipe()
    with os.fdopen(read_fd, 'rb') as reader:
        monkeypatch.setattr(sys, 'stdin', reader)
        manager = server_runner.ManagedParentMonitor(
            schedule=lambda _delay, _fn: None,
        )
        thread = manager.start_stdin_watch()
        os.write(write_fd, b'noise')
        os.close(write_fd)
        thread.join(timeout=2)
        assert not thread.is_alive()
        assert manager.parent_lost() is True
        manager.finish()


@pytest.mark.parametrize('stdin', [None, object()])
def test_invalid_managed_stdin_fails_startup(monkeypatch, stdin):
    monkeypatch.setattr(sys, 'stdin', stdin)
    manager = server_runner.ManagedParentMonitor()
    with pytest.raises(RuntimeError, match='valid stdin pipe'):
        manager.start_stdin_watch()


def test_regular_file_is_not_accepted_as_managed_stdin(monkeypatch, tmp_path):
    fake_stdin = tmp_path / 'stdin.txt'
    fake_stdin.write_text('not a pipe')
    with fake_stdin.open('rb') as reader:
        monkeypatch.setattr(sys, 'stdin', reader)
        with pytest.raises(RuntimeError, match='valid stdin pipe'):
            server_runner.ManagedParentMonitor().start_stdin_watch()


def test_non_managed_process_never_arms_the_watchdog(monkeypatch):
    armed = []
    monkeypatch.setenv(server_runner.MANAGED_ENV, "0")
    runner_module = server_runner

    def fake_watch(self):
        armed.append(True)

    monkeypatch.setattr(runner_module.ManagedParentMonitor, "watch_stdin", fake_watch)

    assert runner_module.should_watch_stdin() is False


def test_run_managed_applies_redacting_uvicorn_log_config_at_runtime(monkeypatch):
    import uvicorn
    from core import logger

    sentinel = {'version': 1, 'handlers': {}}
    captured = {}
    monkeypatch.setenv(server_runner.MANAGED_ENV, '0')
    monkeypatch.setattr(logger, 'uvicorn_log_config', lambda: sentinel)

    class FakeConfig:
        def __init__(self, app, **kwargs):
            captured['app'] = app
            captured.update(kwargs)

    class FakeServer:
        def __init__(self, config):
            self.started = False
            self.should_exit = False
            self.force_exit = False

        async def serve(self):
            return

    monkeypatch.setattr(uvicorn, 'Config', FakeConfig)
    monkeypatch.setattr(uvicorn, 'Server', FakeServer)

    app = object()
    server_runner.run_managed(app, host='127.0.0.1', port=18080, access_log=False)

    assert captured['app'] is app
    assert captured['log_config'] is sentinel, 'uvicorn must receive the redacting config object'
    assert captured['access_log'] is False


def test_stdin_watch_reads_raw_fd_not_the_buffered_wrapper(monkeypatch):
    read_fd, write_fd = os.pipe()

    class FakeBuffer:
        def fileno(self):
            return read_fd

        def read(self, _size):
            raise AssertionError('buffered stdin reads can deadlock interpreter finalize')

    class FakeStdin:
        buffer = FakeBuffer()

    monkeypatch.setattr(sys, 'stdin', FakeStdin())
    manager = server_runner.ManagedParentMonitor()
    try:
        thread = manager.start_stdin_watch()
        os.write(write_fd, b'noise')
        os.close(write_fd)
        thread.join(timeout=2)
        assert not thread.is_alive()
        assert manager.parent_lost() is True
    finally:
        manager.finish()
        os.close(read_fd)
