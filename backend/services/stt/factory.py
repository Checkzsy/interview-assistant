"""STT engine factory: singleton management, provider selection, and resilience."""

import time
import threading
import uuid
from copy import deepcopy
from typing import Optional

import numpy as np

from core.logger import get_logger
from .engines import STTEngine, DoubaoSTT, GenericHTTPSTT

_log = get_logger("stt.factory")

_engine: Optional[STTEngine] = None
_whisper_engines: dict[tuple[str, str], STTEngine] = {}
_doubao_engine: Optional[DoubaoSTT] = None
_generic_engine: Optional[GenericHTTPSTT] = None
_engine_lock = threading.Lock()
_whisper_infer_lock = threading.Lock()
REMOTE_EMPTY_RETRY_PAD_MS = 240
REMOTE_EMPTY_RETRY_MAX_AUDIO_SEC = 6.0

_preparation_condition = threading.Condition()
_preparation_runtime = None
_preparation_revision = 0
_preparation_callback = None
_preparation_active = None
_preparation_pending = []
_preparation_states = {}
_preparation_consumers = {}
_PREPARATION_PROGRESS_MIN_INTERVAL = 0.25
_LAST_PREPARATION_EMIT = object()


def _preparation_key(model_size=None, language=None):
    if model_size is None or language is None:
        from core.config import get_config
        cfg = get_config()
        model_size = model_size or cfg.whisper_model or "base"
        language = language or cfg.whisper_language or "auto"
    return model_size, language


def _new_preparation_state(key, phase):
    now = time.time()
    return {
        "key": list(key), "attempt_id": uuid.uuid4().hex, "phase": phase,
        "downloaded_bytes": None, "total_bytes": None, "progress": None,
        "started_at": None, "updated_at": now, "error": None, "roles": [],
        _LAST_PREPARATION_EMIT: None,
    }


def _public_preparation_state(state):
    return deepcopy({key: value for key, value in state.items() if key is not _LAST_PREPARATION_EMIT})


def _preparation_event_locked(state):
    global _preparation_revision
    _preparation_revision += 1
    state["updated_at"] = time.time()
    state[_LAST_PREPARATION_EMIT] = time.monotonic()
    event = _public_preparation_state(state)
    event.update(runtime_id=_preparation_runtime, revision=_preparation_revision)
    return event


def _emit_preparation(event):
    with _preparation_condition:
        callback = _preparation_callback
        valid = _preparation_runtime == event["runtime_id"] and _preparation_runtime is not None
    if not valid:
        return
    if callback is not None:
        try:
            callback(event)
        except Exception:
            _log.exception("Whisper preparation callback failed")


def _refresh_preparation_roles_locked():
    for key, state in _preparation_states.items():
        state["roles"] = sorted(role for role, selected in _preparation_consumers.items() if selected == key)
    _preparation_pending[:] = [
        key for key in _preparation_pending if _preparation_states[key]["roles"]
    ]


def init_preparation_lane(callback=None):
    global _preparation_runtime, _preparation_callback, _preparation_revision
    with _preparation_condition:
        if _preparation_runtime is not None:
            _preparation_callback = callback
            return
        _preparation_runtime = uuid.uuid4().hex
        _preparation_revision = 0
        _preparation_callback = callback
        runtime = _preparation_runtime
        thread = threading.Thread(
            target=_preparation_worker, args=(runtime,), name="stt-prepare", daemon=True,
        )
        thread.start()


def shutdown_preparation_lane():
    global _preparation_runtime, _preparation_callback, _preparation_active, _preparation_revision, _whisper_preload_done, _engine
    with _preparation_condition:
        _preparation_runtime = None
        _preparation_revision = 0
        _preparation_callback = None
        _preparation_active = None
        _preparation_pending.clear()
        _preparation_states.clear()
        _preparation_consumers.clear()
        _preparation_condition.notify_all()
    with _engine_lock:
        engines = list(_whisper_engines.values())
        if _engine is not None and _engine not in engines:
            engines.append(_engine)
        _whisper_engines.clear()
        _engine = None
        _whisper_preload_done = False
    for engine in engines:
        engine.close()


def request_prepare(model_size=None, language=None, *, consumer="main", retry=False):
    if consumer not in {"main", "candidate", "fallback"}:
        raise ValueError("Unknown preparation consumer: " + str(consumer))
    key = _preparation_key(model_size, language)
    events = []
    with _preparation_condition:
        if _preparation_runtime is None:
            state = _new_preparation_state(key, "uninitialized")
            state["error"] = "Whisper preparation lane is not initialized"
            return _public_preparation_state(state)
        _preparation_consumers[consumer] = key
        before = {item: list(value["roles"]) for item, value in _preparation_states.items()}
        created = False
        state = _preparation_states.get(key)
        if state is None or (retry and state["phase"] == "error"):
            state = _new_preparation_state(key, "queued")
            _preparation_states[key] = state
            created = True
        _refresh_preparation_roles_locked()
        if state["phase"] == "queued" and key not in _preparation_pending and key != _preparation_active:
            _preparation_pending.append(key)
        for item, value in _preparation_states.items():
            if (created and item == key) or value["roles"] != before.get(item, []):
                events.append(_preparation_event_locked(value))
        _preparation_condition.notify_all()
        result = _public_preparation_state(state)
    for event in events:
        _emit_preparation(event)
    return result


def release_prepare_consumer(consumer):
    events = []
    with _preparation_condition:
        _preparation_consumers.pop(consumer, None)
        before = {key: list(state["roles"]) for key, state in _preparation_states.items()}
        _refresh_preparation_roles_locked()
        for key, state in _preparation_states.items():
            if state["roles"] != before[key]:
                events.append(_preparation_event_locked(state))
        _preparation_condition.notify_all()
    for event in events:
        _emit_preparation(event)


def get_preparation_snapshot():
    """Full recovery snapshot for HTTP polling.

    The runtime id and monotonic revision live on the snapshot root only.
    Each state entry is the plain state dict: key, attempt_id, phase,
    downloaded_bytes, total_bytes, progress, started_at, updated_at, error,
    roles. Incremental callback events add runtime_id/revision per event.
    """
    with _preparation_condition:
        active = _preparation_states.get(_preparation_active)
        return {
            "runtime_id": _preparation_runtime, "revision": _preparation_revision,
            "active": _public_preparation_state(active) if active is not None else None,
            "pending": [_public_preparation_state(_preparation_states[key]) for key in _preparation_pending],
            "states": [_public_preparation_state(state) for state in _preparation_states.values()],
        }


def get_ready(model_size=None, language=None):
    key = _preparation_key(model_size, language)
    with _engine_lock:
        engine = _whisper_engines.get(key)
    return engine if engine is not None and engine.is_loaded else None


def _preparation_worker(runtime):
    global _preparation_active, _whisper_preload_done
    while True:
        with _preparation_condition:
            _preparation_condition.wait_for(
                lambda: runtime != _preparation_runtime or bool(_preparation_pending)
            )
            if runtime != _preparation_runtime:
                return
            key = _preparation_pending.pop(0)
            _preparation_active = key
            state = _preparation_states[key]
            attempt = state["attempt_id"]
            state.update(phase="resolving", started_at=time.time())
            event = _preparation_event_locked(state)
        _emit_preparation(event)
        engine = None

        def progress(update, key=key, attempt=attempt, state=state):
            with _preparation_condition:
                if runtime != _preparation_runtime or _preparation_states[key]["attempt_id"] != attempt:
                    return
                if state["phase"] in {"ready", "error"}:
                    return
                terminal = update.get("phase") in {"ready", "error"}
                phase_changed = update.get("phase") != state["phase"]
                bytes_changed = update.get("downloaded_bytes") != state["downloaded_bytes"]
                last_emit = state[_LAST_PREPARATION_EMIT]
                throttled = (
                    not terminal
                    and not phase_changed
                    and last_emit is not None
                    and time.monotonic() - last_emit < _PREPARATION_PROGRESS_MIN_INTERVAL
                )
                state.update(update)
                changed = terminal or phase_changed or bytes_changed
                event = _preparation_event_locked(state) if changed and not throttled else None
            if event is not None:
                _emit_preparation(event)

        try:
            with _preparation_condition:
                if runtime != _preparation_runtime:
                    return
            engine = get_stt_engine(model_size=key[0], language=key[1], provider="whisper")
            engine.load_model(progress=progress, retry=True)
            if not engine.is_loaded:
                raise RuntimeError("Whisper 模型准备已失效，请重试")
            progress({"phase": "ready", "error": None})
        except Exception as exc:
            progress({"phase": "error", "error": str(exc) or type(exc).__name__})
        finally:
            with _preparation_condition:
                stale = runtime != _preparation_runtime
                if not stale:
                    _preparation_active = None
                    _whisper_preload_done = state["phase"] == "ready"
                    # A retry admitted while this worker was still publishing its
                    # terminal event was deliberately not queued (the key looked
                    # active then). Promote it now; status polling never
                    # re-enqueues, so dropping it would strand it in "queued".
                    for queued_key, queued_state in _preparation_states.items():
                        # roles is what keeps a queued target alive: a consumer
                        # that moved on already had its stale target pruned.
                        if (
                            queued_state["phase"] == "queued"
                            and queued_state["roles"]
                            and queued_key not in _preparation_pending
                        ):
                            _preparation_pending.append(queued_key)
                    _preparation_condition.notify_all()
            if stale and engine is not None:
                engine.close()
        if stale:
            return


class WhisperInferenceBusy(RuntimeError):
    pass


def transcribe_whisper_for_test(engine, audio, sample_rate=16000, *, position="后端开发", language="Python", timeout=0.1):
    if not engine.is_loaded:
        raise RuntimeError("Whisper model is not ready")
    if not _whisper_infer_lock.acquire(timeout=max(0.0, timeout)):
        raise WhisperInferenceBusy("Whisper inference is busy")
    try:
        return engine.transcribe(audio, sample_rate, position=position, language=language)
    finally:
        _whisper_infer_lock.release()

# ---------------------------------------------------------------------------
# Circuit breaker for remote STT engines (doubao / generic)
# ---------------------------------------------------------------------------

_circuit_lock = threading.Lock()
_circuit_failures = 0
_circuit_open_until = 0.0
_circuit_failures_by_scope: dict[str, int] = {}
_circuit_open_until_by_scope: dict[str, float] = {}
CIRCUIT_THRESHOLD = 3
CIRCUIT_THRESHOLD_TIMEOUT = 5
CIRCUIT_COOLDOWN_SEC = 60.0
CIRCUIT_COOLDOWN_AUTH_SEC = 3600.0

_TIMEOUT_EXCEPTIONS = (TimeoutError,)
try:
    import websocket as _ws_mod
    _WS_TIMEOUT_EXC = getattr(_ws_mod, "WebSocketTimeoutException", None)
    if _WS_TIMEOUT_EXC:
        _TIMEOUT_EXCEPTIONS = (TimeoutError, _WS_TIMEOUT_EXC)
except ImportError:
    pass


def _is_timeout_error(err: Exception) -> bool:
    if isinstance(err, _TIMEOUT_EXCEPTIONS):
        return True
    msg = str(err).lower()
    return "timeout" in msg or "timed out" in msg


def _is_auth_error(err: Exception) -> bool:
    msg = str(err).lower()
    return "401" in msg or "403" in msg or "unauthorized" in msg or "forbidden" in msg or "grant not found" in msg


def _circuit_record_failure(is_timeout: bool = False, is_auth: bool = False, scope: str = "interviewer"):
    global _circuit_failures, _circuit_open_until
    circuit_scope = (scope or "interviewer").strip() or "interviewer"
    threshold = CIRCUIT_THRESHOLD_TIMEOUT if is_timeout else CIRCUIT_THRESHOLD
    with _circuit_lock:
        failures = _circuit_failures_by_scope.get(circuit_scope, 0) + 1
        _circuit_failures_by_scope[circuit_scope] = failures
        if circuit_scope == "interviewer":
            _circuit_failures = failures
        if failures >= threshold:
            cooldown = CIRCUIT_COOLDOWN_AUTH_SEC if is_auth else CIRCUIT_COOLDOWN_SEC
            open_until = time.monotonic() + cooldown
            _circuit_open_until_by_scope[circuit_scope] = open_until
            if circuit_scope == "interviewer":
                _circuit_open_until = open_until
            _log.warning(
                "STT circuit OPEN scope=%s after %d failures (timeout=%s auth=%s), fallback for %.0fs",
                circuit_scope, failures, is_timeout, is_auth, cooldown,
            )


def _circuit_reset(scope: str = "interviewer"):
    global _circuit_failures, _circuit_open_until
    circuit_scope = (scope or "interviewer").strip() or "interviewer"
    with _circuit_lock:
        if _circuit_failures_by_scope.get(circuit_scope, 0) > 0:
            _circuit_failures_by_scope[circuit_scope] = 0
            _circuit_open_until_by_scope[circuit_scope] = 0.0
        if circuit_scope == "interviewer" and _circuit_failures > 0:
            _circuit_failures = 0
            _circuit_open_until = 0.0


def _is_circuit_open(scope: str = "interviewer") -> bool:
    circuit_scope = (scope or "interviewer").strip() or "interviewer"
    with _circuit_lock:
        failures = _circuit_failures_by_scope.get(circuit_scope, _circuit_failures if circuit_scope == "interviewer" else 0)
        open_until = _circuit_open_until_by_scope.get(
            circuit_scope,
            _circuit_open_until if circuit_scope == "interviewer" else 0.0,
        )
        if failures < CIRCUIT_THRESHOLD:
            return False
        if time.monotonic() >= open_until:
            return False
        return True


def _call_circuit_open(scope: str) -> bool:
    try:
        return _is_circuit_open(scope)
    except TypeError:
        return _is_circuit_open()


def _call_circuit_reset(scope: str) -> None:
    try:
        _circuit_reset(scope)
    except TypeError:
        _circuit_reset()


def _call_circuit_record_failure(scope: str, *, is_timeout: bool, is_auth: bool) -> None:
    try:
        _circuit_record_failure(is_timeout=is_timeout, is_auth=is_auth, scope=scope)
    except TypeError:
        _circuit_record_failure(is_timeout=is_timeout, is_auth=is_auth)


def _pad_audio_tail_silence(
    audio: np.ndarray,
    sample_rate: int,
    *,
    pad_ms: int,
) -> np.ndarray:
    if sample_rate <= 0 or len(audio) <= 0 or pad_ms <= 0:
        return audio
    pad_samples = int(round(sample_rate * (pad_ms / 1000.0)))
    if pad_samples <= 0:
        return audio
    return np.concatenate([audio, np.zeros(pad_samples, dtype=audio.dtype)])


# ---------------------------------------------------------------------------
# Whisper fallback (lazy init)
# ---------------------------------------------------------------------------

def _get_whisper_fallback() -> STTEngine:
    global _engine, _whisper_preload_done
    from core.config import get_config
    cfg = get_config()
    size = cfg.whisper_model or "base"
    lang = cfg.whisper_language or "auto"
    engine = get_stt_engine(provider="whisper", model_size=size, language=lang)
    if not engine.is_loaded:
        request_prepare(size, lang, consumer="fallback")
    return engine


def _transcribe_with_whisper_lock(
    engine: STTEngine,
    audio: np.ndarray,
    sample_rate: int,
    position: str,
    language: str,
    whisper_lock_timeout_sec: Optional[float] = None,
) -> str:
    acquired = False
    try:
        if whisper_lock_timeout_sec is None:
            _whisper_infer_lock.acquire()
            acquired = True
        else:
            acquired = _whisper_infer_lock.acquire(timeout=max(0.0, whisper_lock_timeout_sec))
        if not acquired:
            _log.debug("Whisper skip reason=infer_lock_busy model=%s", getattr(engine, "model_size", ""))
            return ""
        return engine.transcribe(audio, sample_rate, position=position, language=language)
    finally:
        if acquired:
            _whisper_infer_lock.release()


def _whisper_transcribe(
    audio: np.ndarray,
    sample_rate: int,
    position: str,
    language: str,
    *,
    model_size: Optional[str] = None,
    whisper_language: Optional[str] = None,
    whisper_lock_timeout_sec: Optional[float] = None,
) -> str:
    engine = get_stt_engine(
        provider="whisper",
        model_size=model_size,
        language=whisper_language,
    )
    if not engine.is_loaded:
        state = request_prepare(model_size, whisper_language, consumer="fallback")
        if state.get("phase") != "uninitialized":
            return ""
        # No lifespan-managed lane (router-only mount, CLI, bench): nobody would
        # ever run the preparation, so keep the legacy synchronous load.
        _log.info("Whisper: loading model %s outside the preparation lane", engine.model_size)
        engine.load_model()
    return _transcribe_with_whisper_lock(
        engine,
        audio,
        sample_rate,
        position,
        language,
        whisper_lock_timeout_sec,
    )


_whisper_preload_done = False


def _remove_whisper_engine_aliases_locked(
    engine: STTEngine,
    *,
    keep_key: Optional[tuple[str, str]] = None,
) -> None:
    for cached_key, cached_engine in list(_whisper_engines.items()):
        if cached_engine is engine and cached_key != keep_key:
            _whisper_engines.pop(cached_key, None)


def _is_whisper_preloaded() -> bool:
    global _whisper_preload_done
    if _whisper_preload_done:
        return True
    with _engine_lock:
        if _engine is not None and _engine.is_loaded:
            _whisper_preload_done = True
            return True
    return False


def _is_whisper_engine_loaded(
    model_size: Optional[str] = None,
    whisper_language: Optional[str] = None,
) -> bool:
    from core.config import get_config

    cfg = get_config()
    key = (
        model_size or cfg.whisper_model or "base",
        whisper_language or cfg.whisper_language or "auto",
    )
    with _engine_lock:
        engine = _whisper_engines.get(key)
        if engine is not None and engine.is_loaded:
            return True
        return bool(
            _engine is not None
            and getattr(_engine, "model_size", None) == key[0]
            and getattr(_engine, "language", None) == key[1]
            and _engine.is_loaded
        )


def _whisper_transcribe_fallback(
    audio: np.ndarray,
    sample_rate: int,
    position: str,
    language: str,
    *,
    model_size: Optional[str] = None,
    whisper_language: Optional[str] = None,
    status_event_type: str = "stt_status",
    whisper_lock_timeout_sec: Optional[float] = None,
) -> str:
    """Fallback through Whisper, loading it first if preload has not completed."""
    global _whisper_preload_done
    from core.config import get_config
    cfg = get_config()
    size = model_size or cfg.whisper_model or "base"
    lang = whisper_language or cfg.whisper_language or "auto"
    try:
        engine = get_stt_engine(
            provider="whisper",
            model_size=size,
            language=lang,
        )
    except TypeError:
        # Some tests and plugins monkeypatch get_stt_engine with the old
        # signature. Build the Whisper fallback directly in that case.
        global _engine
        with _engine_lock:
            if _engine is None:
                _engine = STTEngine(model_size=size, language=lang)
            engine = _engine
    if engine.is_loaded:
        _whisper_preload_done = True
        return _transcribe_with_whisper_lock(
            engine,
            audio,
            sample_rate,
            position,
            language,
            whisper_lock_timeout_sec,
        )
    state = request_prepare(size, lang, consumer="fallback")
    if state.get("phase") != "uninitialized":
        return ""
    # Same legacy contract as _whisper_transcribe: without a lane there is no
    # worker to prepare the model, so a queue-only return would stay empty.
    _log.info("Whisper fallback: loading model %s outside the preparation lane", size)
    engine.load_model()
    _whisper_preload_done = bool(engine.is_loaded)
    if not engine.is_loaded:
        return ""
    return _transcribe_with_whisper_lock(
        engine,
        audio,
        sample_rate,
        position,
        language,
        whisper_lock_timeout_sec,
    )


def _call_whisper_transcribe(
    audio: np.ndarray,
    sample_rate: int,
    position: str,
    language: str,
    *,
    model_size: Optional[str] = None,
    whisper_language: Optional[str] = None,
    whisper_lock_timeout_sec: Optional[float] = None,
) -> str:
    try:
        return _whisper_transcribe(
            audio,
            sample_rate,
            position,
            language,
            model_size=model_size,
            whisper_language=whisper_language,
            whisper_lock_timeout_sec=whisper_lock_timeout_sec,
        )
    except TypeError:
        return _whisper_transcribe(audio, sample_rate, position, language)


def _call_whisper_transcribe_fallback(
    audio: np.ndarray,
    sample_rate: int,
    position: str,
    language: str,
    *,
    model_size: Optional[str] = None,
    whisper_language: Optional[str] = None,
    status_event_type: str = "stt_status",
    whisper_lock_timeout_sec: Optional[float] = None,
) -> str:
    try:
        return _whisper_transcribe_fallback(
            audio,
            sample_rate,
            position,
            language,
            model_size=model_size,
            whisper_language=whisper_language,
            status_event_type=status_event_type,
            whisper_lock_timeout_sec=whisper_lock_timeout_sec,
        )
    except TypeError:
        return _whisper_transcribe_fallback(audio, sample_rate, position, language)


def _do_whisper_load():
    request_prepare(consumer="fallback")


def preload_whisper_fallback() -> None:
    """Request the optional remote-provider fallback on the managed lane."""
    from core.config import get_config
    cfg = get_config()
    if cfg.whisper_preload and cfg.stt_provider in ("doubao", "generic"):
        request_prepare(consumer="fallback")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def set_whisper_language(language: str) -> None:
    global _engine
    from core.config import get_config
    cfg = get_config()
    lang = (language or "auto").strip() or "auto"
    with _engine_lock:
        model_size = getattr(_engine, "model_size", None) or cfg.whisper_model or "base"
        key = (model_size, lang)
        selected = _whisper_engines.get(key)
        if selected is None:
            selected = STTEngine(model_size=model_size, language=lang)
            _whisper_engines[key] = selected
        _engine = selected


def get_stt_engine(
    provider: Optional[str] = None,
    model_size: Optional[str] = None,
    language: Optional[str] = None,
):
    """返回当前配置对应的 STT 引擎：whisper（本地）/ doubao（豆包）/ generic（通用 HTTP）。"""
    from core.config import get_config
    cfg = get_config()
    effective_provider = provider or cfg.stt_provider
    if effective_provider == "iflytek":
        raise RuntimeError("讯飞 STT 已下线，请在设置中改为通用 ASR 或 Whisper")
    if effective_provider == "doubao":
        global _doubao_engine
        access_token = cfg.doubao_stt_access_token or ""
        api_key = getattr(cfg, "doubao_stt_api_key", "") or ""
        with _engine_lock:
            if _doubao_engine is None or (
                _doubao_engine.app_id != cfg.doubao_stt_app_id
                or _doubao_engine.access_token != access_token
                or _doubao_engine.api_key != api_key
                or _doubao_engine.resource_id != cfg.doubao_stt_resource_id
                or _doubao_engine.boosting_table_id != (cfg.doubao_stt_boosting_table_id or "")
            ):
                _doubao_engine = DoubaoSTT(
                    app_id=cfg.doubao_stt_app_id,
                    access_token=access_token,
                    api_key=api_key,
                    resource_id=cfg.doubao_stt_resource_id or "volc.seedasr.sauc.duration",
                    boosting_table_id=cfg.doubao_stt_boosting_table_id or "",
                )
            return _doubao_engine
    if effective_provider == "generic":
        global _generic_engine
        api_key = cfg.generic_stt_api_key or ""
        with _engine_lock:
            if _generic_engine is None or (
                _generic_engine.api_base_url != (cfg.generic_stt_api_base_url or "").rstrip("/")
                or _generic_engine.api_key != api_key
                or _generic_engine.model != (cfg.generic_stt_model or "")
                or _generic_engine.custom_headers != getattr(cfg, "generic_stt_custom_headers", "")
            ):
                _generic_engine = GenericHTTPSTT(
                    api_base_url=cfg.generic_stt_api_base_url,
                    api_key=api_key,
                    model=cfg.generic_stt_model,
                    custom_headers=getattr(cfg, "generic_stt_custom_headers", ""),
                )
            return _generic_engine
    if effective_provider != "whisper":
        raise RuntimeError(f"未知 STT provider: {effective_provider}")
    global _engine
    size = model_size if model_size is not None else cfg.whisper_model
    lang = language if language is not None else cfg.whisper_language
    key = (size or "base", lang or "auto")
    with _engine_lock:
        default_key = (cfg.whisper_model or "base", cfg.whisper_language or "auto")
        engine = _whisper_engines.get(key)
        if engine is not None and (
            getattr(engine, "model_size", None) != key[0]
            or getattr(engine, "language", None) != key[1]
        ):
            _whisper_engines.pop(key, None)
            engine = None
        if engine is None:
            if (
                _engine is not None
                and getattr(_engine, "model_size", None) == key[0]
                and getattr(_engine, "language", None) == key[1]
            ):
                engine = _engine
            else:
                engine = STTEngine(model_size=key[0], language=key[1])
            _whisper_engines[key] = engine
        _remove_whisper_engine_aliases_locked(engine, keep_key=key)
        if _engine is None or key == default_key:
            _engine = engine
        return engine


def transcribe_with_fallback(
    audio: np.ndarray,
    sample_rate: int,
    position: str = "",
    language: str = "",
    *,
    provider: Optional[str] = None,
    whisper_model: Optional[str] = None,
    whisper_language: Optional[str] = None,
    allow_remote: bool = True,
    status_event_type: str = "stt_status",
    scope: str = "interviewer",
    whisper_lock_timeout_sec: Optional[float] = None,
    whisper_require_loaded: bool = False,
    fallback_on_empty_remote: bool = False,
) -> str:
    """Resilient transcription: retry once, then fallback to whisper, with circuit breaker.

    Flow:
      1. If circuit breaker is open and provider != whisper → go straight to whisper.
      2. Try primary engine (up to 2 attempts with 0.3s gap).
      3. On failure → record circuit failure → fallback to whisper.
    """
    from core.config import get_config
    from api.realtime.ws import broadcast

    cfg = get_config()
    selected_provider = provider or cfg.stt_provider
    if selected_provider in ("doubao", "generic") and not allow_remote:
        selected_provider = "whisper"
    is_remote = selected_provider in ("doubao", "generic")
    audio_sec = len(audio) / sample_rate if sample_rate and len(audio) else 0.0
    circuit_scope = (scope or "interviewer").strip() or "interviewer"
    fallback_event_type = "candidate_stt_fallback" if circuit_scope == "candidate" else "stt_fallback"

    if is_remote and _call_circuit_open(circuit_scope):
        _log.info("STT circuit open, using whisper fallback directly")
        broadcast({"type": fallback_event_type, "scope": circuit_scope, "from": selected_provider, "to": "whisper", "reason": "circuit_open"})
        whisper_loaded = _is_whisper_engine_loaded(whisper_model, whisper_language)
        try:
            if whisper_loaded:
                broadcast({"type": status_event_type, "loaded": True, "loading": False, "provider": "whisper"})
                return _call_whisper_transcribe(
                    audio,
                    sample_rate,
                    position,
                    language,
                    model_size=whisper_model,
                    whisper_language=whisper_language,
                    whisper_lock_timeout_sec=whisper_lock_timeout_sec,
                )
            return _call_whisper_transcribe_fallback(
                audio,
                sample_rate,
                position,
                language,
                model_size=whisper_model,
                whisper_language=whisper_language,
                status_event_type=status_event_type,
                whisper_lock_timeout_sec=whisper_lock_timeout_sec,
            )
        except Exception as e:
            _log.error("Whisper fallback also failed: %s", e, exc_info=True)
            return ""

    try:
        primary = get_stt_engine(
            provider=selected_provider,
            model_size=whisper_model,
            language=whisper_language,
        )
    except TypeError:
        # Backward compatibility for tests or plugins monkeypatching the old
        # two-argument factory signature.
        primary = get_stt_engine(
            model_size=whisper_model,
            language=whisper_language,
        )
    last_err: Optional[Exception] = None

    is_timeout_err = False
    is_auth_err = False
    max_attempts = 2 if is_remote else 1
    for attempt in range(max_attempts):
        try:
            if selected_provider == "whisper":
                if not primary.is_loaded:
                    if whisper_require_loaded:
                        return ""
                    prep_state = request_prepare(
                        whisper_model, whisper_language,
                        consumer="candidate" if circuit_scope == "candidate" else "main",
                    )
                    if prep_state.get("phase") != "uninitialized":
                        return ""
                    # No lifespan-managed lane (router-only mount, CLI, bench):
                    # nobody would run the preparation, so keep the legacy load.
                    _log.info("Whisper: loading model %s outside the preparation lane", whisper_model)
                    primary.load_model()
                    if not primary.is_loaded:
                        return ""
                acquired = False
                try:
                    if whisper_lock_timeout_sec is None:
                        _whisper_infer_lock.acquire()
                        acquired = True
                    else:
                        acquired = _whisper_infer_lock.acquire(timeout=max(0.0, whisper_lock_timeout_sec))
                    if not acquired:
                        _log.debug(
                            "Whisper skip scope=%s reason=infer_lock_busy model=%s audio=%.1fs",
                            circuit_scope,
                            getattr(primary, "model_size", ""),
                            audio_sec,
                        )
                        return ""
                    text = primary.transcribe(audio, sample_rate, position=position, language=language)
                finally:
                    if acquired:
                        _whisper_infer_lock.release()
            else:
                text = primary.transcribe(audio, sample_rate, position=position, language=language)
            if is_remote and not (text or "").strip():
                _log.warning(
                    "STT %s returned empty text scope=%s raw=%.1fs fallback_on_empty=%s",
                    selected_provider,
                    circuit_scope,
                    audio_sec,
                    fallback_on_empty_remote,
                )
                if (
                    circuit_scope == "interviewer"
                    and audio_sec > 0.0
                    and audio_sec <= REMOTE_EMPTY_RETRY_MAX_AUDIO_SEC
                ):
                    try:
                        retry_audio = _pad_audio_tail_silence(
                            audio,
                            sample_rate,
                            pad_ms=REMOTE_EMPTY_RETRY_PAD_MS,
                        )
                        retry_audio_sec = len(retry_audio) / sample_rate if sample_rate else audio_sec
                        _log.info(
                            "STT %s retrying empty interviewer segment with tail pad raw=%.1fs padded=%.1fs",
                            selected_provider,
                            audio_sec,
                            retry_audio_sec,
                        )
                        retry_text = primary.transcribe(
                            retry_audio,
                            sample_rate,
                            position=position,
                            language=language,
                        )
                        if (retry_text or "").strip():
                            _call_circuit_reset(circuit_scope)
                            broadcast({
                                "type": status_event_type,
                                "loaded": bool(primary.is_loaded),
                                "loading": False,
                                "provider": selected_provider,
                            })
                            return retry_text
                    except Exception as retry_err:
                        _log.warning(
                            "STT %s empty-text retry failed scope=%s: %s",
                            selected_provider,
                            circuit_scope,
                            retry_err,
                        )
                if not fallback_on_empty_remote and audio_sec < 5.0:
                    _log.info(
                        "STT %s returned empty text for short audio %.1fs; suppress fallback",
                        selected_provider,
                        audio_sec,
                    )
                    return ""
                last_err = RuntimeError(f"{selected_provider} 返回空文本")
                break
            if is_remote:
                _call_circuit_reset(circuit_scope)
                broadcast({"type": status_event_type, "loaded": bool(primary.is_loaded), "loading": False, "provider": selected_provider})
            return text
        except Exception as e:
            last_err = e
            is_timeout_err = _is_timeout_error(e)
            is_auth_err = _is_auth_error(e)
            if attempt == 0 and is_remote:
                if is_timeout_err or is_auth_err:
                    _log.warning("STT %s attempt 1 %s, skipping retry: %s", selected_provider,
                                 "auth error" if is_auth_err else "timeout", e)
                    break
                _log.warning("STT %s attempt 1 failed, retrying: %s", selected_provider, e)
                time.sleep(0.3)
            else:
                _log.error("STT %s attempt %d failed: %s", selected_provider, attempt + 1, e)

    if is_remote and last_err is not None:
        _call_circuit_record_failure(circuit_scope, is_timeout=is_timeout_err, is_auth=is_auth_err)

    if is_remote:
        _log.warning("STT fallback to whisper (primary=%s err=%s)", selected_provider, last_err)
        broadcast({"type": fallback_event_type, "scope": circuit_scope, "from": selected_provider, "to": "whisper", "reason": str(last_err)[:80]})
        whisper_loaded = _is_whisper_engine_loaded(whisper_model, whisper_language)
        try:
            if whisper_loaded:
                broadcast({"type": status_event_type, "loaded": True, "loading": False, "provider": "whisper"})
                return _call_whisper_transcribe(
                    audio,
                    sample_rate,
                    position,
                    language,
                    model_size=whisper_model,
                    whisper_language=whisper_language,
                    whisper_lock_timeout_sec=whisper_lock_timeout_sec,
                )
            return _call_whisper_transcribe_fallback(
                audio,
                sample_rate,
                position,
                language,
                model_size=whisper_model,
                whisper_language=whisper_language,
                status_event_type=status_event_type,
                whisper_lock_timeout_sec=whisper_lock_timeout_sec,
            )
        except Exception as e:
            _log.error("Whisper fallback also failed: %s", e, exc_info=True)

    return ""
