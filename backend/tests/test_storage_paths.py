from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.storage import paths


def test_data_dir_can_be_overridden_for_packaged_apps(tmp_path, monkeypatch):
    target = tmp_path / "user-data"
    monkeypatch.setenv("IA_DATA_DIR", str(target))

    assert paths.data_dir() == str(target)
    assert paths.sqlite_path("mock_interview.db") == str(target / "mock_interview.db")


def test_data_dir_defaults_to_backend_data_without_override(tmp_path, monkeypatch):
    monkeypatch.delenv("IA_DATA_DIR", raising=False)

    assert paths.data_dir() == str(BACKEND_DIR / "data")


def test_kb_relative_paths_follow_the_data_dir_override(tmp_path, monkeypatch):
    """KB 的 data/kb 等相对路径必须跟着 IA_DATA_DIR 走。

    回归：知识库曾用 backend_root() 解析相对路径，打包后落在安装目录里；升级时
    NSIS 用 --updated 卸载旧版本会连 $INSTDIR 一起删掉，用户上传的文档和索引随之消失。
    配置里的 "data/..." 指的就是 data_dir()，与 knowledge.db 等库同级。
    """
    data_root = tmp_path / "user-data" / "data"
    monkeypatch.setenv("IA_DATA_DIR", str(data_root))

    from core.config import get_config
    from services.kb.indexer import resolve_path

    cfg = get_config()
    monkeypatch.setattr(cfg, "kb_dir", "data/kb", raising=False)
    monkeypatch.setattr(cfg, "kb_db_path", "data/kb.sqlite", raising=False)

    assert resolve_path(cfg.kb_dir) == data_root / "kb"
    assert resolve_path(cfg.kb_db_path) == data_root / "kb.sqlite"
    # 与其它 SQLite 库落在同一目录，升级不会跨目录丢数据
    assert resolve_path(cfg.kb_db_path).parent == Path(paths.sqlite_path("knowledge.db")).parent
