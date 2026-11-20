"""Small ASGI application for isolated managed-process tests.

No interview workers, models, real config or database paths are imported.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from core.server_runner import run_managed


@asynccontextmanager
async def lifespan(_app):
    database = os.environ.get('IA_FIXTURE_DB')
    if database:
        with sqlite3.connect(database) as conn:
            conn.execute('create table if not exists turns (text text)')
            conn.execute('insert into turns values (?)', ('synthetic active turn',))
    yield
    if database:
        with sqlite3.connect(database) as conn:
            conn.execute('create table if not exists archive (text text)')
            conn.execute('insert into archive select text from turns')
    marker = os.environ.get('IA_FIXTURE_SHUTDOWN')
    if marker:
        Path(marker).write_text('lifespan shutdown complete', encoding='utf-8')


app = FastAPI(lifespan=lifespan)


@app.get('/api/options')
async def options():
    return {'fixture': True}


def load_fixture():
    delay = float(os.environ.get('IA_FIXTURE_IMPORT_DELAY', '0'))
    if delay:
        import time
        print('IA_FIXTURE_IMPORT_STARTED', flush=True)
        time.sleep(delay)
    if os.environ.get('IA_FIXTURE_LOAD_FAIL'):
        raise RuntimeError('fixture app load failed')
    return app


if __name__ == '__main__':
    run_managed(
        host='127.0.0.1', port=int(os.environ['PORT']), access_log=False,
        app_loader=load_fixture,
    )
    exited = os.environ.get('IA_FIXTURE_EXITED')
    if exited:
        Path(exited).write_text('runner returned', encoding='utf-8')
