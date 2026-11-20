"""Exercise real stdin pipes and real uvicorn binding without user state."""
from __future__ import annotations

import os
import queue
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
FIXTURE = BACKEND_DIR / 'tests' / 'fixtures' / 'managed_backend.py'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def spawn_fixture(tmp_path, **overrides):
    env = {
        **os.environ,
        'PYTHONPATH': str(BACKEND_DIR),
        'PYTHONUNBUFFERED': '1',
        'IA_MANAGED_BACKEND': '1',
        'IA_BACKEND_LAUNCH_ID': 'fixture-owned-launch',
        'IA_AUTH_DISABLE': '1',
        'IA_FIXTURE_SHUTDOWN': str(tmp_path / 'shutdown.txt'),
        'PORT': str(free_port()),
        **overrides,
    }
    proc = subprocess.Popen(
        [sys.executable, str(FIXTURE)], cwd=BACKEND_DIR.parent, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace',
    )
    lines = []
    events = queue.Queue()

    def collect():
        for line in proc.stdout:
            lines.append(line)
            events.put(line.rstrip())

    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    return proc, lines, events, reader


def wait_line(events, target, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            line = events.get(timeout=max(0.01, deadline - time.monotonic()))
        except queue.Empty:
            break
        if line == target:
            return
    raise AssertionError(f'did not receive {target!r}')


def cleanup_owned(proc, reader):
    if proc.poll() is None:
        proc.kill()
        proc.wait(timeout=5)
    reader.join(timeout=2)


def assert_no_buffered_stdin_fatal(code, lines):
    """Managed startup failures must not crash in BufferedReader finalization."""
    output = ''.join(lines)
    assert code != 0, output
    assert code != 0xC0000005, 'buffered stdin finalize crash (0xC0000005): ' + output
    assert '_enter_buffered_busy' not in output, output
    assert 'Fatal Python error' not in output, output


def test_real_pipe_eof_runs_lifespan_shutdown_and_archives_synthetic_sqlite(tmp_path):
    database = tmp_path / 'fixture.db'
    proc, lines, events, reader = spawn_fixture(tmp_path, IA_FIXTURE_DB=str(database))
    try:
        wait_line(events, 'IA_BACKEND_READY fixture-owned-launch')
        proc.stdin.close()
        assert proc.wait(timeout=8) == 0
        reader.join(timeout=2)
        assert (tmp_path / 'shutdown.txt').read_text() == 'lifespan shutdown complete'
        with sqlite3.connect(database) as conn:
            assert conn.execute('select text from archive').fetchall() == [('synthetic active turn',)]
        assert sum('IA_BACKEND_READY' in line for line in lines) == 1
    finally:
        cleanup_owned(proc, reader)


def test_parent_eof_during_app_import_never_binds_or_announces_ready(tmp_path):
    proc, lines, events, reader = spawn_fixture(tmp_path, IA_FIXTURE_IMPORT_DELAY='0.3')
    try:
        wait_line(events, 'IA_FIXTURE_IMPORT_STARTED')
        proc.stdin.close()
        assert proc.wait(timeout=8) == 0
        reader.join(timeout=2)
        assert not any('IA_BACKEND_READY' in line for line in lines)
        assert not (tmp_path / 'shutdown.txt').exists(), 'server must not enter lifespan after parent loss during import'
    finally:
        cleanup_owned(proc, reader)


def test_bind_failure_emits_no_ready_and_never_kills_unrelated_listener(tmp_path):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        proc, lines, _events, reader = spawn_fixture(tmp_path, PORT=str(port))
        try:
            # stdin 保持打开：正是这个条件曾在 Windows finalize 阶段触发
            # _enter_buffered_busy / 0xC0000005。
            code = proc.wait(timeout=8)
            reader.join(timeout=2)
            assert_no_buffered_stdin_fatal(code, lines)
            assert not any('IA_BACKEND_READY' in line for line in lines)
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                pass
            assert listener.getsockname()[1] == port
        finally:
            cleanup_owned(proc, reader)


def test_app_load_failure_exits_cleanly_while_managed_stdin_stays_open(tmp_path):
    proc, lines, _events, reader = spawn_fixture(tmp_path, IA_FIXTURE_LOAD_FAIL='1')
    try:
        code = proc.wait(timeout=8)
        reader.join(timeout=2)
        assert_no_buffered_stdin_fatal(code, lines)
        assert 'fixture app load failed' in ''.join(lines)
    finally:
        cleanup_owned(proc, reader)
