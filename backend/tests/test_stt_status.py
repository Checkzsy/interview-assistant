"""D/E: STT preparation status protocol, config identity, and deferred test API."""

from __future__ import annotations

import asyncio
import importlib
import sys
import threading
import time
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
ws_mod = importlib.import_module("api.realtime.ws")
audio_mod = importlib.import_module("services.audio")
factory = importlib.import_module("services.stt.factory")
engines = importlib.import_module("services.stt.engines")
config_payload = importlib.import_module("api.common.config_payload")
core_config = importlib.import_module("core.config")


def _run(coro):
    return asyncio.run(coro)


def _wait(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    assert predicate()


def _stt_cfg(**overrides):
    base = {
        "stt_provider": "whisper",
        "whisper_model": "base",
        "whisper_language": "auto",
        "whisper_preload": False,
        "candidate_asr_enabled": False,
        "candidate_stt_provider": "whisper",
        "candidate_whisper_model": "",
        "candidate_whisper_language": "",
        "candidate_remote_stt_enabled": False,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def _snapshot(phase="ready", roles=("main",), key=("base", "auto"), revision=7):
    return {
        "runtime_id": "runtime-1",
        "revision": revision,
        "active": None,
        "pending": [],
        "states": [
            {
                "key": list(key),
                "attempt_id": "attempt-1",
                "phase": phase,
                "downloaded_bytes": None,
                "total_bytes": None,
                "progress": None,
                "started_at": None,
                "updated_at": 0.0,
                "error": None,
                "roles": list(roles),
            }
        ],
    }


def _fake_engine(text="ok", loaded=True):
    return SimpleNamespace(
        is_loaded=loaded,
        is_loading=False,
        model_size="base",
        transcribe=lambda audio, sample_rate=16000, **kwargs: text,
    )


# ---------- status snapshot --------------------------------------------------


def test_stt_status_without_lifespan_returns_snapshot_and_version(monkeypatch):
    # Seed a nonzero high-water mark so the revision assertion cannot pass
    # merely because no lane ever ran in this process.
    factory._preparation_revision = 5
    factory.shutdown_preparation_lane()
    cfg = _stt_cfg(whisper_model="small")
    engine = _fake_engine()
    engine.model_size = "small"
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: engine)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: pytest.fail("status must not prepare"))

    result = _run(common_router.api_stt_status())

    assert result["preparation"]["runtime_id"] is None
    # shutdown must zero the high-water mark, otherwise a fresh runtime's early
    # revisions look stale to a client that kept the old number.
    assert result["preparation"]["revision"] == 0
    assert result["preparation"]["states"] == []
    assert result["config_version"] == core_config.stt_config_fingerprint(cfg)
    assert result["loaded"] is True
    assert result["loading"] is False
    assert result["model"] == "small"
    assert result["provider"] == "whisper"


def test_stt_status_prefers_main_preparation_state(monkeypatch):
    cfg = _stt_cfg(whisper_model="medium")
    engine = _fake_engine(loaded=False)
    engine.is_loading = True
    engine.model_size = "medium"
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: engine)
    monkeypatch.setattr(
        common_router,
        "get_preparation_snapshot",
        lambda: _snapshot(phase="downloading", key=("medium", "zh")),
    )

    result = _run(common_router.api_stt_status())

    assert result["loaded"] is False
    assert result["loading"] is True
    assert result["model"] == "medium"
    assert result["preparation"]["states"][0]["phase"] == "downloading"


# ---------- config identity --------------------------------------------------


def test_stt_config_version_covers_remote_config_without_leaking_secrets():
    first = core_config.AppConfig()
    second = core_config.AppConfig()
    first.generic_stt_api_key = "sk-first-secret"
    second.generic_stt_api_key = "sk-second-secret"

    first_version = core_config.stt_config_fingerprint(first)
    second_version = core_config.stt_config_fingerprint(second)

    assert first_version
    assert first_version != second_version
    assert "sk-first-secret" not in first_version
    assert "sk-second-secret" not in second_version

    unrelated = core_config.AppConfig()
    unrelated.generic_stt_api_key = "sk-first-secret"
    unrelated.temperature = 0.1
    assert core_config.stt_config_fingerprint(unrelated) == first_version


def test_config_payload_exposes_stt_config_version():
    cfg = core_config.AppConfig()
    payload = config_payload.build_config_payload(cfg)

    assert payload["stt_config_version"] == core_config.stt_config_fingerprint(cfg)


# ---------- WS init / event bridge ------------------------------------------


def test_ws_init_carries_preparation_snapshot(monkeypatch):
    snapshot = _snapshot(phase="loading")
    monkeypatch.setattr(ws_mod, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(ws_mod, "stt_config_fingerprint", lambda cfg: "version-1")
    monkeypatch.setattr(ws_mod, "get_config", lambda: _stt_cfg())
    monkeypatch.setattr(ws_mod, "get_stt_engine", lambda: _fake_engine())
    monkeypatch.setattr(ws_mod, "snapshot_session", lambda: {
        "is_recording": False,
        "is_paused": False,
        "transcriptions": [],
        "candidate_transcriptions": [],
        "candidate_answer_segments": [],
        "qa_pairs": [],
    })
    monkeypatch.setattr(ws_mod, "_ws_authorized", lambda ws: True)
    monkeypatch.setattr(ws_mod, "ws_clients", set())
    app = FastAPI()
    app.include_router(ws_mod.router)

    with TestClient(app).websocket_connect("/ws") as ws:
        init = ws.receive_json()

    assert init["type"] == "init"
    assert init["stt_preparation"] == snapshot
    assert init["stt_config_version"] == "version-1"


def test_preparation_bridge_broadcasts_full_snapshot_and_legacy_roles(monkeypatch):
    main = importlib.import_module("main")
    snapshot = _snapshot(phase="downloading", roles=("candidate", "main"))
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", lambda data: sent.append(data))
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg(candidate_asr_enabled=True))
    monkeypatch.setattr(main, "stt_config_fingerprint", lambda cfg: "version-1")

    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "downloading", "roles": ["candidate", "main"], "error": None})

    assert sent[0] == {
        "type": "stt_preparation",
        "config_version": "version-1",
        "preparation": snapshot,
    }
    assert {
        "type": "stt_status",
        "loaded": False,
        "loading": True,
        "provider": "whisper",
    } in sent
    candidate = [item for item in sent if item["type"] == "candidate_asr_status"]
    assert candidate == [{"type": "candidate_asr_status", "loaded": False, "loading": True, "provider": "whisper"}]


def test_preparation_bridge_keeps_download_error_out_of_candidate_mic_error(monkeypatch):
    main = importlib.import_module("main")
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", lambda data: sent.append(data))
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: _snapshot(phase="error", roles=("candidate",)))
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg(candidate_asr_enabled=True))
    monkeypatch.setattr(main, "stt_config_fingerprint", lambda cfg: "version-1")

    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "error", "roles": ["candidate"], "error": "offline"})

    candidate = [item for item in sent if item["type"] == "candidate_asr_status"]
    assert len(candidate) == 1
    assert "error" not in candidate[0]
    assert candidate[0]["loaded"] is False
    assert candidate[0]["loading"] is False
    assert not [item for item in sent if item["type"] == "stt_status"]


def test_preparation_bridge_drops_main_status_when_provider_switched_remote(monkeypatch):
    main = importlib.import_module("main")
    snapshot = _snapshot(phase="downloading", roles=("main",))
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", lambda data: sent.append(data))
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: snapshot)
    # A stale Whisper preparation event must not report the remote engine that
    # the user just saved as "not loaded".
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg(stt_provider="generic"))
    monkeypatch.setattr(main, "stt_config_fingerprint", lambda cfg: "version-1")

    main._publish_stt_preparation({"runtime_id": "runtime-1","phase": "downloading", "roles": ["main"], "error": None})

    assert sent == [{"type": "stt_preparation", "config_version": "version-1", "preparation": snapshot}]


def test_preparation_bridge_emits_fallback_status_only_on_terminal_phase(monkeypatch):
    main = importlib.import_module("main")
    sent = []
    # The lane always commits the phase before delivering its event, so the
    # snapshot is never older than the event it accompanies.
    current = {"phase": "downloading"}
    monkeypatch.setattr(main.ws, "broadcast", lambda data: sent.append(data))
    monkeypatch.setattr(
        main, "get_preparation_snapshot",
        lambda: _snapshot(phase=current["phase"], roles=("fallback",)),
    )
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg(stt_provider="generic", whisper_preload=True))
    monkeypatch.setattr(main, "stt_config_fingerprint", lambda cfg: "version-1")

    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "downloading", "roles": ["fallback"], "error": None})

    preload = [item for item in sent if item.get("provider") == "whisper-preload"]
    assert preload == []

    current["phase"] = "ready"
    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "ready", "roles": ["fallback"], "error": None})

    preload = [item for item in sent if item.get("provider") == "whisper-preload"]
    assert preload == [
        {"type": "stt_status", "provider": "whisper-preload", "loaded": True, "loading": False, "error": None},
    ]


# ---------- startup preload semantics ---------------------------------------


def _stub_slow_startup(monkeypatch):
    monkeypatch.setattr(engines, "_prune_superseded_whisper_cache", lambda *a, **k: None)
    storage_paths = importlib.import_module("services.storage.paths")
    monkeypatch.setattr(storage_paths, "data_dir", lambda: BACKEND_DIR)


def test_preload_local_primary_goes_through_preparation_lane(monkeypatch):
    main = importlib.import_module("main")
    cfg = _stt_cfg(whisper_model="small", whisper_language="zh")
    calls = []
    _stub_slow_startup(monkeypatch)
    monkeypatch.setattr(main, "get_config", lambda: cfg)
    monkeypatch.setattr(main, "get_stt_engine", lambda: pytest.fail("local primary must use the lane"))
    monkeypatch.setattr(main, "request_prepare", lambda *a, **k: calls.append((a, k)) or {"phase": "queued"})
    monkeypatch.setattr(main, "preload_whisper_fallback", lambda: None)

    main._preload_stt()

    assert calls == [(("small", "zh"), {"consumer": "main"})]


@pytest.mark.parametrize("preload", [False, True])
def test_preload_remote_primary_warms_fallback_only_when_enabled(monkeypatch, preload):
    main = importlib.import_module("main")
    cfg = _stt_cfg(stt_provider="generic", whisper_preload=preload)
    sent = []
    warm = []
    _stub_slow_startup(monkeypatch)
    monkeypatch.setattr(main, "get_config", lambda: cfg)
    monkeypatch.setattr(main, "get_stt_engine", lambda: _fake_engine())
    monkeypatch.setattr(main, "request_prepare", lambda *a, **k: pytest.fail("remote primary must not prepare local"))
    monkeypatch.setattr(main, "preload_whisper_fallback", lambda: warm.append(1))
    monkeypatch.setattr(main.ws, "broadcast", lambda data: sent.append(data))

    main._preload_stt()

    assert warm == [1]
    assert sent == [{"type": "stt_status", "loaded": True, "loading": False, "provider": "generic"}]


def test_preload_whisper_fallback_respects_config(monkeypatch):
    requested = []
    monkeypatch.setattr(factory, "request_prepare", lambda *a, **k: requested.append((a, k)) or {"phase": "queued"})
    monkeypatch.setattr(
        core_config,
        "get_config",
        lambda: _stt_cfg(stt_provider="doubao", whisper_preload=True),
    )
    factory.preload_whisper_fallback()
    assert requested == [((), {"consumer": "fallback"})]

    monkeypatch.setattr(
        core_config,
        "get_config",
        lambda: _stt_cfg(stt_provider="doubao", whisper_preload=False),
    )
    factory.preload_whisper_fallback()
    assert len(requested) == 1


@pytest.mark.parametrize("selection", [
    {"whisper_model": "medium"},
    {"whisper_language": "en"},
])
def test_preparation_bridge_drops_old_main_model_readiness(monkeypatch, selection):
    main = importlib.import_module("main")
    snapshot = _snapshot(roles=("main",))
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", sent.append)
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg(**selection))
    monkeypatch.setattr(main, "stt_config_fingerprint", lambda cfg: "version-2")

    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "ready", "roles": ["main"]})

    assert sent == [{"type": "stt_preparation", "config_version": "version-2", "preparation": snapshot}]


@pytest.mark.parametrize("selection", [
    {"candidate_asr_enabled": False},
    {"candidate_stt_provider": "doubao", "candidate_remote_stt_enabled": True},
    {"candidate_stt_provider": "generic", "candidate_remote_stt_enabled": True},
    {"candidate_whisper_model": "medium"},
    {"candidate_whisper_language": "en"},
])
def test_preparation_bridge_drops_obsolete_candidate_roles(monkeypatch, selection):
    main = importlib.import_module("main")
    snapshot = _snapshot(roles=("candidate",))
    cfg = _stt_cfg(candidate_asr_enabled=True)
    for name, value in selection.items():
        setattr(cfg, name, value)
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", sent.append)
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(main, "get_config", lambda: cfg)
    monkeypatch.setattr(main, "stt_config_fingerprint", lambda cfg: "version-2")

    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "ready", "roles": ["candidate"]})

    assert sent == [{"type": "stt_preparation", "config_version": "version-2", "preparation": snapshot}]


def test_preparation_bridge_respects_candidate_remote_safety_fallback(monkeypatch):
    main = importlib.import_module("main")
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", sent.append)
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: _snapshot(roles=("candidate",)))
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg(
        candidate_asr_enabled=True, candidate_stt_provider="doubao", candidate_remote_stt_enabled=False,
    ))

    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "ready", "roles": ["candidate"]})

    assert sent[-1] == {"type": "candidate_asr_status", "provider": "whisper", "loaded": True, "loading": False}


@pytest.mark.parametrize("runtime", [None, "runtime-2"])
def test_preparation_bridge_drops_completion_from_shutdown_or_previous_runtime(monkeypatch, runtime):
    main = importlib.import_module("main")
    snapshot = _snapshot(roles=("main", "candidate"))
    snapshot["runtime_id"] = runtime
    if runtime is None:
        snapshot["states"] = []
        snapshot["revision"] = 0
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", sent.append)
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg(candidate_asr_enabled=True))

    main._publish_stt_preparation({
        "runtime_id": "runtime-1", "key": ["base", "auto"],
        "phase": "ready", "roles": ["main", "candidate"],
    })

    assert sent == []


def test_lifespan_is_the_only_preparation_lane_wiring_point():
    source = (BACKEND_DIR / "main.py").read_text(encoding="utf-8")
    assert "init_preparation_lane(_publish_stt_preparation)" in source
    assert "shutdown_preparation_lane()" in source
    assert source.index("init_preparation_lane(") < source.index("_preload_stt")


# ---------- config save ------------------------------------------------------


class _ConfigBody:
    def __init__(self, **kw):
        self._data = kw

    def model_dump(self, exclude_none: bool = True):
        return dict(self._data)

    def __getattr__(self, name):
        return self._data.get(name)


def _stub_config_save(monkeypatch, cfg):
    def fake_update_config(data):
        for key, value in data.items():
            setattr(cfg, key, value)

    async def fake_run_in_threadpool(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(common_router, "update_config", fake_update_config)
    monkeypatch.setattr(common_router, "run_in_threadpool", fake_run_in_threadpool)
    monkeypatch.setattr(common_router, "build_config_payload", lambda cfg: {"ok": True})
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)


def test_config_save_requests_lane_without_legacy_engine_mutation(monkeypatch):
    cfg = _stt_cfg()
    requested = []
    _stub_config_save(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: requested.append((a, k)) or {"phase": "queued"})
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("config save must not mutate engines"))
    assert not hasattr(common_router, "set_whisper_language")

    result = _run(common_router.api_update_config(_ConfigBody(whisper_model="medium", whisper_language="zh")))

    assert result == {"ok": True}
    assert requested == [(("medium", "zh"), {"consumer": "main"})]


def test_config_save_requests_candidate_target_when_enabled(monkeypatch):
    cfg = _stt_cfg()
    requested = []
    _stub_config_save(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: requested.append((a, k)) or {"phase": "queued"})
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("config save must not mutate engines"))

    _run(common_router.api_update_config(_ConfigBody(
        candidate_asr_enabled=True,
        candidate_whisper_model="small",
        candidate_whisper_language="en",
    )))

    assert requested == [
        (("base", "auto"), {"consumer": "main"}),
        (("small", "en"), {"consumer": "candidate"}),
    ]


@pytest.mark.parametrize("preload", [False, True])
def test_config_save_switches_remote_fallback_consumer(monkeypatch, preload):
    cfg = _stt_cfg(stt_provider="generic")
    requested = []
    released = []
    warmed = []
    _stub_config_save(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: requested.append((a, k)) or {"phase": "queued"})
    monkeypatch.setattr(common_router, "release_prepare_consumer", lambda consumer: released.append(consumer))
    monkeypatch.setattr(common_router, "preload_whisper_fallback", lambda: warmed.append(1))
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("config save must not mutate engines"))

    _run(common_router.api_update_config(_ConfigBody(stt_provider="generic", whisper_preload=preload)))

    assert requested == []
    if preload:
        assert warmed == [1]
        assert released == ["main", "candidate"]
    else:
        assert warmed == []
        assert released == ["main", "fallback", "candidate"]


# ---------- /stt/test protocol ----------------------------------------------


def _stub_test_io(monkeypatch, cfg):
    monkeypatch.setattr(common_router, "get_config", lambda: cfg)
    monkeypatch.setattr(common_router.Path, "exists", lambda self: True)
    monkeypatch.setattr(audio_mod, "load_wav_file", lambda *a, **k: (np.zeros(160, dtype=np.float32), 16000))


def _body(**kw):
    return common_router.SttTestRequest(**kw)


def test_stt_test_without_body_keeps_legacy_response(monkeypatch):
    cfg = _stt_cfg()
    engine = _fake_engine("legacy-text")
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: engine)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: pytest.fail("legacy test must not prepare"))
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: None)

    result = _run(common_router.api_stt_test())

    assert result == {"ok": True, "text": "legacy-text"}


@pytest.mark.parametrize("error", [RuntimeError("construction failed"), asyncio.CancelledError("construction cancelled")])
def test_legacy_stt_test_engine_construction_returns_admission_on_all_errors(monkeypatch, error):
    _stub_test_io(monkeypatch, _stt_cfg())

    def construct():
        raise error

    monkeypatch.setattr(common_router, "get_stt_engine", construct)
    try:
        if isinstance(error, asyncio.CancelledError):
            with pytest.raises(asyncio.CancelledError):
                _run(common_router.api_stt_test())
        else:
            assert _run(common_router.api_stt_test()) == {"ok": False, "detail": "construction failed"}
    finally:
        available = common_router._stt_test_lock.acquire(blocking=False)
        common_router._stt_test_lock.release()
    assert available, "constructor error leaked STT test admission"


def test_legacy_stt_test_unprepared_whisper_never_starts_download(monkeypatch):
    engine = engines.STTEngine("medium", "en")
    loads = []
    _stub_test_io(monkeypatch, _stt_cfg(whisper_model="medium", whisper_language="en"))
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: engine)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: pytest.fail("legacy test must not prepare"))

    def load(*args, **kwargs):
        loads.append(1)
        raise RuntimeError("implicit model download")

    monkeypatch.setattr(engine, "load_model", load)
    result = _run(common_router.api_stt_test())
    assert result["ok"] is False
    assert loads == []
    assert not factory._whisper_infer_lock.locked()


def test_legacy_stt_test_ready_whisper_shares_inference_lock(monkeypatch):
    engine = engines.STTEngine("medium", "en")
    engine._model = object()
    calls = []
    _stub_test_io(monkeypatch, _stt_cfg(whisper_model="medium", whisper_language="en"))
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: engine)

    def transcribe(*args, **kwargs):
        calls.append(factory._whisper_infer_lock.locked())
        return "legacy-whisper"

    monkeypatch.setattr(engine, "transcribe", transcribe)
    assert _run(common_router.api_stt_test()) == {"ok": True, "text": "legacy-whisper"}
    assert calls == [True]
    assert not factory._whisper_infer_lock.locked()


@pytest.mark.parametrize("old_key", [("small", "zh"), ("medium", "en")])
def test_stt_test_rejects_attempt_from_another_model_or_language(monkeypatch, old_key):
    cfg = _stt_cfg(whisper_model="medium", whisper_language="zh")
    snapshot = _snapshot(phase="downloading", key=("medium", "zh"))
    current = snapshot["states"][0]
    current["attempt_id"] = "medium-zh-attempt"
    previous = dict(current, key=list(old_key), attempt_id="old-attempt", roles=[])
    snapshot["states"].append(previous)
    prepared = []
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: prepared.append((a, k)) or current)
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: None)

    result = _run(common_router.api_stt_test(_body(
        model="medium", language="zh", attempt_id="old-attempt",
        config_version=core_config.stt_config_fingerprint(cfg),
    )))

    assert result["ok"] is False and result["stale"] is True
    assert prepared == []


def test_stt_test_accepts_attempt_for_current_model_and_language(monkeypatch):
    cfg = _stt_cfg(whisper_model="medium", whisper_language="zh")
    snapshot = _snapshot(phase="downloading", key=("medium", "zh"))
    current = snapshot["states"][0]
    current["attempt_id"] = "medium-zh-attempt"
    prepared = []
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: prepared.append((a, k)) or current)
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: None)

    result = _run(common_router.api_stt_test(_body(
        model="medium", language="zh", attempt_id="medium-zh-attempt",
        config_version=core_config.stt_config_fingerprint(cfg),
    )))

    assert result["pending"] is True
    assert result["attempt_id"] == "medium-zh-attempt"
    assert prepared == [(("medium", "zh"), {"consumer": "main", "retry": False})]


@pytest.mark.parametrize("provider", ["generic", "doubao"])
def test_stt_test_rejects_whisper_attempt_for_remote_provider(monkeypatch, provider):
    # A remote provider has no Whisper target, so any attempt id captured for a
    # local (main or fallback) preparation must not be treated as current.
    cfg = _stt_cfg(
        stt_provider=provider,
        generic_stt_api_base_url="https://asr.example/v1",
        generic_stt_api_key="sk-test",
        generic_stt_model="asr-1",
        doubao_stt_api_key="doubao-test-key",
        doubao_stt_access_token="",
        doubao_stt_app_id="",
    )
    snapshot = _snapshot(phase="downloading", key=("base", "auto"), roles=("fallback",))
    snapshot["states"][0]["attempt_id"] = "fallback-attempt"
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda *a, **k: pytest.fail("stale attempt must not reach the engine"))

    result = _run(common_router.api_stt_test(_body(
        provider=provider, attempt_id="fallback-attempt",
        config_version=core_config.stt_config_fingerprint(cfg),
    )))

    assert result["ok"] is False and result["stale"] is True


def test_stt_test_pending_returns_immediately_without_transcribing(monkeypatch):
    cfg = _stt_cfg(whisper_model="medium", whisper_language="zh")
    version = core_config.stt_config_fingerprint(cfg)
    prepared = []
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(
        common_router,
        "request_prepare",
        lambda *a, **k: prepared.append((a, k)) or {"phase": "downloading", "attempt_id": "a1", "error": None},
    )
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: None)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("pending test must not touch engines"))
    monkeypatch.setattr(
        common_router,
        "transcribe_whisper_for_test",
        lambda *a, **k: pytest.fail("pending test must not transcribe"),
    )

    result = _run(common_router.api_stt_test(_body(model="medium", language="zh", config_version=version)))

    assert result["ok"] is False
    assert result["pending"] is True
    assert result["state"]["phase"] == "downloading"
    assert result["attempt_id"] == "a1"
    assert result["config_version"] == version
    assert prepared == [(("medium", "zh"), {"consumer": "main", "retry": False})]
    assert common_router._stt_test_lock.acquire(blocking=False)
    common_router._stt_test_lock.release()


def test_stt_test_error_requires_explicit_retry(monkeypatch):
    cfg = _stt_cfg(whisper_model="medium", whisper_language="zh")
    version = core_config.stt_config_fingerprint(cfg)
    retries = []
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(
        common_router,
        "request_prepare",
        lambda *a, **k: retries.append(k.get("retry")) or {"phase": "error", "attempt_id": "a2", "error": "offline"},
    )
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: None)
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("error test must not touch engines"))

    result = _run(common_router.api_stt_test(_body(model="medium", language="zh", config_version=version)))

    assert result["ok"] is False
    assert result["pending"] is False
    assert result["state"]["phase"] == "error"
    assert "offline" in result["detail"]
    assert retries == [False]

    retried = _run(common_router.api_stt_test(
        _body(model="medium", language="zh", config_version=version, retry=True)
    ))
    assert retried["pending"] is False
    assert retries == [False, True]


def test_stt_test_rejects_stale_version_and_selection(monkeypatch):
    cfg = _stt_cfg(whisper_model="medium", whisper_language="zh")
    version = core_config.stt_config_fingerprint(cfg)
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: pytest.fail("stale request must not prepare"))
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: pytest.fail("stale request must not read ready"))
    monkeypatch.setattr(common_router, "get_stt_engine", lambda: pytest.fail("stale request must not touch engines"))

    stale_version = _run(common_router.api_stt_test(_body(config_version="old-version")))
    assert stale_version["ok"] is False
    assert stale_version["stale"] is True
    assert stale_version["config_version"] == version

    stale_model = _run(common_router.api_stt_test(_body(model="small", config_version=version)))
    assert stale_model["stale"] is True

    stale_provider = _run(common_router.api_stt_test(_body(provider="generic", config_version=version)))
    assert stale_provider["stale"] is True


def test_stt_test_ready_whisper_uses_bounded_inference_lock(monkeypatch):
    cfg = _stt_cfg(whisper_model="medium", whisper_language="zh")
    version = core_config.stt_config_fingerprint(cfg)
    engine = _fake_engine()
    seen = {}
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: {"phase": "ready", "attempt_id": "a3"})
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: engine)

    def fake_transcribe(target, audio, sample_rate=16000, **kwargs):
        seen["engine"] = target
        seen["timeout"] = kwargs.get("timeout")
        return "你好"

    monkeypatch.setattr(common_router, "transcribe_whisper_for_test", fake_transcribe)

    result = _run(common_router.api_stt_test(_body(model="medium", language="zh", config_version=version)))

    assert result == {"ok": True, "text": "你好", "config_version": version}
    assert seen["engine"] is engine
    assert 0 < seen["timeout"] < 30

    def busy(*args, **kwargs):
        raise common_router.WhisperInferenceBusy("busy")

    monkeypatch.setattr(common_router, "transcribe_whisper_for_test", busy)
    busy_result = _run(common_router.api_stt_test(_body(model="medium", language="zh", config_version=version)))
    assert busy_result["ok"] is False
    assert busy_result["busy"] is True
    assert busy_result["reason"] == "inference_busy"

    engine.transcribe = lambda *a, **k: ""
    monkeypatch.setattr(common_router, "transcribe_whisper_for_test", lambda *a, **k: "")
    empty_result = _run(common_router.api_stt_test(_body(model="medium", language="zh", config_version=version)))
    assert empty_result["ok"] is False
    assert "empty" not in empty_result
    assert empty_result.get("busy") is None
    assert "空文本" in empty_result["detail"]


def test_stt_test_remote_body_uses_selected_provider_directly(monkeypatch):
    cfg = _stt_cfg(
        stt_provider="generic",
        generic_stt_api_base_url="https://x",
        generic_stt_api_key="sk",
        generic_stt_model="m",
    )
    version = core_config.stt_config_fingerprint(cfg)
    calls = []
    _stub_test_io(monkeypatch, cfg)

    def get_engine(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(transcribe=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("remote down")))

    monkeypatch.setattr(common_router, "get_stt_engine", get_engine)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: pytest.fail("remote test must not prepare"))
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: pytest.fail("remote test must not read ready"))

    result = _run(common_router.api_stt_test(_body(provider="generic", config_version=version)))

    assert result["ok"] is False
    assert result["detail"] == "remote down"
    assert result["config_version"] == version
    assert calls == [((), {"provider": "generic"})]


def test_stt_test_admission_busy_is_distinct_from_pending(monkeypatch):
    cfg = _stt_cfg(whisper_model="medium", whisper_language="zh")
    version = core_config.stt_config_fingerprint(cfg)
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(common_router, "request_prepare", lambda *a, **k: {"phase": "ready", "attempt_id": "a4"})
    monkeypatch.setattr(common_router, "get_ready", lambda *a, **k: _fake_engine())
    monkeypatch.setattr(common_router, "transcribe_whisper_for_test", lambda *a, **k: pytest.fail("busy request must not transcribe"))
    assert common_router._stt_test_lock.acquire(blocking=False)
    try:
        result = _run(common_router.api_stt_test(_body(model="medium", language="zh", config_version=version)))
    finally:
        common_router._stt_test_lock.release()

    assert result["ok"] is False
    assert result["busy"] is True
    assert result["reason"] == "admission_busy"
    assert "pending" not in result
    assert result["config_version"] == version


def test_stt_test_waits_for_real_preparation_lane(monkeypatch):
    factory.shutdown_preparation_lane()
    monkeypatch.setattr(factory, "_whisper_engines", {})
    monkeypatch.setattr(factory, "_engine", None)
    released = threading.Event()
    started = threading.Event()

    def fake_load(engine, progress=None, retry=False):
        started.set()
        assert released.wait(3)
        engine._model = object()

    monkeypatch.setattr(engines.STTEngine, "load_model", fake_load)
    factory.init_preparation_lane()
    cfg = _stt_cfg(whisper_model="small", whisper_language="zh")
    version = core_config.stt_config_fingerprint(cfg)
    transcoded = []
    _stub_test_io(monkeypatch, cfg)
    monkeypatch.setattr(
        common_router,
        "transcribe_whisper_for_test",
        lambda engine, audio, *a, **k: transcoded.append(engine) or "hello",
    )
    try:
        result = _run(common_router.api_stt_test(_body(model="small", language="zh", config_version=version)))
        assert started.wait(1)
        assert result["ok"] is False
        assert result["pending"] is True
        assert result["state"]["phase"] in {"queued", "resolving", "downloading", "loading"}
        assert transcoded == []

        released.set()
        _wait(lambda: factory.get_ready("small", "zh") is not None)

        ready = _run(common_router.api_stt_test(_body(model="small", language="zh", config_version=version)))
        assert ready == {"ok": True, "text": "hello", "config_version": version}
        assert len(transcoded) == 1
    finally:
        released.set()
        factory.shutdown_preparation_lane()


def test_preparation_bridge_never_rolls_legacy_status_back_to_a_stale_phase(monkeypatch):
    """A delayed event must not broadcast an older phase than the snapshot.

    Role-change events are delivered outside the lane lock, so one captured at
    "downloading" can arrive after the worker already published "ready". The
    legacy stt_status message must follow the authoritative snapshot instead of
    the stale event phase, or a client ends up back in loading forever.
    """
    main = importlib.import_module("main")
    snapshot = _snapshot(phase="ready", roles=("main",))
    sent = []
    monkeypatch.setattr(main.ws, "broadcast", sent.append)
    monkeypatch.setattr(main, "get_preparation_snapshot", lambda: snapshot)
    monkeypatch.setattr(main, "get_config", lambda: _stt_cfg())
    monkeypatch.setattr(main, "stt_config_fingerprint", lambda cfg: "version-1")

    main._publish_stt_preparation({"runtime_id": "runtime-1","key": ["base", "auto"], "phase": "downloading", "roles": ["main"]})

    assert [item for item in sent if item["type"] == "stt_status"] == [
        {"type": "stt_status", "loaded": True, "loading": False, "provider": "whisper"}
    ]
