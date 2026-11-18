"""/options 必须如实标注哪些 Whisper 模型是安装包内置的。

用户安装桌面版后无法从下拉列表区分：base 已随安装包提供（离线可用），
其余模型需要联网下载。这里以实际存在的内置目录为准，不写死模型名。
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

common_router = importlib.import_module("api.common.router")
model_files = importlib.import_module("services.stt.model_files")


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def test_options_marks_bundled_models(monkeypatch, tmp_path):
    bundled = tmp_path / "whisper-base"
    bundled.mkdir()
    for name in model_files._BUNDLED_WHISPER_FILES:
        (bundled / name).write_bytes(b"x")
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: bundled)

    payload = _run(common_router.api_options())

    assert payload["bundled_whisper_models"] == ["base"]
    # The full selectable list is unchanged; the marker is additive.
    assert payload["whisper_models"] == common_router.WHISPER_MODEL_OPTIONS


def test_options_reports_no_bundled_models_without_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: tmp_path / "missing")

    payload = _run(common_router.api_options())

    assert payload["bundled_whisper_models"] == []


def test_options_requires_a_complete_bundled_directory(monkeypatch, tmp_path):
    bundled = tmp_path / "whisper-base"
    bundled.mkdir()
    (bundled / "config.json").write_bytes(b"x")  # missing model.bin etc.

    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: bundled)

    assert _run(common_router.api_options())["bundled_whisper_models"] == []
