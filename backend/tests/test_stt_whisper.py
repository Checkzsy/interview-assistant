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

    def __init__(self, recorder: list, offline: bool, fail_with: Exception | None = None):
        self._recorder = recorder
        self._offline = offline
        self._fail_with = fail_with

    def __call__(self, model_size_or_path: str, device: str = "auto", compute_type: str = "default"):
        self._recorder.append(model_size_or_path)
        if self._fail_with is not None:
            raise self._fail_with
        path = Path(model_size_or_path)
        if not path.is_dir():
            if self._offline:
                raise AssertionError(
                    f"offline load attempted to resolve {model_size_or_path!r} through the HF hub"
                )
            return object()
        missing = [name for name in REQUIRED_FILES if not (path / name).is_file()]
        if missing:
            raise AssertionError(f"bundled directory is missing {missing}")
        return object()


def _install_fake_faster_whisper(
    monkeypatch: pytest.MonkeyPatch,
    *,
    offline: bool,
    fail_with: Exception | None = None,
) -> list:
    calls: list = []
    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = _FakeWhisperModel(calls, offline=offline, fail_with=fail_with)
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    return calls


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
    calls = _install_fake_faster_whisper(monkeypatch, offline=True)

    engine = engines.STTEngine(model_size="base")
    engine.load_model()

    assert engine.is_loaded
    assert engine.is_loading is False
    assert calls == [str(bundled)]


def test_bundled_base_without_tokenizer_fails_before_hub_lookup(tmp_path, monkeypatch):
    bundled = _make_bundle(tmp_path, missing=("tokenizer.json",))
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    calls = _install_fake_faster_whisper(monkeypatch, offline=True)

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


@pytest.mark.parametrize("missing", REQUIRED_FILES)
def test_bundled_base_reports_each_missing_file(tmp_path, monkeypatch, missing):
    bundled = _make_bundle(tmp_path, missing=(missing,))
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: bundled)
    calls = _install_fake_faster_whisper(monkeypatch, offline=True)

    with pytest.raises(RuntimeError) as excinfo:
        engines.STTEngine(model_size="base").load_model()

    assert missing in str(excinfo.value)
    assert calls == []


def test_non_base_size_still_uses_online_name(tmp_path, monkeypatch):
    # A bundled base model must never be substituted for a different size.
    _make_bundle(tmp_path)
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    calls = _install_fake_faster_whisper(monkeypatch, offline=False)

    engine = engines.STTEngine(model_size="small")
    engine.load_model()

    assert engine.is_loaded
    assert calls == ["small"]


def test_dev_without_bundle_keeps_online_download_behavior(tmp_path, monkeypatch):
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    calls = _install_fake_faster_whisper(monkeypatch, offline=False)

    engine = engines.STTEngine(model_size="base")
    engine.load_model()

    assert engine.is_loaded
    assert calls == ["base"]


def test_frozen_build_missing_bundle_never_downloads(tmp_path, monkeypatch):
    missing_bundle = tmp_path / "assets" / "whisper-base"
    monkeypatch.setattr(engines, "_bundled_whisper_model_dir", lambda: missing_bundle)
    monkeypatch.setattr(engines.sys, "frozen", True, raising=False)
    calls = _install_fake_faster_whisper(monkeypatch, offline=True)

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
        monkeypatch, offline=True, fail_with=RuntimeError("Unable to open model.bin")
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
    _install_fake_faster_whisper(monkeypatch, offline=True, fail_with=ValueError("boom"))

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
    _install_fake_faster_whisper(
        monkeypatch,
        offline=True,
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


def test_missing_faster_whisper_dependency_is_actionable(monkeypatch):
    # CI strips faster-whisper from requirements; module scope must stay lazy.
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
