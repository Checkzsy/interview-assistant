from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import importlib
import sys
import threading
from types import SimpleNamespace

import anyio.to_thread
import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

common_router = importlib.import_module("api.common.router")
ws_mod = importlib.import_module("api.realtime.ws")
assist_pipeline = importlib.import_module("api.assist.pipeline")
audio_mod = importlib.import_module("services.audio")


class DummyUpload:
    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self._content = content
        self._pos = 0

    async def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            chunk = self._content[self._pos:]
            self._pos = len(self._content)
            return chunk
        chunk = self._content[self._pos : self._pos + size]
        self._pos += len(chunk)
        return chunk


def test_api_upload_resume_offloads_blocking_work_to_threadpool(monkeypatch):
    called: dict[str, object] = {}

    def fake_add_upload(content: bytes, filename: str):
        return {"ok": True, "filename": filename, "size": len(content)}

    async def fake_run_in_threadpool(fn, *args, **kwargs):
        called["fn"] = fn
        called["args"] = args
        called["kwargs"] = kwargs
        return fn(*args, **kwargs)

    monkeypatch.setattr(common_router, "add_upload", fake_add_upload)
    monkeypatch.setattr(common_router, "run_in_threadpool", fake_run_in_threadpool)

    class _Req:
        headers = {"content-length": "11"}

    result = asyncio.run(
        common_router.api_upload_resume(_Req(), DummyUpload("resume.txt", b"hello world"))
    )

    assert called["fn"] is fake_add_upload
    assert called["args"] == (b"hello world", "resume.txt")
    assert result["ok"] is True


def test_broadcast_counts_and_drops_when_queue_is_full(monkeypatch):
    class InlineLoop:
        def call_soon_threadsafe(self, callback, *args):
            callback(*args)

    class FullQueue:
        def put_nowait(self, data):
            raise asyncio.QueueFull

    monkeypatch.setattr(ws_mod, "_loop", InlineLoop())
    monkeypatch.setattr(ws_mod, "_msg_queue", FullQueue())
    monkeypatch.setattr(ws_mod, "_broadcast_drop_count", 0, raising=False)

    ws_mod.broadcast({"type": "audio_level", "value": 0.42})

    assert ws_mod._broadcast_drop_count == 1


def test_submit_knowledge_record_uses_bounded_worker(monkeypatch):
    submitted: list[tuple[object, ...]] = []

    class FakeWorker:
        def submit(self, *args: object) -> bool:
            submitted.append(args)
            return True

    monkeypatch.setattr(assist_pipeline, "_knowledge_worker", FakeWorker(), raising=False)

    assert assist_pipeline._submit_knowledge_record("说说 Redis 持久化", "先讲 RDB，再讲 AOF", "qa-1", "我讲了 RDB") is True
    assert submitted == [("save", "说说 Redis 持久化", "先讲 RDB，再讲 AOF", "qa-1", "我讲了 RDB")]


def _stt_test_app(monkeypatch, engine):
    cfg = SimpleNamespace(stt_provider="whisper")
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: engine)
    monkeypatch.setattr(common_router.Path, "exists", lambda self: True)
    monkeypatch.setattr(audio_mod, "load_wav_file", lambda *args: (np.zeros(160, dtype=np.float32), 16000))
    app = FastAPI()
    app.include_router(common_router.router, prefix="/api")

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    return app, cfg


def test_stt_test_keeps_http_ws_and_real_stop_responsive(monkeypatch):
    from core.session import Session

    assist_routes = importlib.import_module("api.assist.routes")
    entered = threading.Event()
    release = threading.Event()
    calls = []
    caller_thread = threading.get_ident()
    session = Session(is_recording=True)
    stops = []
    audio_threads = []

    class Engine:
        is_loaded = True

        def transcribe(self, audio, **kwargs):
            calls.append((threading.get_ident(), kwargs))
            entered.set()
            assert release.wait(8), "test did not release inference"
            return "测试文本"

    engine = Engine()
    app, _ = _stt_test_app(monkeypatch, engine)

    def read_audio(*args, **kwargs):
        audio_threads.append(threading.get_ident())
        return np.zeros(160, dtype=np.float32), 16000

    monkeypatch.setattr(audio_mod, "load_wav_file", read_audio)
    app.include_router(assist_routes.router, prefix="/api")
    app.include_router(ws_mod.router)
    monkeypatch.setattr(ws_mod, "_ws_authorized", lambda ws: True)
    monkeypatch.setattr(ws_mod, "get_stt_engine", lambda: engine)
    monkeypatch.setattr(ws_mod, "snapshot_session", session.snapshot)
    monkeypatch.setattr(ws_mod, "ws_clients", set())
    monkeypatch.setattr(assist_pipeline, "get_session", lambda: session)
    monkeypatch.setattr(assist_pipeline, "get_config", lambda: SimpleNamespace(assist_stop_answer_wait_sec=0))
    for name in ("_interview_thread", "_interviewer_asr_thread", "_candidate_thread", "_flush_thread", "_interviewer_runtime"):
        monkeypatch.setattr(assist_pipeline, name, None)
    monkeypatch.setattr(assist_pipeline, "_stop_event", threading.Event())
    monkeypatch.setattr(assist_pipeline, "_pause_event", threading.Event())
    monkeypatch.setattr(assist_pipeline, "_candidate_flush_event", threading.Event())
    capture = SimpleNamespace(stop=lambda **kwargs: stops.append(kwargs))
    monkeypatch.setattr(assist_pipeline, "audio_capture", capture)
    monkeypatch.setattr(assist_pipeline, "_candidate_audio_capture", capture)
    monkeypatch.setattr(assist_pipeline, "_try_flush_asr_merge_buffer", lambda *args: None)
    monkeypatch.setattr(assist_pipeline, "_try_flush_asr_question_group", lambda *args: None)
    monkeypatch.setattr(assist_pipeline, "cancel_answer_work", lambda **kwargs: None)
    monkeypatch.setattr(assist_pipeline.review_integration, "on_assist_stop", lambda session: None)
    monkeypatch.setattr(assist_pipeline, "broadcast", lambda data: None)

    with TestClient(app) as client, ThreadPoolExecutor(max_workers=3) as requests:
        first = requests.submit(client.post, "/api/stt/test")
        try:
            assert entered.wait(2), "inference did not start"
            monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("busy request acquired engine"))
            assert requests.submit(client.get, "/ping").result(timeout=2).json() == {"ok": True}
            second = requests.submit(client.post, "/api/stt/test").result(timeout=2).json()
            assert second["ok"] is False
            assert "繁忙" in second["detail"]
            with client.websocket_connect("/ws") as ws:
                assert ws.receive_json()["type"] == "init"
                ws.send_json({"type": "ping"})
                assert ws.receive_json() == {"type": "pong"}
            assert requests.submit(client.post, "/api/stop").result(timeout=2).json() == {"ok": True}
            assert session.is_recording is False
            assert len(stops) == 2
            assert len(calls) == 1
            assert calls[0][0] != caller_thread
            assert audio_threads == [calls[0][0]]
            assert calls[0][1] == {"sample_rate": 16000}
        finally:
            release.set()
            first_result = first.result(timeout=3)
        assert first_result.json() == {"ok": True, "text": "测试文本"}


def test_stt_test_cancellation_does_not_release_running_inference(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    calls = []

    class Engine:
        def transcribe(self, audio, **kwargs):
            calls.append(1)
            entered.set()
            try:
                assert release.wait(5)
                return "成功"
            finally:
                finished.set()

    app, _ = _stt_test_app(monkeypatch, Engine())

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            request = asyncio.create_task(client.post("/api/stt/test"))
            try:
                async with asyncio.timeout(2):
                    while not entered.is_set():
                        await asyncio.sleep(0.01)
                request.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await request
                second = await client.post("/api/stt/test")
                assert second.json()["ok"] is False
                assert "繁忙" in second.json()["detail"]
                assert calls == [1]
            finally:
                release.set()
                await asyncio.gather(request, return_exceptions=True)
            async with asyncio.timeout(2):
                while not finished.is_set():
                    await asyncio.sleep(0.01)
            # Wait for the real wrapper's finally, not just transcribe's finally.
            async with asyncio.timeout(2):
                while True:
                    response = (await client.post("/api/stt/test")).json()
                    if response.get("ok"):
                        break
                    assert "繁忙" in response["detail"]
                    await asyncio.sleep(0.01)
            assert response == {"ok": True, "text": "成功"}
            assert calls == [1, 1]

    asyncio.run(scenario())


def test_stt_test_cancelled_before_worker_start_returns_admission(monkeypatch):
    calls = []
    engine = SimpleNamespace(transcribe=lambda *args, **kwargs: calls.append(1) or "成功")
    app, _ = _stt_test_app(monkeypatch, engine)

    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        old_tokens = limiter.total_tokens
        limiter.total_tokens = 1
        await limiter.acquire()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            request = asyncio.create_task(client.post("/api/stt/test"))
            try:
                await asyncio.sleep(0.05)
                assert not request.done()
                second = await asyncio.wait_for(client.post("/api/stt/test"), timeout=1)
                assert "繁忙" in second.json()["detail"]
                assert limiter.statistics().tasks_waiting == 1
                request.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await request
                assert calls == []
            finally:
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)
                limiter.release()
                limiter.total_tokens = old_tokens
            response = await asyncio.wait_for(client.post("/api/stt/test"), timeout=2)
            assert response.json() == {"ok": True, "text": "成功"}
            assert calls == [1]

    asyncio.run(scenario())


def test_stt_test_captures_engine_before_worker_dispatch(monkeypatch):
    captured = threading.Event()
    calls = []
    engine = SimpleNamespace(transcribe=lambda *args, **kwargs: calls.append(1) or "原引擎")
    app, cfg = _stt_test_app(monkeypatch, engine)

    def get_engine():
        captured.set()
        return engine

    monkeypatch.setattr(common_router, "get_stt_engine", get_engine)

    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        old_tokens = limiter.total_tokens
        limiter.total_tokens = 1
        await limiter.acquire()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            request = asyncio.create_task(client.post("/api/stt/test"))
            try:
                async with asyncio.timeout(2):
                    while not captured.is_set():
                        await asyncio.sleep(0.01)
                assert calls == []
                cfg.stt_provider = "generic"
                monkeypatch.setattr(common_router, "get_config", lambda: pytest.fail("worker re-read config"))
                monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("worker re-read engine"))
            finally:
                limiter.release()
                limiter.total_tokens = old_tokens
            result = await asyncio.wait_for(request, timeout=2)
            assert result.json() == {"ok": True, "text": "原引擎"}
            assert calls == [1]

    asyncio.run(scenario())


def test_stt_test_worker_schedule_failure_returns_admission(monkeypatch):
    calls = []
    engine = SimpleNamespace(transcribe=lambda *args, **kwargs: calls.append(1) or "成功")
    app, _ = _stt_test_app(monkeypatch, engine)
    original_start = threading.Thread.start

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            with monkeypatch.context() as patch:
                def fail_start(self):
                    raise RuntimeError("worker start failed")

                patch.setattr(threading.Thread, "start", fail_start)
                result = (await client.post("/api/stt/test")).json()
                assert result == {"ok": False, "detail": "worker start failed"}
                assert calls == []
            assert threading.Thread.start is original_start
            assert (await client.post("/api/stt/test")).json() == {"ok": True, "text": "成功"}
            assert calls == [1]

    asyncio.run(scenario())
