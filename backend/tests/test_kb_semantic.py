from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture
def setup_semantic_kb(tmp_path, monkeypatch):
    from core import config as cfg_mod
    from services.kb import indexer, retriever

    kb_dir = tmp_path / "kb"
    kb_dir.mkdir()
    (kb_dir / "redis.md").write_text(
        "# Redis persistence\n\n## RDB\n\nRDB is a snapshot persistence mode.\n\n## AOF\n\nAOF appends a write log.",
        encoding="utf-8",
    )
    (kb_dir / "cache.md").write_text(
        "# Cache\n\n## Bloom filter\n\nBloom filters reduce cache penetration.",
        encoding="utf-8",
    )

    cfg = cfg_mod.get_config()
    monkeypatch.setattr(cfg, "kb_dir", str(kb_dir), raising=False)
    monkeypatch.setattr(cfg, "kb_db_path", str(tmp_path / "kb.sqlite"), raising=False)
    monkeypatch.setattr(cfg, "kb_enabled", True, raising=False)
    monkeypatch.setattr(cfg, "kb_min_score", 0.0, raising=False)
    monkeypatch.setattr(cfg, "kb_asr_min_query_chars", 6, raising=False)
    monkeypatch.setattr(cfg, "kb_trigger_modes", ["manual_text"], raising=False)
    monkeypatch.setattr(cfg, "kb_semantic_enabled", False, raising=False)

    indexer.reset()
    indexer.reindex()
    retriever.reset()
    yield retriever
    indexer.reset()


def _hit(path, text):
    from services.kb.types import KBHit
    return KBHit(path=path, section_path=path, text=text, score=0.8, origin="text")


def test_semantic_failure_degrades_to_keyword_only(setup_semantic_kb, monkeypatch):
    """语义检索抛错时，结果必须仍来自 BM25，不能整体失败。"""
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_semantic_enabled", True, raising=False)
    monkeypatch.setattr(get_config(), "kb_semantic_top_k", 4, raising=False)

    def boom(query, k):
        raise RuntimeError("embedding service down")

    monkeypatch.setattr(setup_semantic_kb, "_semantic_search", boom, raising=True)

    hits = setup_semantic_kb.retrieve("RDB snapshot", k=3, deadline_ms=500, mode="manual_text")
    assert hits
    assert any("RDB" in h.text for h in hits)


def test_semantic_hits_are_fused_with_keyword_hits(setup_semantic_kb, monkeypatch):
    """启用语义后，语义独有命中应进入融合结果。"""
    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_semantic_enabled", True, raising=False)
    monkeypatch.setattr(get_config(), "kb_semantic_top_k", 4, raising=False)

    semantic_only = _hit("cache.md", "Bloom filters reduce cache penetration.")
    monkeypatch.setattr(
        setup_semantic_kb,
        "_semantic_search",
        lambda query, k: [semantic_only],
        raising=True,
    )

    hits = setup_semantic_kb.retrieve("cache penetration", k=3, deadline_ms=500, mode="manual_text")
    assert hits
    assert any("Bloom" in h.text for h in hits)


def test_semantic_disabled_returns_keyword_only(setup_semantic_kb):
    """未启用语义时，保持纯 BM25 行为。"""
    hits = setup_semantic_kb.retrieve("RDB snapshot", k=3, deadline_ms=500, mode="manual_text")
    assert hits
    assert all("Bloom" not in h.text for h in hits)


def test_status_exposes_semantic_fields(monkeypatch):
    """/api/kb/status 应透出语义检索开关与 top_k，前端才能展示。"""
    from core.config import get_config
    from api.kb import routes as kb_routes

    monkeypatch.setattr(get_config(), "kb_semantic_enabled", True, raising=False)
    monkeypatch.setattr(get_config(), "kb_semantic_top_k", 6, raising=False)
    monkeypatch.setattr(kb_routes.indexer, "stats", lambda: {}, raising=True)

    import asyncio
    payload = asyncio.run(kb_routes.kb_status())

    assert payload["semantic_enabled"] is True
    assert payload["semantic_top_k"] == 6
