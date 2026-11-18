from __future__ import annotations

import importlib
import sys
import threading
import time
import types
from pathlib import Path

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.stt import engines, factory  # noqa: E402


def _wait(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    assert predicate()


@pytest.fixture
def lane(monkeypatch):
    factory.shutdown_preparation_lane()
    monkeypatch.setattr(factory, "_whisper_engines", {})
    monkeypatch.setattr(factory, "_engine", None)
    events = []
    factory.init_preparation_lane(events.append)
    yield events
    factory.shutdown_preparation_lane()


def _fake_loader(monkeypatch, *, blocked="small", fail=()):
    started = threading.Event()
    release = threading.Event()
    calls = []

    def load(engine, progress=None, retry=False):
        calls.append((engine.model_size, engine.language))
        if engine.model_size == blocked:
            started.set()
            assert release.wait(3)
        if engine.model_size in fail:
            raise RuntimeError("offline " + engine.model_size)
        engine._model = object()

    monkeypatch.setattr(engines.STTEngine, "load_model", load)
    return calls, started, release


def test_lane_singleflight_short_locks_and_automatic_advance(monkeypatch, lane):
    calls, started, release = _fake_loader(monkeypatch)
    first = factory.request_prepare("small", "zh", consumer="main")
    assert started.wait(1)
    same = factory.request_prepare("small", "zh", consumer="candidate")
    queued = factory.request_prepare("medium", "en", consumer="fallback")
    assert same["attempt_id"] == first["attempt_id"]
    assert queued["phase"] == "queued"
    assert factory._engine_lock.acquire(timeout=0.1)
    factory._engine_lock.release()
    assert factory._whisper_infer_lock.acquire(timeout=0.1)
    factory._whisper_infer_lock.release()
    assert factory.get_ready("small", "zh") is None
    release.set()
    _wait(lambda: factory.get_ready("medium", "en") is not None)
    assert calls == [("small", "zh"), ("medium", "en")]
    assert any(event["phase"] == "ready" for event in lane)


def test_pending_is_bounded_latest_per_consumer_and_merges_keys(monkeypatch, lane):
    calls, started, release = _fake_loader(monkeypatch)
    factory.request_prepare("small", "zh", consumer="main")
    assert started.wait(1)
    factory.request_prepare("tiny", "zh", consumer="main")
    factory.request_prepare("medium", "zh", consumer="main")
    factory.request_prepare("medium", "zh", consumer="candidate")
    factory.request_prepare("large-v3", "en", consumer="fallback")
    snapshot = factory.get_preparation_snapshot()
    assert len(snapshot["pending"]) <= 3
    assert {tuple(item["key"]) for item in snapshot["pending"]} == {
        ("medium", "zh"), ("large-v3", "en"),
    }
    with pytest.raises(ValueError, match="consumer"):
        factory.request_prepare("tiny", "zh", consumer="unbounded")
    release.set()
    _wait(lambda: factory.get_ready("large-v3", "en") is not None)
    assert calls == [("small", "zh"), ("medium", "zh"), ("large-v3", "en")]


def test_failure_persists_until_explicit_retry_and_lane_recovers(monkeypatch, lane):
    calls, _, release = _fake_loader(monkeypatch, blocked="none", fail={"medium"})
    release.set()
    first = factory.request_prepare("medium", "zh")
    _wait(lambda: any(event["phase"] == "error" for event in lane))
    for _ in range(5):
        state = factory.request_prepare("medium", "zh")
        assert state["phase"] == "error"
        assert state["attempt_id"] == first["attempt_id"]
    factory.request_prepare("base", "zh", consumer="candidate")
    _wait(lambda: factory.get_ready("base", "zh") is not None)
    retry = factory.request_prepare("medium", "zh", retry=True)
    assert retry["attempt_id"] != first["attempt_id"]
    _wait(lambda: calls.count(("medium", "zh")) == 2)
    assert calls.count(("medium", "zh")) == 2


def test_release_consumer_removes_obsolete_pending(monkeypatch, lane):
    calls, started, release = _fake_loader(monkeypatch)
    factory.request_prepare("small", "zh")
    assert started.wait(1)
    factory.request_prepare("medium", "en", consumer="candidate")
    factory.release_prepare_consumer("candidate")
    assert factory.get_preparation_snapshot()["pending"] == []
    release.set()
    _wait(lambda: factory.get_ready("small", "zh") is not None)
    assert calls == [("small", "zh")]


@pytest.mark.parametrize("provider,preload,expected", [
    ("whisper", False, {("medium", "en")}),
    ("generic", False, set()),
    ("generic", True, {("medium", "auto")}),
])
def test_saved_provider_reconciliation_releases_obsolete_pending_roles(monkeypatch, lane, provider, preload, expected):
    core_config = importlib.import_module("core.config")
    common_router = importlib.import_module("api.common.router")

    calls, started, release = _fake_loader(monkeypatch)
    cfg = types.SimpleNamespace(
        stt_provider=provider, whisper_model="medium",
        whisper_language="en" if provider == "whisper" else "auto",
        whisper_preload=preload, candidate_asr_enabled=False,
    )
    monkeypatch.setattr(core_config, "get_config", lambda: cfg)
    factory.request_prepare("small", "zh", consumer="fallback")
    assert started.wait(1)
    factory.request_prepare("base", "auto", consumer="fallback")
    factory.request_prepare("medium", "en", consumer="main")
    factory.request_prepare("large-v3", "en", consumer="candidate")
    try:
        common_router._reconcile_stt_preparation(cfg)
        snapshot = factory.get_preparation_snapshot()
        assert {tuple(state["key"]) for state in snapshot["pending"]} == expected
        assert not any("candidate" in state["roles"] for state in snapshot["states"])
        if provider == "whisper":
            assert not any("fallback" in state["roles"] for state in snapshot["states"])
        else:
            assert not any("main" in state["roles"] for state in snapshot["states"])
    finally:
        release.set()
    _wait(lambda: factory.get_preparation_snapshot()["active"] is None)
    assert calls[0] == ("small", "zh")
    assert set(calls[1:]) == expected


def test_failed_passive_runtime_requests_do_not_restart_preparation(monkeypatch, lane):
    calls, _, release = _fake_loader(monkeypatch, blocked="none", fail={"medium"})
    release.set()
    audio = np.zeros(16000, dtype=np.float32)
    factory.request_prepare("medium", "en")
    _wait(lambda: any(event["phase"] == "error" for event in lane))
    attempt = factory.get_preparation_snapshot()["states"][0]["attempt_id"]
    for _ in range(5):
        assert factory.transcribe_with_fallback(
            audio, 16000, provider="whisper", whisper_model="medium", whisper_language="en",
        ) == ""
        assert factory.request_prepare("medium", "en")["attempt_id"] == attempt
    assert calls == [("medium", "en")]
    assert factory.get_preparation_snapshot()["pending"] == []


def test_shutdown_discards_late_completion_and_never_waits(monkeypatch, lane):
    calls, started, release = _fake_loader(monkeypatch)
    factory.request_prepare("small", "zh")
    assert started.wait(1)
    old_engine = factory.get_stt_engine(provider="whisper", model_size="small", language="zh")
    before = time.monotonic()
    factory.shutdown_preparation_lane()
    assert time.monotonic() - before < 0.2
    release.set()
    _wait(lambda: len(calls) == 1 and not any(t.name == "stt-prepare" and t.is_alive() for t in threading.enumerate()))
    assert old_engine.get_ready() is None
    assert not any(event["phase"] == "ready" for event in lane)


def test_model_language_cache_is_stable_without_mutation(monkeypatch, lane):
    old = factory.get_stt_engine(provider="whisper", model_size="small", language="zh")
    old._model = object()
    other = factory.get_stt_engine(provider="whisper", model_size="small", language="en")
    factory.set_whisper_language("en")
    assert other is not old
    assert old.language == "zh"
    assert old.is_loaded
    assert factory.get_stt_engine(provider="whisper", model_size="small", language="zh") is old


def test_runtime_transcription_never_loads_under_inference_lock(monkeypatch, lane):
    calls, started, release = _fake_loader(monkeypatch)
    audio = np.zeros(16000, dtype=np.float32)
    assert factory.transcribe_with_fallback(audio, 16000, provider="whisper", whisper_model="small", whisper_language="zh") == ""
    assert started.wait(1)
    assert factory._whisper_infer_lock.acquire(timeout=0.1)
    factory._whisper_infer_lock.release()
    for _ in range(3):
        assert factory.transcribe_with_fallback(audio, 16000, provider="whisper", whisper_model="small", whisper_language="zh") == ""
    assert calls == [("small", "zh")]
    release.set()
    _wait(lambda: factory.get_ready("small", "zh") is not None)


def test_engine_constructor_outside_lock_and_failure_stays_terminal(tmp_path, monkeypatch):
    for name in engines._BUNDLED_WHISPER_FILES:
        (tmp_path / name).write_text("{}", encoding="utf-8")
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def construct(*args, **kwargs):
        calls.append(args)
        entered.set()
        assert release.wait(3)
        raise RuntimeError("broken model")

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = construct
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    engine = engines.STTEngine()
    errors = []

    def load():
        try:
            engine.load_model()
        except RuntimeError as error:
            errors.append(str(error))

    worker = threading.Thread(target=load, daemon=True)
    worker.start()
    assert entered.wait(1)
    assert engine._lock.acquire(timeout=0.1)
    engine._lock.release()
    release.set()
    worker.join(1)
    assert errors and "broken model" in errors[0]
    with pytest.raises(RuntimeError, match="broken model"):
        engine.load_model()
    assert len(calls) == 1
    assert engine.get_ready() is None


def test_uninitialized_lane_never_starts_implicit_load(monkeypatch):
    factory.shutdown_preparation_lane()
    calls, _, _ = _fake_loader(monkeypatch, blocked=None)
    state = factory.request_prepare("small", "zh")
    assert state["phase"] == "uninitialized"
    assert factory.get_ready("small", "zh") is None
    assert factory.get_preparation_snapshot()["runtime_id"] is None
    assert calls == []


def test_transcribe_outside_lifespan_keeps_the_legacy_synchronous_load(monkeypatch):
    """Router-only/CLI mounts have no lane; they must still be able to transcribe.

    Without the lane there is nobody to run the download, so queueing would
    return empty text on every call forever.
    """
    factory.shutdown_preparation_lane()
    sized = []

    class _Engine:
        def __init__(self):
            self.is_loaded = False
            self.model_size = "small"
            self.language = "zh"

        def load_model(self, progress=None, retry=False):
            self.is_loaded = True

    engine = _Engine()
    monkeypatch.setattr(factory, "get_stt_engine", lambda **kwargs: engine)
    monkeypatch.setattr(factory, "get_ready", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        factory,
        "_transcribe_with_whisper_lock",
        lambda eng, audio, sr, position, language, timeout=None: sized.append(eng) or "legacy-text",
    )

    assert factory._whisper_transcribe(np.zeros(1600), 16000, "interviewer", "zh", model_size="small", whisper_language="zh") == "legacy-text"
    assert engine.is_loaded is True
    assert sized == [engine]


def test_fallback_outside_lifespan_also_keeps_the_legacy_synchronous_load(monkeypatch):
    factory.shutdown_preparation_lane()
    sized = []

    class _Engine:
        def __init__(self):
            self.is_loaded = False
            self.model_size = "small"
            self.language = "zh"

        def load_model(self, progress=None, retry=False):
            self.is_loaded = True

    engine = _Engine()
    monkeypatch.setattr(factory, "get_stt_engine", lambda **kwargs: engine)
    monkeypatch.setattr(factory, "_transcribe_with_whisper_lock", lambda *args, **kwargs: sized.append(args[0]) or "ok")

    assert factory._whisper_transcribe_fallback(np.zeros(1600), 16000, "interviewer", "zh") == "ok"
    assert engine.is_loaded is True
    assert sized == [engine]


def test_fallback_queues_without_loading_when_the_lane_is_managed(monkeypatch, lane):
    loads = []

    class _Engine:
        def __init__(self):
            self.is_loaded = False
            self.model_size = "small"
            self.language = "zh"

        def load_model(self, progress=None, retry=False):
            loads.append(True)

    engine = _Engine()
    monkeypatch.setattr(factory, "get_stt_engine", lambda **kwargs: engine)

    assert factory._whisper_transcribe_fallback(np.zeros(1600), 16000, "interviewer", "zh") == ""
    assert loads == []
    assert factory.get_preparation_snapshot()["states"][0]["roles"] == ["fallback"]


def test_transcribe_with_fallback_whisper_provider_loads_outside_the_lane(monkeypatch):
    """The public entry point is a third sibling path; it needs the same rule."""
    factory.shutdown_preparation_lane()
    loads = []
    transcribed = []

    class _Engine:
        def __init__(self):
            self.is_loaded = False
            self.model_size = "small"
            self.language = "zh"

        def load_model(self, progress=None, retry=False):
            loads.append(True)
            self.is_loaded = True

        def transcribe(self, audio, sample_rate, position="", language=""):
            transcribed.append(len(audio))
            return "public-entry-text"

    engine = _Engine()
    monkeypatch.setattr(factory, "get_stt_engine", lambda *args, **kwargs: engine)
    monkeypatch.setattr("api.realtime.ws.broadcast", lambda *args, **kwargs: None)
    import core.config as config

    monkeypatch.setattr(
        config,
        "get_config",
        lambda: types.SimpleNamespace(stt_provider="whisper", whisper_model="small", whisper_language="zh"),
    )

    text = factory.transcribe_with_fallback(np.zeros(1600), 16000, provider="whisper")

    assert text == "public-entry-text"
    assert loads == [True]
    assert transcribed == [1600]


def test_transcribe_with_fallback_keeps_require_loaded_empty(monkeypatch):
    factory.shutdown_preparation_lane()

    class _Engine:
        is_loaded = False
        model_size = "small"
        language = "zh"

        def load_model(self, progress=None, retry=False):
            raise AssertionError("whisper_require_loaded must never load inline")

    monkeypatch.setattr(factory, "get_stt_engine", lambda *args, **kwargs: _Engine())
    monkeypatch.setattr("api.realtime.ws.broadcast", lambda *args, **kwargs: None)
    import core.config as config

    monkeypatch.setattr(
        config,
        "get_config",
        lambda: types.SimpleNamespace(stt_provider="whisper", whisper_model="small", whisper_language="zh"),
    )

    assert factory.transcribe_with_fallback(np.zeros(1600), 16000, provider="whisper", whisper_require_loaded=True) == ""


def test_shutdown_reinitialization_does_not_reuse_closed_default_engine(monkeypatch, lane):
    calls, _, _ = _fake_loader(monkeypatch, blocked=None)
    import core.config as config
    cfg = types.SimpleNamespace(stt_provider="whisper", whisper_model="small", whisper_language="zh")
    monkeypatch.setattr(config, "get_config", lambda: cfg)
    factory.request_prepare("small", "zh")
    _wait(lambda: factory.get_ready("small", "zh") is not None)
    old = factory.get_ready("small", "zh")
    factory.shutdown_preparation_lane()
    factory.init_preparation_lane()
    factory.request_prepare("small", "zh")
    _wait(lambda: factory.get_ready("small", "zh") is not None)
    assert factory.get_ready("small", "zh") is not old
    assert calls == [("small", "zh"), ("small", "zh")]


def test_stt_test_inference_uses_bounded_shared_lock(lane):
    engine = engines.STTEngine("small", "zh")
    engine._model = object()
    with factory._whisper_infer_lock:
        with pytest.raises(factory.WhisperInferenceBusy, match="busy"):
            factory.transcribe_whisper_for_test(engine, np.zeros(16000), timeout=0)


def test_matching_cached_engine_survives_selection_alias_reset(monkeypatch, lane):
    calls, _, _ = _fake_loader(monkeypatch, blocked=None)
    import core.config as config
    cfg = types.SimpleNamespace(stt_provider="whisper", whisper_model="small", whisper_language="zh")
    monkeypatch.setattr(config, "get_config", lambda: cfg)
    factory.request_prepare("small", "zh")
    _wait(lambda: factory.get_ready("small", "zh") is not None)
    ready = factory.get_ready("small", "zh")
    monkeypatch.setattr(factory, "_engine", None)
    assert factory.get_stt_engine() is ready
    assert calls == [("small", "zh")]


def test_passive_requests_and_throttled_progress_do_not_spam_events(monkeypatch, lane):
    def load(engine, progress=None, retry=False):
        for index in range(10):
            progress({"phase": "downloading", "downloaded_bytes": index, "total_bytes": 10, "progress": index * 10})
        engine._model = object()

    monkeypatch.setattr(engines.STTEngine, "load_model", load)
    factory.request_prepare("small", "zh")
    _wait(lambda: factory.get_ready("small", "zh") is not None)
    baseline = len(lane)
    for _ in range(5):
        state = factory.request_prepare("small", "zh")
        assert state["phase"] == "ready"
    assert len(lane) == baseline
    assert len([event for event in lane if event["phase"] == "downloading"]) < 5
    snapshot = factory.get_preparation_snapshot()
    assert snapshot["runtime_id"]
    assert all("runtime_id" not in state and "revision" not in state for state in snapshot["states"])
    factory.release_prepare_consumer("main")
    assert lane[-1]["roles"] == []


def test_engine_resolves_local_files_and_callbacks_outside_lock(tmp_path, monkeypatch):
    monkeypatch.setattr(engines, "_bundled_model_path", lambda _size: None)
    engine = engines.STTEngine("small", "en")
    events = []
    calls = []

    def resolve(size, on_progress=None):
        assert size == "small"
        assert engine._lock.acquire(timeout=0.1)
        engine._lock.release()
        on_progress({"phase": "resolving", "progress": None})
        on_progress({"phase": "downloaded", "downloaded_bytes": 50, "total_bytes": 50, "progress": 100.0})
        return tmp_path

    def construct(path, **kwargs):
        calls.append(path)
        assert engine._lock.acquire(timeout=0.1)
        engine._lock.release()
        return object()

    def progress(state):
        assert engine._lock.acquire(timeout=0.1)
        engine._lock.release()
        events.append(state)

    monkeypatch.setattr(engines, "prepare_model_files", resolve)
    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=construct))
    engine.load_model(progress=progress)
    assert calls == [str(tmp_path)]
    assert engine.get_ready() is not None
    assert events[-1]["phase"] == "ready"
    assert "downloading" not in [state["phase"] for state in events]
    engine.load_model()
    assert len(calls) == 1


def test_engine_close_discards_late_constructor_result(tmp_path, monkeypatch):
    for name in engines._BUNDLED_WHISPER_FILES:
        (tmp_path / name).write_text("{}", encoding="utf-8")
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path)
    entered, release = threading.Event(), threading.Event()

    def construct(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return object()

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=construct))
    engine = engines.STTEngine()
    events = []
    worker = threading.Thread(target=lambda: engine.load_model(progress=events.append), daemon=True)
    worker.start()
    assert entered.wait(1)
    engine.close()
    release.set()
    worker.join(1)
    assert not worker.is_alive()
    assert engine.get_ready() is None
    assert engine.prepare_snapshot()["phase"] == "closed"
    assert "ready" not in [event["phase"] for event in events]


def test_explicit_retry_queued_during_terminal_emit_is_not_dropped(monkeypatch):
    """A retry requested while the failing worker is broadcasting must still run.

    The worker keeps its key in ``_preparation_active`` until after the terminal
    event is delivered. If admission ignores queued keys that equal the active
    one, the retry sits in ``queued`` forever because status polling never
    re-enqueues it.
    """
    factory.shutdown_preparation_lane()
    monkeypatch.setattr(factory, "_whisper_engines", {})
    monkeypatch.setattr(factory, "_engine", None)
    entered = threading.Event()
    release_emit = threading.Event()
    calls = []

    def callback(event):
        if event["phase"] == "error":
            entered.set()
            assert release_emit.wait(3)

    def load(engine, progress=None, retry=False):
        calls.append((engine.model_size, engine.language))
        raise RuntimeError("offline " + engine.model_size)

    monkeypatch.setattr(engines.STTEngine, "load_model", load)
    factory.init_preparation_lane(callback)
    try:
        first = factory.request_prepare("medium", "zh")
        assert entered.wait(3)
        retry = factory.request_prepare("medium", "zh", retry=True)
        assert retry["attempt_id"] != first["attempt_id"]
        release_emit.set()
        _wait(lambda: calls.count(("medium", "zh")) == 2)
        assert calls.count(("medium", "zh")) == 2
    finally:
        release_emit.set()
        factory.shutdown_preparation_lane()


def _state(key):
    return next(
        state for state in factory.get_preparation_snapshot()["states"]
        if tuple(state["key"]) == key
    )


@pytest.mark.parametrize("scope,status_event_type", [
    ("interviewer", "stt_status"),
    ("candidate", "candidate_asr_status"),
])
def test_unready_fallback_never_republishes_legacy_loading_on_circuit_open(
    monkeypatch, lane, scope, status_event_type,
):
    calls, _, release = _fake_loader(monkeypatch, blocked="none", fail={"medium"})
    release.set()
    factory.request_prepare(
        "medium", "en", consumer="main" if scope == "interviewer" else "candidate",
    )
    _wait(lambda: _state(("medium", "en"))["phase"] == "error")
    first_attempt = _state(("medium", "en"))["attempt_id"]

    frames = []
    import api.realtime.ws as ws
    monkeypatch.setattr(ws, "broadcast", frames.append)
    monkeypatch.setattr(factory, "_call_circuit_open", lambda _scope: True)

    for _ in range(2):
        assert factory.transcribe_with_fallback(
            np.zeros(1600, dtype=np.float32), 16000, provider="generic",
            whisper_model="medium", whisper_language="en", scope=scope,
            status_event_type=status_event_type,
        ) == ""

    status_frames = [frame for frame in frames if frame.get("type") == status_event_type]
    assert not any(frame.get("loading") is True for frame in status_frames)
    assert calls == [("medium", "en")]
    assert _state(("medium", "en"))["attempt_id"] == first_attempt
    assert _state(("medium", "en"))["phase"] == "error"
    fallback_type = "candidate_stt_fallback" if scope == "candidate" else "stt_fallback"
    assert [frame["type"] for frame in frames].count(fallback_type) == 2
    opposite_type = "stt_status" if scope == "candidate" else "candidate_asr_status"
    assert not any(frame.get("type") == opposite_type for frame in frames)


@pytest.mark.parametrize("scope,status_event_type", [
    ("interviewer", "stt_status"),
    ("candidate", "candidate_asr_status"),
])
def test_unready_fallback_never_republishes_legacy_loading_after_remote_failure(
    monkeypatch, lane, scope, status_event_type,
):
    calls, _, release = _fake_loader(monkeypatch, blocked="none", fail={"medium"})
    release.set()
    factory.request_prepare(
        "medium", "en", consumer="main" if scope == "interviewer" else "candidate",
    )
    _wait(lambda: _state(("medium", "en"))["phase"] == "error")
    first_attempt = _state(("medium", "en"))["attempt_id"]

    class FailedRemote:
        is_loaded = True

        def transcribe(self, *args, **kwargs):
            raise RuntimeError("401 unauthorized")

    real_get_engine = factory.get_stt_engine
    monkeypatch.setattr(factory, "get_stt_engine", lambda **kwargs:
                        FailedRemote() if kwargs.get("provider") == "generic" else real_get_engine(**kwargs))
    monkeypatch.setattr(factory, "_call_circuit_open", lambda _scope: False)
    monkeypatch.setattr(factory, "_call_circuit_record_failure", lambda *_args, **_kwargs: None)
    frames = []
    import api.realtime.ws as ws
    monkeypatch.setattr(ws, "broadcast", frames.append)

    for _ in range(2):
        assert factory.transcribe_with_fallback(
            np.zeros(1600, dtype=np.float32), 16000, provider="generic",
            whisper_model="medium", whisper_language="en", scope=scope,
            status_event_type=status_event_type,
        ) == ""

    status_frames = [frame for frame in frames if frame.get("type") == status_event_type]
    assert not any(frame.get("loading") is True for frame in status_frames)
    assert calls == [("medium", "en")]
    assert _state(("medium", "en"))["attempt_id"] == first_attempt
    assert _state(("medium", "en"))["phase"] == "error"
    fallback_type = "candidate_stt_fallback" if scope == "candidate" else "stt_fallback"
    assert [frame["type"] for frame in frames].count(fallback_type) == 2
    opposite_type = "stt_status" if scope == "candidate" else "candidate_asr_status"
    assert not any(frame.get("type") == opposite_type for frame in frames)


@pytest.mark.parametrize("scope,status_event_type", [
    ("interviewer", "stt_status"),
    ("candidate", "candidate_asr_status"),
])
def test_ready_fallback_keeps_legacy_loaded_status(monkeypatch, lane, scope, status_event_type):
    calls, _, release = _fake_loader(monkeypatch, blocked="none")
    release.set()
    factory.request_prepare("medium", "en", consumer="main" if scope == "interviewer" else "candidate")
    _wait(lambda: factory.get_ready("medium", "en") is not None)

    frames = []
    import api.realtime.ws as ws
    monkeypatch.setattr(ws, "broadcast", frames.append)
    monkeypatch.setattr(factory, "_call_circuit_open", lambda _scope: True)
    monkeypatch.setattr(factory, "_call_whisper_transcribe", lambda *_args, **_kwargs: "fallback text")

    assert factory.transcribe_with_fallback(
        np.zeros(1600, dtype=np.float32), 16000, provider="generic",
        whisper_model="medium", whisper_language="en", scope=scope,
        status_event_type=status_event_type,
    ) == "fallback text"

    assert {"type": status_event_type, "loaded": True, "loading": False, "provider": "whisper"} in frames
    assert not any(frame.get("loading") is True for frame in frames if frame.get("type") == status_event_type)
    assert calls == [("medium", "en")]
    opposite_type = "stt_status" if scope == "candidate" else "candidate_asr_status"
    assert not any(frame.get("type") == opposite_type for frame in frames)
