"""模型下拉必须反映磁盘真实状态：已内置 / 已下载 / 需下载，并给出可删除的路径。

用户下载完 medium 后希望看到“已下载”，并能找到文件自行删除；删除之后
应重新变回“需下载”，下次使用再次下载。
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

model_files = importlib.import_module("services.stt.model_files")


def _write_complete_model(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in model_files._BUNDLED_WHISPER_FILES:
        if name.endswith(".json"):
            (directory / name).write_text("{}", encoding="utf-8")
        else:
            (directory / name).write_bytes(b"x")


def test_reports_bundled_model_with_installer_path(monkeypatch, tmp_path):
    bundled = tmp_path / "whisper-base"
    _write_complete_model(bundled)
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: bundled)
    monkeypatch.setattr(model_files, "_hf_cache_root", lambda: tmp_path / "hf")

    states = {item["model"]: item for item in model_files.whisper_model_states(["base", "medium"])}

    assert states["base"]["status"] == "bundled"
    assert states["base"]["path"] == str(bundled.resolve())
    # Bundled files live inside the install directory; deleting them breaks the
    # app, so the UI must not present that path as user-removable.
    assert states["base"]["deletable"] is False


def test_reports_downloaded_cache_with_its_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: tmp_path / "missing")
    cache_dir = tmp_path / "hf"
    cached = cache_dir / "models--Systran--faster-whisper-medium" / "snapshots" / "abc123"
    _write_complete_model(cached)

    monkeypatch.setattr(model_files, "_hf_cache_root", lambda: cache_dir)
    monkeypatch.setattr(
        model_files,
        "_cached_directory",
        lambda repo_id, root: cached.resolve() if "medium" in repo_id else None,
    )

    states = {item["model"]: item for item in model_files.whisper_model_states(["medium"])}

    assert states["medium"]["status"] == "downloaded"
    # The bulky weights live in `blobs/` beside `snapshots/`, so deleting only the
    # snapshot directory frees nothing. Show the repo dir that owns both.
    assert states["medium"]["path"] == str(cached.parent.parent.resolve())
    assert states["medium"]["deletable"] is True


def test_reports_missing_model_with_expected_cache_root(monkeypatch, tmp_path):
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: tmp_path / "missing")
    monkeypatch.setattr(model_files, "_cached_directory", lambda repo_id, root: None)
    cache_dir = tmp_path / "hf"
    monkeypatch.setattr(model_files, "_hf_cache_root", lambda: cache_dir)

    states = {item["model"]: item for item in model_files.whisper_model_states(["small"])}

    assert states["small"]["status"] == "missing"
    # Still show where it will land, so the user can find it after downloading.
    assert states["small"]["path"] == str(cache_dir.resolve())
    assert states["small"]["deletable"] is False


def test_incomplete_cache_directory_is_not_reported_as_downloaded(monkeypatch, tmp_path):
    """A half-written snapshot must not claim to be ready."""
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: tmp_path / "missing")
    broken = tmp_path / "hf" / "models--Systran--faster-whisper-small" / "snapshots" / "abc"
    broken.mkdir(parents=True)
    (broken / "config.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(model_files, "_hf_cache_root", lambda: tmp_path / "hf")
    monkeypatch.setattr(model_files, "_cached_directory", lambda repo_id, root: broken.resolve())

    states = {item["model"]: item for item in model_files.whisper_model_states(["small"])}

    assert states["small"]["status"] == "missing"


def test_models_endpoint_returns_every_selectable_model(monkeypatch, tmp_path):
    """/api/stt/models 是设置页的数据源，必须覆盖整个下拉列表。"""
    import asyncio

    common_router = importlib.import_module("api.common.router")
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: tmp_path / "missing")
    monkeypatch.setattr(model_files, "_hf_cache_root", lambda: tmp_path / "hf")
    monkeypatch.setattr(model_files, "_cached_directory", lambda repo_id, root: None)

    payload = asyncio.run(common_router.api_stt_models())

    assert [item["model"] for item in payload["models"]] == common_router.WHISPER_MODEL_OPTIONS
    assert {item["status"] for item in payload["models"]} == {"missing"}
