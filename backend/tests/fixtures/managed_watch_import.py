"""Fixture: start the managed stdin watch, then import a C-extension package.

Regression cover for the v1.4.0 startup hang. A synchronous read parked on the
inherited Windows stdin pipe held a CRT pipe read outstanding, which stalled the
DLL loader when numpy's extension modules were imported -- so `from main import
app` never completed while Electron kept the pipe open, and the 40s readiness
timeout surfaced as 「应用无法启动」.

The parent keeps stdin open for the whole test; only a watcher that never parks
a blocking read can let the import finish promptly.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.server_runner import ManagedParentMonitor

manager = ManagedParentMonitor()
manager.start_stdin_watch()
started = time.monotonic()
import numpy  # noqa: E402,F401

print(f'WATCH_IMPORT numpy={time.monotonic() - started:.2f}', flush=True)
manager.finish()
