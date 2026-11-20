"""Managed backend runner used by entrypoint.py and start.py.

The Electron main process owns this backend: it spawns us with stdin as a pipe
and expects a readiness marker on stdout once uvicorn has actually bound. If the
parent dies (stdin EOF), we keep serving long enough for in-flight work to
finish, then exit on our own. The watchdog starts when the runner is called,
not at import time, so a backend launched directly (network mode, tests) never
self-terminates.
"""

from __future__ import annotations

import asyncio
import os
import stat
import sys
import threading
from typing import Callable, Optional

MANAGED_ENV = "IA_MANAGED_BACKEND"
READY_PREFIX = "IA_BACKEND_READY "
EXIT_GRACE_SECONDS = 20.0


def should_watch_stdin(environ: Optional[dict] = None) -> bool:
    """Only the managed child (stdin piped by our Electron main) gets a watchdog."""
    env = os.environ if environ is None else environ
    return env.get(MANAGED_ENV, "").strip().lower() in ("1", "true", "yes")


def launch_id_from_env(environ: Optional[dict] = None) -> str:
    env = os.environ if environ is None else environ
    return env.get("IA_BACKEND_LAUNCH_ID", "").strip()


class ManagedParentMonitor:
    """Tracks parent loss and readiness for one uvicorn.Server instance."""

    def __init__(
        self,
        exited: Optional[threading.Event] = None,
        launch_id: str = "",
        emit: Optional[Callable[[str], None]] = None,
        exit_grace_seconds: float = EXIT_GRACE_SECONDS,
        schedule: Optional[Callable[[float, Callable[[], None]], None]] = None,
        hard_exit: Optional[Callable[[], None]] = None,
    ) -> None:
        # threading.Event: 读取线程与 asyncio 线程共用，不绑定某个 loop。
        self.exited = exited if exited is not None else threading.Event()
        self.launch_id = launch_id
        self._emit = emit or self._write_stdout
        self._exit_grace_seconds = exit_grace_seconds
        self._schedule = schedule or self._threaded_timer
        self._hard_exit = hard_exit or (lambda: os._exit(0))
        self._parent_lost = False
        self._server = None
        self._deadline_armed = False
        self._lock = threading.Lock()
        self._timer = None
        self._finished = False

    def finish(self) -> None:
        with self._lock:
            self._finished = True
            timer = self._timer
        if timer is not None:
            timer.cancel()

    # -- parent loss -------------------------------------------------------
    def parent_lost(self) -> bool:
        return self._parent_lost

    def note_eof(self) -> None:
        with self._lock:
            if self._parent_lost:
                return
            self._parent_lost = True
        self.exited.set()
        server = self._server
        if server is not None:
            server.should_exit = True
        self._arm_deadline()

    def start_stdin_watch(self) -> threading.Thread:
        """Read only our inherited pipe; an invalid managed pipe is a startup error."""
        stdin = sys.stdin
        if stdin is None:
            raise RuntimeError('managed backend requires a valid stdin pipe')
        reader = getattr(stdin, 'buffer', stdin)
        try:
            fd = reader.fileno()
            if not stat.S_ISFIFO(os.fstat(fd).st_mode):
                raise RuntimeError('managed backend requires a valid stdin pipe')
        except (AttributeError, OSError, ValueError) as exc:
            raise RuntimeError('managed backend requires a valid stdin pipe') from exc

        def read_loop() -> None:
            while True:
                try:
                    # 用裸 fd 而不是 stdin.buffer.read：守护线程在解释器 finalize 时
                    # 可能仍持有 BufferedReader 锁，导致 _enter_buffered_busy 崩溃。
                    chunk = os.read(fd, 4096)
                except (OSError, ValueError):
                    chunk = b''
                if not chunk:
                    self.note_eof()
                    return

        thread = threading.Thread(target=read_loop, name='ia-stdin-watch', daemon=True)
        thread.start()
        return thread

    async def watch_stdin(self) -> None:
        self.start_stdin_watch()
        while not self._parent_lost:
            await asyncio.sleep(0.01)

    def _arm_deadline(self) -> None:
        def expire() -> None:
            if not self._finished:
                self._hard_exit()

        with self._lock:
            if self._deadline_armed or self._finished:
                return
            self._deadline_armed = True
            self._timer = self._schedule(self._exit_grace_seconds, expire)

    @staticmethod
    def _threaded_timer(delay: float, fn: Callable[[], None]):
        timer = threading.Timer(delay, fn)
        timer.daemon = True
        timer.start()
        return timer

    # -- readiness ---------------------------------------------------------
    def bind_subject(self, server) -> bool:
        """Connect to the actual uvicorn.Server; re-check loss decided before construction."""
        self._server = server
        if self._parent_lost:
            server.should_exit = True
            return True
        return False

    async def watch_ready(self, interval_ms: int = 50) -> None:
        """Emit the launch marker once the server has bound and is not exiting."""
        while True:
            server = self._server
            if server is not None and server.started and not server.should_exit:
                self._emit(f"{READY_PREFIX}{self.launch_id}")
                return
            if server is not None and (server.should_exit or server.force_exit):
                return
            await asyncio.sleep(interval_ms / 1000.0)

    @staticmethod
    def _write_stdout(line: str) -> None:
        try:
            print(line, flush=True)
        except (OSError, ValueError):
            pass


def _load_app(app_loader: Optional[Callable[[], object]]):
    if app_loader is not None:
        return app_loader()
    # 字面 import 让 PyInstaller 仍能静态分析到 main；调用发生在 EOF 监测建立之后。
    from main import app  # noqa: F401
    return app


def run_managed(
    app=None,
    *,
    host: str,
    port: int,
    access_log: bool,
    log_config=None,
    app_loader: Optional[Callable[[], object]] = None,
) -> None:
    """Run uvicorn as the managed child of Electron."""
    import uvicorn

    managed = should_watch_stdin()
    monitor = ManagedParentMonitor(launch_id=launch_id_from_env())

    # 先建 EOF 监测，再加载应用：父进程可能在 import 期间就死掉。
    try:
        if managed:
            monitor.start_stdin_watch()
        if app is None:
            app = _load_app(app_loader)

        if log_config is None:
            from core.logger import uvicorn_log_config
            log_config = uvicorn_log_config()

        config = uvicorn.Config(
            app, host=host, port=port, access_log=access_log,
            reload=False, log_level='info', log_config=log_config,
        )
        server = uvicorn.Server(config)
        # 构造之后再检查：不能在构造前假定 should_exit 会保留。
        if monitor.bind_subject(server):
            return

        async def serve() -> None:
            ready_task = None
            if managed and monitor.launch_id:
                ready_task = asyncio.create_task(monitor.watch_ready())
            try:
                await server.serve()
            finally:
                if ready_task is not None:
                    ready_task.cancel()
                    await asyncio.gather(ready_task, return_exceptions=True)

        asyncio.run(serve())
    finally:
        monitor.finish()
