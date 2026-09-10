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
