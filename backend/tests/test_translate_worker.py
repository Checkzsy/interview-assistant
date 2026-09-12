"""实时翻译 worker 的单元测试（不依赖 main.py 或真实模型）。"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from api.assist import translate_worker as tw


def _wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def worker(monkeypatch):
    tw.stop_translate_worker()
    broadcasts: list[dict] = []
    tw.init_translate_worker(broadcasts.append)
    yield broadcasts
    tw.stop_translate_worker()


def test_submit_rejects_empty(worker):
    assert tw.submit_translation(0, "text", "zh") is False
    assert tw.submit_translation(-5, "text", "zh") is False
    assert tw.submit_translation(1, "", "zh") is False
    assert tw.submit_translation(1, "   ", "zh") is False


def test_worker_translates_and_broadcasts(worker, monkeypatch):
    monkeypatch.setattr(tw, "_translate_text", lambda text, lang: f"translated:{text}")
    assert tw.submit_translation(42, "hello", "zh") is True
    assert _wait_for(
        lambda: any(m.get("type") == "transcription_translated" for m in worker)
    )
    translated = next(m for m in worker if m.get("type") == "transcription_translated")
    assert translated == {
        "type": "transcription_translated",
        "seq": 42,
        "text": "translated:hello",
    }


def test_worker_broadcasts_error_on_translate_exception(worker, monkeypatch):
    def boom(text, lang):
        raise RuntimeError("boom")

    monkeypatch.setattr(tw, "_translate_text", boom)
    assert tw.submit_translation(7, "hello", "zh") is True
    assert _wait_for(
        lambda: any(m.get("type") == "transcription_translate_error" for m in worker)
    )
    error = next(m for m in worker if m.get("type") == "transcription_translate_error")
    assert error == {"type": "transcription_translate_error", "seq": 7}


def test_queue_bounded(worker, monkeypatch):
    q = tw._translate_queue
    assert q is not None
    assert q.maxsize == 32

    started = threading.Event()
    release = threading.Event()

    def blocking_translate(text, lang):
        started.set()
        release.wait(5)
        return "x"

    monkeypatch.setattr(tw, "_translate_text", blocking_translate)
    assert tw.submit_translation(1, "first", "zh") is True
    assert started.wait(2.0), "worker should pick up the first item"

    accepted = 0
    for i in range(2, 1001):
        if tw.submit_translation(i, f"text-{i}", "zh"):
            accepted += 1
        else:
            break
    assert accepted == 32
    assert tw.submit_translation(9999, "full", "zh") is False
    release.set()
