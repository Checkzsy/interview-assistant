"""Replay the original saved small -> medium STT switch against real production boundaries.

Real: FastAPI lifespan wiring, config route reconciliation, managed preparation
lane + attempt/role state, /api/stt/test protocol, /stt/status, WS init/ping-pong
fan-out, assist start/stop routes and recording-group isolation.

Substituted at the outermost boundary only: model file resolution/native model
construction and inference (Event-gated), audio device I/O, and unrelated
lifespan side effects (persisted config, DB, resume, unrelated workers).
No server, download, microphone, model cache, or config write.
"""

from __future__ import annotations

import importlib
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

common_router = importlib.import_module("api.common.router")
assist_routes = importlib.import_module("api.assist.routes")
pipeline = importlib.import_module("api.assist.pipeline")
ws_mod = importlib.import_module("api.realtime.ws")
core_config = importlib.import_module("core.config")
core_session = importlib.import_module("core.session")
audio_mod = importlib.import_module("services.audio")
engines = importlib.import_module("services.stt.engines")
factory = importlib.import_module("services.stt.factory")


def _wait(predicate, timeout=10.0, message="production worker did not reach the expected state"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    assert predicate(), message


class _ModelBoundary:
    """Event-gated model resolver and native Whisper constructor/inference."""

    TOTAL_BYTES = 1_528_000_000

    def __init__(self, root):
        self.root = root
        self.resolving = threading.Event()
        self.start_download = threading.Event()
        self.downloading = threading.Event()
        self.finish_download = threading.Event()
        self.loading = threading.Event()
        self.finish_loading = threading.Event()
        self.inferencing = threading.Event()
        self.finish_inference = threading.Event()
        self.finish_inference.set()
        self.resolve_calls = []
        self.construct_calls = []
        self.inference_calls = []
        self.audio_reads = []
        self.prepare_threads = set()
        self.download_error = None
        self.inference_text = "SWITCH-MEDIUM-OK 这是切换后的测试转写"

    def resolve(self, size, on_progress=None):
        self.resolve_calls.append(size)
        self.prepare_threads.add(threading.current_thread())
        if size == "medium":
            self.resolving.set()
            assert self.start_download.wait(30), "test did not release the resolver gate"
            on_progress({
                "phase": "downloading",
                "filename": "model.bin",
                "downloaded_bytes": self.TOTAL_BYTES // 4,
                "total_bytes": self.TOTAL_BYTES,
                "progress": 25.0,
            })
            self.downloading.set()
            assert self.finish_download.wait(30), "test did not release the download gate"
            if self.download_error is not None:
                raise RuntimeError(self.download_error)
            on_progress({
                "phase": "downloaded",
                "filename": "model.bin",
                "downloaded_bytes": self.TOTAL_BYTES,
                "total_bytes": self.TOTAL_BYTES,
                "progress": 100.0,
            })
        return self.root / size

    def construct(self, path, **kwargs):
        size = Path(path).name
        self.construct_calls.append((size, threading.get_ident()))
        if size == "medium":
            self.loading.set()
            assert self.finish_loading.wait(30), "test did not release the native constructor gate"
        boundary = self

        class NativeModel:
            def transcribe(self, audio, **options):
                boundary.inference_calls.append((size, threading.get_ident()))
                boundary.inferencing.set()
                assert boundary.finish_inference.wait(30), "test did not release the inference gate"
                return [SimpleNamespace(text=boundary.inference_text, no_speech_prob=0.0)], None

        return NativeModel()

    def read_audio(self, path):
        self.audio_reads.append(threading.get_ident())
        return np.ones(8000, dtype=np.float32) * 0.1, 16000

    def release_all(self):
        for event in (self.start_download, self.finish_download, self.finish_loading, self.finish_inference):
            event.set()


class _CaptureBoundary(audio_mod.AudioCapture):
    """Reuse the real queue/owner/stop semantics without opening a device."""

    def __init__(self):
        super().__init__()
        self.starts = []
        self.stops = []
        self.read_started = threading.Event()
        self.release_read = threading.Event()
        self.block_first_read = False

    def start(self, device_id, on_audio=None, owner=None, mic_compatibility_mode=False):
        with self._lock:
            self.starts.append((device_id, owner))
            self._owner = owner
            self._running = True
            self._sc_stop.clear()

    def stop(self, owner=None, *, clear_queue=True):
        self.stops.append((len(self.starts), owner, clear_queue))
        super().stop(owner=owner, clear_queue=clear_queue)

    def drain_audio_chunks(self, timeout=0.1, max_chunks=None):
        if self.block_first_read and not self.read_started.is_set():
            self.read_started.set()
            assert self.release_read.wait(30), "test did not release the device read gate"
        return super().drain_audio_chunks(timeout=timeout, max_chunks=max_chunks)


class _WsClient:
    """One real TestClient WebSocket owned and closed by a single thread."""

    def __init__(self, client, label):
        self.client = client
        self.label = label
        self.frames = []
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._stop = threading.Event()
        self._session = None
        self._error = None
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"ws-{label}")

    def open(self):
        self._thread.start()
        assert self._ready.wait(15), f"websocket {self.label} did not open"
        if self._error is not None:
            raise self._error
        self.wait_for(lambda frame: frame.get("type") == "init")
        return self

    def _run(self):
        try:
            with self.client.websocket_connect("/ws") as session:
                self._session = session
                self._ready.set()
                while not self._stop.is_set():
                    frame = session.receive_json()
                    with self._lock:
                        self.frames.append(frame)
                    if frame.get("type") == "ping":
                        session.send_json({"type": "pong"})
        except Exception as exc:  # keep the failure visible through open()/frames
            self._error = exc
        finally:
            self._ready.set()
            self._closed.set()

    def send(self, payload):
        session = self._session
        assert session is not None, f"websocket {self.label} is not open"
        session.send_json(payload)

    def snapshot(self):
        with self._lock:
            return list(self.frames)

    def wait_for(self, predicate, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                match = next((frame for frame in self.frames if predicate(frame)), None)
            if match is not None:
                return match
            time.sleep(0.005)
        pytest.fail(f"expected WebSocket frame on {self.label}; saw {self.snapshot()[-6:]}")

    def close(self):
        self._stop.set()
        try:
            self.send({"type": "ping"})  # wakes the blocking receive; app answers pong
        except Exception:
            pass
        if not self._closed.wait(10):
            try:
                self._session.close()
            except Exception:
                pass
        self._thread.join(timeout=10)
        assert not self._thread.is_alive(), f"WebSocket reader {self.label} leaked"


class _Replay:
    def __init__(self, client, models, capture):
        self.client = client
        self.models = models
        self.capture = capture
        self.pool = ThreadPoolExecutor(max_workers=4)
        self.sockets = []
        self.groups = []

    # -- transport helpers ---------------------------------------------------
    def call(self, fn, *args, timeout=15.0, **kwargs):
        return self.pool.submit(fn, *args, **kwargs).result(timeout=timeout)

    def request(self, method, path, *, timeout=15.0, **kwargs):
        response = self.call(self.client.request, method, path, timeout=timeout, **kwargs)
        assert response.status_code == 200, response.text
        return response.json()

    def connect_ws(self, label="main"):
        socket = _WsClient(self.client, label).open()
        self.sockets.append(socket)
        return socket

    def ping(self, socket):
        socket.send({"type": "ping"})
        return socket.wait_for(lambda frame: frame.get("type") == "pong")

    # -- domain steps --------------------------------------------------------
    def save_medium(self):
        saved = self.request("POST", "/api/config", json={
            "stt_provider": "whisper",
            "whisper_model": "medium",
            "whisper_language": "zh",
        })
        assert self.models.resolving.wait(10), "saved selection never reached the lane resolver"
        return saved

    def test_body(self, saved, **overrides):
        return {
            "provider": "whisper",
            "model": "medium",
            "language": "zh",
            "config_version": saved["stt_config_version"],
            **overrides,
        }

    def status(self):
        return self.request("GET", "/api/stt/status")

    def state(self, size="medium"):
        states = self.status()["preparation"]["states"]
        match = next((state for state in states if state["key"] == [size, "zh"]), None)
        assert match is not None, f"no preparation state for {size}/zh in {states}"
        return match

    def start(self):
        result = self.request("POST", "/api/start", json={"device_id": 7})
        group = pipeline._recording_group
        self.groups.append(group)
        return result, group

    def stop(self):
        started = time.monotonic()
        result = self.request("POST", "/api/stop")
        return result, time.monotonic() - started

    def release_all(self):
        self.models.release_all()
        self.capture.release_read.set()

    def close(self):
        self.release_all()
        if pipeline._recording_group is not None:
            try:
                self.call(self.client.post, "/api/stop", timeout=20)
            except Exception:
                pass
        for socket in reversed(self.sockets):
            socket.close()
        self.pool.shutdown(wait=True)


@pytest.fixture
def replay(monkeypatch, tmp_path):
    factory.shutdown_preparation_lane()
    cfg = core_config.AppConfig(
        stt_provider="whisper",
        whisper_model="small",
        whisper_language="zh",
        whisper_preload=False,
        candidate_asr_enabled=False,
        assist_stop_answer_wait_sec=0,
        assist_interviewer_asr_drain_timeout_sec=0.5,
        assist_vad_min_speech_sec=0.1,
        silence_duration=0.5,
        auto_detect=False,
    )
    monkeypatch.setattr(core_config, "_config", cfg)
    monkeypatch.setattr(core_config, "_save_config", lambda _cfg: True)
    core_session.reset_session()

    main = importlib.import_module("main")
    models = _ModelBoundary(tmp_path)
    capture = _CaptureBoundary()

    monkeypatch.setattr(engines, "prepare_model_files", models.resolve)
    monkeypatch.setattr(engines.STTEngine, "_best_device", staticmethod(lambda: ("cpu", "int8")))
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=models.construct))
    monkeypatch.setattr(audio_mod, "load_wav_file", models.read_audio)
    monkeypatch.setattr(audio_mod.AudioCapture, "list_devices", staticmethod(lambda: [
        {"id": 7, "name": "replay input", "is_loopback": False},
    ]))
    monkeypatch.setattr(pipeline, "audio_capture", capture)
    monkeypatch.setattr(pipeline, "_candidate_audio_capture", _CaptureBoundary())
    for name in (
        "_recording_group", "_interview_thread", "_interviewer_asr_thread",
        "_candidate_thread", "_flush_thread", "_interviewer_runtime",
        "_last_interviewer_runtime_snapshot",
    ):
        monkeypatch.setattr(pipeline, name, None)
    for name in ("_stop_event", "_pause_event", "_candidate_flush_event", "_flush_stop_event"):
        monkeypatch.setattr(pipeline, name, threading.Event())
    monkeypatch.setattr(pipeline, "_flush_queue", queue.Queue(maxsize=10))
    pipeline.cancel_answer_work(reset_session_data=False)

    monkeypatch.setattr(ws_mod, "ws_clients", set())
    monkeypatch.setattr(ws_mod, "_loop", None)
    monkeypatch.setattr(ws_mod, "_msg_queue", None)
    monkeypatch.setattr(ws_mod, "is_auth_disabled", lambda: True)

    monkeypatch.setattr(main, "init_auth", lambda: "")
    monkeypatch.setattr(main, "is_auth_disabled", lambda: True)
    monkeypatch.setattr(main.mock_interview, "init_db", lambda: None)
    for name in ("init_background_workers", "shutdown_background_workers", "stop_translate_worker"):
        monkeypatch.setattr(main.assist, name, lambda: None)
    monkeypatch.setattr(main.assist, "init_translate_worker", lambda _broadcast: None)
    monkeypatch.setattr(importlib.import_module("services.storage.resume_history"), "restore_active_resume", lambda: False)
    monkeypatch.setattr(importlib.import_module("services.storage.paths"), "data_dir", lambda: str(tmp_path))
    monkeypatch.setattr(engines, "_prune_superseded_whisper_cache", lambda _path: None)
    monkeypatch.setattr(pipeline.review_integration, "on_assist_start", lambda **_kwargs: None)
    monkeypatch.setattr(pipeline.review_integration, "on_assist_stop", lambda _session: None)

    app = FastAPI(lifespan=main.lifespan)
    app.include_router(common_router.router, prefix="/api")
    app.include_router(assist_routes.router, prefix="/api")
    app.include_router(ws_mod.router)

    driver = None
    try:
        with TestClient(app) as client:
            driver = _Replay(client, models, capture)
            try:
                _wait(lambda: factory.get_ready("small", "zh") is not None,
                      message="lifespan preload never made the saved small model ready")
                yield driver
            finally:
                driver.close()
    finally:
        models.release_all()
        capture.release_read.set()
        factory.shutdown_preparation_lane()
        for group in driver.groups if driver is not None else []:
            for thread in (
                group.interview_thread, group.asr_thread, group.flush_thread,
                group.candidate_thread, group.gc_thread,
            ):
                if thread is not None and thread is not threading.current_thread():
                    thread.join(timeout=10)
                    assert not thread.is_alive(), "recording worker leaked from replay"
        for thread in models.prepare_threads:
            thread.join(timeout=10)
            assert not thread.is_alive(), "preparation worker leaked from replay"
        core_session.reset_session()


def test_saved_medium_rejects_attempt_id_belonging_to_previous_small_model(replay):
    """A stale pending id captured for another model must not resume the new target.

    Expected protocol: /api/stt/test validates attempt_id against the state for
    the requested provider/model/language, not any preparation state at all.
    """
    small_attempt = replay.state("small")["attempt_id"]
    assert small_attempt
    saved = replay.save_medium()

    result = replay.request("POST", "/api/stt/test", json=replay.test_body(
        saved, attempt_id=small_attempt,
    ))

    assert result.get("stale") is True, result
    assert replay.models.inference_calls == []


def test_blocked_medium_stays_pending_truthfully_and_leaves_http_ws_and_stop_free(replay):
    initial = replay.status()
    small_version = initial["config_version"]
    assert replay.state("small")["phase"] == "ready"

    saved = replay.save_medium()
    assert saved["stt_config_version"] != small_version
    assert saved["whisper_model"] == "medium"
    assert replay.state()["phase"] == "resolving"

    # A request started against the pre-save identity must be rejected.
    stale = replay.request("POST", "/api/stt/test", json=replay.test_body(
        saved, config_version=small_version,
    ))
    assert stale.get("stale") is True

    pending = replay.request("POST", "/api/stt/test", json=replay.test_body(saved))
    assert pending["ok"] is False
    assert pending["pending"] is True
    assert pending["config_version"] == saved["stt_config_version"]
    assert pending["state"]["phase"] == "resolving"
    assert pending["state"]["progress"] is None
    assert pending["attempt_id"] == pending["state"]["attempt_id"]
    assert replay.models.inference_calls == []

    # Repeating the pending test must share the attempt, not enqueue another download.
    again = replay.request("POST", "/api/stt/test", json=replay.test_body(
        saved, attempt_id=pending["attempt_id"],
    ))
    assert again["pending"] is True
    assert again["attempt_id"] == pending["attempt_id"]
    assert replay.models.resolve_calls.count("medium") == 1

    # WS init carries the same preparation source and config identity as HTTP.
    socket = replay.connect_ws()
    init = socket.wait_for(lambda frame: frame.get("type") == "init")
    assert init["stt_config_version"] == saved["stt_config_version"]
    medium_states = [
        state for state in init["stt_preparation"]["states"] if state["key"] == ["medium", "zh"]
    ]
    assert len(medium_states) == 1
    assert medium_states[0]["attempt_id"] == pending["attempt_id"]
    replay.ping(socket)

    # Real HTTP status stays responsive and byte measurements are not fabricated.
    started = time.monotonic()
    status = replay.status()
    assert time.monotonic() - started < 3.0
    assert status["loaded"] is False
    assert status["loading"] is True
    assert status["config_version"] == saved["stt_config_version"]

    replay.models.start_download.set()
    assert replay.models.downloading.wait(10)
    _wait(lambda: replay.state()["phase"] == "downloading")
    downloading = replay.state()
    assert downloading["progress"] == 25.0
    assert downloading["downloaded_bytes"] == replay.models.TOTAL_BYTES // 4
    assert downloading["total_bytes"] == replay.models.TOTAL_BYTES
    assert downloading["attempt_id"] == pending["attempt_id"]
    frame = socket.wait_for(
        lambda item: item.get("type") == "stt_preparation" and any(
            state.get("phase") == "downloading"
            for state in item.get("preparation", {}).get("states", [])
        )
    )
    assert frame["config_version"] == saved["stt_config_version"]

    # A real /stop during the download must return, and must not cancel or hide
    # the model-owned preparation (a download belongs to the model, not a session).
    stopped, elapsed = replay.stop()
    assert stopped == {"ok": True}
    assert elapsed < 8.0
    assert replay.models.finish_download.is_set() is False
    assert replay.models.download_error is None
    alive = [thread for thread in replay.models.prepare_threads if thread.is_alive()]
    assert alive, "stop killed the shared model download"
    still = replay.state()
    assert still["phase"] == "downloading"
    assert still["attempt_id"] == pending["attempt_id"]

    # Loading and ready stay truthful, then the staged test performs exactly one
    # real inference through the existing inference lock.
    replay.models.finish_download.set()
    _wait(lambda: replay.state()["phase"] == "loading")
    replay.models.finish_loading.set()
    _wait(lambda: replay.state()["phase"] == "ready")
    assert replay.state()["progress"] == 100.0
    assert replay.models.resolve_calls.count("medium") == 1
    assert [size for size, _ in replay.models.construct_calls].count("medium") == 1

    result = replay.request("POST", "/api/stt/test", json=replay.test_body(
        saved, attempt_id=pending["attempt_id"],
    ))
    assert result["ok"] is True, result
    assert replay.models.inference_text in result["text"]
    assert len(replay.models.inference_calls) == 1


def test_new_start_during_blocked_download_owns_its_own_session_after_late_ready(replay):
    saved = replay.save_medium()
    assert replay.state()["phase"] == "resolving"
    socket = replay.connect_ws()

    _start, group_a = replay.start()
    _wait(lambda: group_a.asr_thread is not None and group_a.asr_thread.is_alive())
    marker = len(socket.snapshot())

    stopped, elapsed = replay.stop()
    assert stopped == {"ok": True}
    assert elapsed < 8.0
    assert group_a.accept_results is False
    # The model preparation must survive the session it happened to overlap.
    assert replay.state("medium")["phase"] == "resolving"

    _start_b, group_b = replay.start()
    assert group_b is not group_a
    assert pipeline._recording_group is group_b
    _wait(lambda: group_b.runtime is not None)
    starts_before = len(replay.capture.starts)
    stops_before = len(replay.capture.stops)
    b_marker = len(socket.snapshot())

    replay.models.start_download.set()
    _wait(lambda: replay.state()["phase"] == "downloading")
    replay.models.finish_download.set()
    _wait(lambda: replay.state()["phase"] == "loading")
    replay.models.finish_loading.set()
    _wait(lambda: replay.state()["phase"] == "ready")

    ready_frame = socket.wait_for(
        lambda item: item.get("type") == "stt_preparation" and any(
            state.get("phase") == "ready" and state.get("key") == ["medium", "zh"]
            for state in item.get("preparation", {}).get("states", [])
        )
    )
    assert ready_frame["config_version"] == saved["stt_config_version"]
    socket.wait_for(
        lambda item: item == {"type": "stt_status", "loaded": True, "loading": False, "provider": "whisper"}
    )

    # The late model completion belongs to the model, never to the old session:
    # it must not disturb the new session's capture, runtime, or recording state.
    assert len(replay.capture.starts) == starts_before, "late ready restarted capture"
    assert len(replay.capture.stops) == stops_before, "late ready stopped the new capture"
    assert replay.capture.is_running is True
    assert replay.capture.current_owner == "assist"
    assert pipeline._recording_group is group_b
    assert group_b.stop_event.is_set() is False
    assert group_b.accept_results is True
    assert pipeline._interviewer_runtime is group_b.runtime
    session = core_session.get_session()
    assert session.is_recording is True
    assert session.is_paused is False
    assert replay.models.resolve_calls.count("medium") == 1

    late = socket.snapshot()[b_marker:]
    assert not [
        frame for frame in late
        if frame.get("type") == "recording" and frame.get("value") is False
    ], f"late model completion reported the new session as stopped: {late}"
    assert marker < b_marker


def test_new_session_ignores_late_old_asr_result_and_keeps_own_capture(replay):
    saved = replay.save_medium()
    replay.models.release_all()
    _wait(lambda: factory.get_ready("medium", "zh") is not None)

    socket = replay.connect_ws()
    marker = len(socket.snapshot())
    before_qa = len(core_session.get_session().qa_pairs)

    _start, group_a = replay.start()
    _wait(lambda: group_a.asr_thread is not None and group_a.asr_thread.is_alive())
    old_text = "OLD-SESSION-LATE-TRANSCRIPT"
    replay.models.inference_text = old_text
    replay.models.finish_inference.clear()
    replay.models.inferencing.clear()

    # Drive the real interviewer ASR worker; block inside native inference.
    now = time.monotonic()
    group_a.runtime.segment_queue.put_nowait(pipeline.InterviewerSegment(
        audio=np.ones(16000 * 2, dtype=np.float32) * 0.1,
        sample_rate=16000,
        started_mono=now - 2.0,
        ended_mono=now,
        audio_sec=2.0,
        flush_reason="silence",
        capture_is_loopback=False,
    ))
    assert replay.models.inferencing.wait(10), "old ASR never reached native inference"

    stopped, elapsed = replay.stop()
    assert stopped == {"ok": True}
    assert elapsed < 10.0
    assert group_a.accept_results is False
    assert group_a.stop_event.is_set()

    _start_b, group_b = replay.start()
    assert group_b is not group_a
    _wait(lambda: group_b.runtime is not None)
    assert pipeline._recording_group is group_b
    assert group_b.stop_event.is_set() is False
    assert replay.capture.is_running is True
    assert replay.capture.current_owner == "assist"
    starts_before = len(replay.capture.starts)
    stops_before = len(replay.capture.stops)

    # Release the former session's inference after the new session is live.
    replay.models.finish_inference.set()
    group_a.asr_thread.join(timeout=10)
    assert not group_a.asr_thread.is_alive()

    assert len(replay.capture.starts) == starts_before, "old cleanup restarted capture"
    assert len(replay.capture.stops) == stops_before, "old cleanup stopped the new capture"
    assert replay.capture.is_running is True
    assert replay.capture.current_owner == "assist"
    assert pipeline._recording_group is group_b
    assert group_b.stop_event.is_set() is False
    assert pipeline._interviewer_runtime is group_b.runtime

    session = core_session.get_session()
    assert session.is_recording is True
    assert session.is_paused is False
    assert old_text not in session.transcription_history
    assert len(session.qa_pairs) == before_qa

    late = socket.snapshot()[marker:]
    assert not [
        frame for frame in late
        if frame.get("type") == "transcription" or old_text in str(frame.get("text", ""))
    ]
    assert saved["whisper_model"] == "medium"
