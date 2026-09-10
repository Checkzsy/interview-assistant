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


def test_semantic_search_without_model_returns_empty(monkeypatch):
    from core.config import get_config
    from services.kb import retriever

    monkeypatch.setattr(get_config(), "kb_semantic_model", "", raising=False)
    assert retriever._semantic_search("anything", 4) == []


def test_semantic_search_uses_vector_store_when_model_configured(setup_semantic_kb, monkeypatch):
    from core.config import get_config
    from services.kb import retriever

    monkeypatch.setattr(get_config(), "kb_semantic_model", "text-embedding-3-small", raising=False)
    monkeypatch.setattr(get_config(), "kb_semantic_enabled", True, raising=False)

    semantic_hit = _hit("cache.md", "Bloom filters reduce cache penetration.")

    class FakeEmbedder:
        def __init__(self, client, model):
            self.client = client
            self.model = model

        def embed_texts(self, texts):
            return [[1.0, 0.0]]

    class FakeStore:
        def semantic_search_by_vector(self, vector, limit):
            return [
                {
                    "path": semantic_hit.path,
                    "section_path": semantic_hit.section_path,
                    "text": semantic_hit.text,
                    "score": 0.9,
                    "page": None,
                    "origin": "text",
                }
            ]

    monkeypatch.setattr("services.kb.embeddings.OpenAICompatibleEmbedder", FakeEmbedder)
    monkeypatch.setattr(retriever, "_get_store", lambda: FakeStore())
    monkeypatch.setattr(
        "services.llm.streaming.get_client_for_model",
        lambda model: object(),
        raising=False,
    )

    hits = retriever._semantic_search("cache penetration", 4)
    assert hits
    assert hits[0].path == "cache.md"
    assert hits[0].score > 0.8


def test_indexer_embed_doc_chunks_writes_vectors(setup_semantic_kb, tmp_path, monkeypatch):
    from services.kb import indexer
    from services.kb.embeddings import OpenAICompatibleEmbedder

    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_semantic_model", "text-embedding-3-small", raising=False)

    # Reindex creates doc+chunks first.
    indexer.reindex()
    doc_rows = indexer.list_docs()
    assert doc_rows, "expected docs after reindex"

    store = indexer._get_store()
    doc_id = doc_rows[0]["id"]
    chunk_ids = [r["id"] for r in store.get_chunk_rows(doc_id)]
    assert chunk_ids

    class FakeEmbedder:
        def __init__(self, client, model):
            pass

        def embed_texts(self, texts):
            return [[float(i + 1)] for i in range(len(texts))]

    monkeypatch.setattr(OpenAICompatibleEmbedder, "__init__", FakeEmbedder.__init__)
    monkeypatch.setattr(OpenAICompatibleEmbedder, "embed_texts", FakeEmbedder.embed_texts)

    indexer.embed_doc_chunks(doc_id, chunk_ids)

    vectors = store.load_embeddings(chunk_ids)
    assert len(vectors) == len(chunk_ids)
    assert all(len(v) == 1 for v in vectors.values())


def test_indexer_embed_doc_chunks_degrades_on_embedder_error(setup_semantic_kb, tmp_path, monkeypatch):
    from services.kb import indexer

    from core.config import get_config
    monkeypatch.setattr(get_config(), "kb_semantic_model", "text-embedding-3-small", raising=False)

    indexer.reindex()
    store = indexer._get_store()
    doc_id = indexer.list_docs()[0]["id"]
    chunk_ids = [r["id"] for r in store.get_chunk_rows(doc_id)]

    class BrokenEmbedder:
        def __init__(self, client, model):
            pass

        def embed_texts(self, texts):
            raise RuntimeError("embedding down")

    from services.kb.embeddings import OpenAICompatibleEmbedder
    monkeypatch.setattr(OpenAICompatibleEmbedder, "__init__", BrokenEmbedder.__init__)
    monkeypatch.setattr(OpenAICompatibleEmbedder, "embed_texts", BrokenEmbedder.embed_texts)

    # Should not raise; caller treats semantic index as optional.
    indexer.embed_doc_chunks(doc_id, chunk_ids)


def test_reindex_auto_embeds_when_semantic_model_configured(setup_semantic_kb, monkeypatch):
    from core.config import get_config
    from services.kb import indexer

    monkeypatch.setattr(get_config(), "kb_semantic_model", "text-embedding-3-small", raising=False)

    # 新增一个文件，强制 reindex 走到 replace_chunks 分支
    from core.config import get_config
    from services.kb.indexer import resolve_path
    kb_dir = Path(resolve_path(get_config().kb_dir))
    (kb_dir / "new.md").write_text("# New notes\n\nRedis Cluster basics.", encoding="utf-8")

    calls: list[tuple[int, list[int]]] = []
    monkeypatch.setattr(indexer, "embed_doc_chunks", lambda doc_id, chunk_ids: calls.append((doc_id, chunk_ids)), raising=False)

    indexer.reindex()

    assert calls, "reindex should call embed_doc_chunks when semantic model is configured"
