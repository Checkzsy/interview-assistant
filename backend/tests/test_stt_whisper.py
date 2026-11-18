from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
import requests

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.stt import engines  # noqa: E402

REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


class _FakeWhisperModel:
    """Stands in for faster_whisper.WhisperModel at the dependency boundary."""

    def __init__(self, recorder: list, fail_with: Exception | None = None):
        self._recorder = recorder
        self._fail_with = fail_with

    def __call__(self, model_size_or_path: str, device: str = "auto", compute_type: str = "default"):
        self._recorder.append(model_size_or_path)
        if self._fail_with is not None:
            raise self._fail_with
        path = Path(model_size_or_path)
        if not path.is_absolute() or not path.is_dir():
            raise AssertionError(
                f"WhisperModel must receive an absolute local directory, got {model_size_or_path!r}"
            )
        missing = [name for name in REQUIRED_FILES if not (path / name).is_file()]
        if missing:
            raise AssertionError(f"local model directory is missing {missing}")
        return object()


def _install_fake_faster_whisper(
    monkeypatch: pytest.MonkeyPatch,
    *,
    fail_with: Exception | None = None,
) -> list:
    calls: list = []
    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = _FakeWhisperModel(calls, fail_with=fail_with)
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    return calls


@pytest.fixture(autouse=True)
def _forbid_real_model_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-bundle tests must fake the resolver; none may touch the HF cache or network."""

    def unexpected(*args, **kwargs):
        raise AssertionError("real prepare_model_files reached from a unit test")

    monkeypatch.setattr(engines, "prepare_model_files", unexpected)


def _make_local_model_dir(root: Path, name: str = "resolved") -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    for filename in REQUIRED_FILES:
        (directory / filename).write_text("{}", encoding="utf-8")
    return directory


def _install_fake_resolver(
    monkeypatch: pytest.MonkeyPatch,
    directory: Path,
    *,
    fail_with: Exception | None = None,
) -> tuple[list, dict]:
    calls: list = []
    captured: dict = {"on_progress": None}

    def resolve(model_size: str, on_progress=None):
        calls.append(model_size)
        captured["on_progress"] = on_progress
        if fail_with is not None:
            raise fail_with
        if on_progress is not None:
            on_progress({
                "phase": "resolving", "filename": None,
                "downloaded_bytes": None, "total_bytes": None, "progress": None,
            })
            on_progress({
                "phase": "downloading", "filename": "model.bin",
                "downloaded_bytes": 5, "total_bytes": 10, "progress": 50.0,
            })
            on_progress({
                "phase": "downloaded", "filename": None,
                "downloaded_bytes": 10, "total_bytes": 10, "progress": 100.0,
            })
        return directory

    monkeypatch.setattr(engines, "prepare_model_files", resolve)
    return calls, captured


def _make_bundle(root: Path, *, missing: tuple[str, ...] = ()) -> Path:
    bundled = root / "assets" / "whisper-base"
    bundled.mkdir(parents=True)
    for name in REQUIRED_FILES:
        if name not in missing:
            (bundled / name).write_text("{}", encoding="utf-8")
    return bundled


def test_bundled_model_dir_matches_packaging_contract():
    # engines.py lives at backend/services/stt/engines.py -> parents[2] is backend.
    assert engines._bundled_whisper_model_dir() == BACKEND_DIR / "assets" / "whisper-base"


def test_bundled_base_loads_offline_from_directory(tmp_path, monkeypatch):
    bundled = _make_bundle(tmp_path)
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    calls = _install_fake_faster_whisper(monkeypatch)

    engine = engines.STTEngine(model_size="base")
    engine.load_model()

    assert engine.is_loaded
    assert engine.is_loading is False
    assert calls == [str(bundled)]


def test_bundled_base_without_tokenizer_fails_before_hub_lookup(tmp_path, monkeypatch):
    bundled = _make_bundle(tmp_path, missing=("tokenizer.json",))
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    calls = _install_fake_faster_whisper(monkeypatch)

    engine = engines.STTEngine(model_size="base")
    with pytest.raises(RuntimeError) as excinfo:
        engine.load_model()

    message = str(excinfo.value)
    assert "tokenizer.json" in message
    assert str(bundled) in message
    assert "重新安装" in message
    assert calls == []
    assert engine.is_loaded is False
    assert engine.is_loading is False


@pytest.mark.parametrize("bad_file,data", [
    ("model.bin", b""),
    ("vocabulary.txt", b""),
    ("config.json", b"not-json"),
    ("tokenizer.json", b"[]"),
    ("preprocessor_config.json", b"not-json"),
])
def test_corrupt_bundled_base_fails_before_native_constructor_or_hub(tmp_path, monkeypatch, bad_file, data):
    bundled = _make_bundle(tmp_path)
    (bundled / bad_file).write_bytes(data)
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    calls = _install_fake_faster_whisper(monkeypatch)
    events = []

    engine = engines.STTEngine(model_size="base")
    with pytest.raises(RuntimeError, match=bad_file) as excinfo:
        engine.load_model(progress=events.append)

    assert "重新安装" in str(excinfo.value)
    assert calls == []
    assert engine.is_loaded is False
    assert engine.is_loading is False
    assert all(event["phase"] not in {"ready", "downloaded"} for event in events)
    assert (bundled / bad_file).read_bytes() == data


@pytest.mark.parametrize("missing", REQUIRED_FILES)
def test_bundled_base_reports_each_missing_file(tmp_path, monkeypatch, missing):
    bundled = _make_bundle(tmp_path, missing=(missing,))
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    calls = _install_fake_faster_whisper(monkeypatch)

    with pytest.raises(RuntimeError) as excinfo:
        engines.STTEngine(model_size="base").load_model()

    assert missing in str(excinfo.value)
    assert calls == []


def test_non_base_size_resolves_local_directory_not_bundle(tmp_path, monkeypatch):
    # A bundled base model must never be substituted for a different size.
    _make_bundle(tmp_path)
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    resolved = _make_local_model_dir(tmp_path)
    resolver_calls, captured = _install_fake_resolver(monkeypatch, resolved)
    calls = _install_fake_faster_whisper(monkeypatch)

    engine = engines.STTEngine(model_size="small")
    engine.load_model()

    assert engine.is_loaded
    assert resolver_calls == ["small"]
    assert captured["on_progress"] is not None
    assert calls == [str(resolved)]
    assert calls != ["small"]
    assert calls != [str(tmp_path / "assets" / "whisper-base")]


def test_base_without_bundle_resolves_local_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    resolved = _make_local_model_dir(tmp_path)
    resolver_calls, captured = _install_fake_resolver(monkeypatch, resolved)
    calls = _install_fake_faster_whisper(monkeypatch)

    engine = engines.STTEngine(model_size="base")
    engine.load_model()

    assert engine.is_loaded
    assert resolver_calls == ["base"]
    assert captured["on_progress"] is not None
    assert calls == [str(resolved)]
    assert calls != ["base"]


def test_resolver_progress_is_forwarded_to_load_callback(tmp_path, monkeypatch):
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    resolved = _make_local_model_dir(tmp_path)
    _install_fake_resolver(monkeypatch, resolved)
    _install_fake_faster_whisper(monkeypatch)

    events = []
    engines.STTEngine(model_size="base").load_model(progress=events.append)

    phases = [event["phase"] for event in events]
    assert "resolving" in phases
    assert "downloading" in phases
    # The resolver's terminal "downloaded" event is surfaced as "loading".
    assert "loading" in phases
    assert "downloaded" not in phases
    assert any(event.get("filename") == "model.bin" for event in events)


def test_frozen_build_missing_bundle_never_downloads(tmp_path, monkeypatch):
    missing_bundle = tmp_path / "assets" / "whisper-base"
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: missing_bundle)
    monkeypatch.setattr(engines.sys, "frozen", True, raising=False)
    calls = _install_fake_faster_whisper(monkeypatch)

    engine = engines.STTEngine(model_size="base")
    with pytest.raises(RuntimeError) as excinfo:
        engine.load_model()

    message = str(excinfo.value)
    assert "内置 Whisper 模型目录缺失" in message
    assert str(missing_bundle) in message
    assert "重新安装" in message
    assert calls == []
    assert engine.is_loading is False


def test_corrupt_bundled_model_reports_path_not_network(tmp_path, monkeypatch):
    bundled = _make_bundle(tmp_path)
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    _install_fake_faster_whisper(
        monkeypatch, fail_with=RuntimeError("Unable to open model.bin")
    )

    engine = engines.STTEngine(model_size="base")
    with pytest.raises(RuntimeError) as excinfo:
        engine.load_model()

    message = str(excinfo.value)
    assert "Unable to open model.bin" in message
    assert str(bundled) in message
    assert "重新安装" in message
    assert "网络" not in message
    assert engine.is_loading is False


def test_load_failure_preserves_cause_and_resets_loading(tmp_path, monkeypatch):
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    _install_fake_resolver(monkeypatch, _make_local_model_dir(tmp_path))
    _install_fake_faster_whisper(monkeypatch, fail_with=ValueError("boom"))

    engine = engines.STTEngine(model_size="small")
    with pytest.raises(RuntimeError) as excinfo:
        engine.load_model()

    assert "boom" in str(excinfo.value)
    assert "网络" not in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, ValueError)
    assert engine.is_loaded is False
    assert engine.is_loading is False


def test_network_failure_gets_friendly_download_message(tmp_path, monkeypatch):
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    _install_fake_resolver(
        monkeypatch,
        _make_local_model_dir(tmp_path),
        fail_with=requests.exceptions.ConnectionError("Failed to resolve huggingface.co"),
    )

    engine = engines.STTEngine(model_size="base")
    with pytest.raises(RuntimeError) as excinfo:
        engine.load_model()

    message = str(excinfo.value)
    assert "网络" in message
    assert "huggingface.co" in message
    assert isinstance(excinfo.value.__cause__, requests.exceptions.ConnectionError)
    assert engine.is_loading is False


def test_missing_faster_whisper_dependency_is_actionable(tmp_path, monkeypatch):
    # CI strips faster-whisper from requirements; module scope must stay lazy.
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    _install_fake_resolver(monkeypatch, _make_local_model_dir(tmp_path))
    monkeypatch.setitem(sys.modules, "faster_whisper", None)

    engine = engines.STTEngine(model_size="base")
    with pytest.raises(RuntimeError) as excinfo:
        engine.load_model()

    message = str(excinfo.value)
    assert "faster-whisper" in message
    assert "pip install" in message
    assert "重新安装" in message
    assert engine.is_loading is False


# ---------------------------------------------------------------------------
# 旧版本联网下载的 base 缓存在内置之后成为纯冗余，升级后一次性清掉。
# ---------------------------------------------------------------------------

def _hf_cache_root(tmp_path: Path, repo: str = "models--Systran--faster-whisper-base") -> Path:
    cache = tmp_path / "hub"
    (cache / repo / "snapshots" / "abc123").mkdir(parents=True)
    (cache / repo / "blobs").mkdir(parents=True)
    (cache / repo / "refs").mkdir(parents=True)
    (cache / repo / "blobs" / "deadbeef").write_bytes(b"weights")
    return cache


def test_legacy_download_cache_is_removed_once_the_bundle_takes_over(tmp_path, monkeypatch):
    bundled = _make_bundle(tmp_path / "bundle")
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    cache = _hf_cache_root(tmp_path)
    data = tmp_path / "data"
    monkeypatch.setattr(engines, "_hf_cache_root", lambda: cache)

    engines._prune_superseded_whisper_cache(str(data))

    assert not (cache / "models--Systran--faster-whisper-base").exists()
    marker = data / "whisper-bundled-migration.json"
    assert marker.is_file()
    assert "base" in marker.read_text(encoding="utf-8")


def test_prune_keeps_other_model_sizes_in_the_shared_cache(tmp_path, monkeypatch):
    bundled = _make_bundle(tmp_path / "bundle")
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    cache = _hf_cache_root(tmp_path)
    other = cache / "models--Systran--faster-whisper-small"
    other.mkdir()
    monkeypatch.setattr(engines, "_hf_cache_root", lambda: cache)

    engines._prune_superseded_whisper_cache(str(tmp_path / "data"))

    assert other.is_dir(), "small/medium/large 仍走联网下载，不能连带删除"
    assert not (cache / "models--Systran--faster-whisper-base").exists()


def test_prune_is_once_only_and_leaves_other_models_alone_afterwards(tmp_path, monkeypatch):
    bundled = _make_bundle(tmp_path / "bundle")
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    cache = _hf_cache_root(tmp_path)
    monkeypatch.setattr(engines, "_hf_cache_root", lambda: cache)
    data = tmp_path / "data"

    engines._prune_superseded_whisper_cache(str(data))
    # 用户清理后若又手动下载了 base（例如换回旧版再升级），第二次启动不应再删。
    again = _hf_cache_root(tmp_path)
    assert (again / "models--Systran--faster-whisper-base").is_dir()

    engines._prune_superseded_whisper_cache(str(data))

    assert (again / "models--Systran--faster-whisper-base").is_dir()
