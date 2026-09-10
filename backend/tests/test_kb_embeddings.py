from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.kb import embeddings


def test_embed_texts_returns_vectors_with_fake_client(monkeypatch):
    captured = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        return type("R", (), {"data": [
            type("E", (), {"embedding": [0.1, 0.2]}),
            type("E", (), {"embedding": [0.3, 0.4]}),
        ]})()

    client = type("C", (), {"embeddings": type("E", (), {"create": staticmethod(fake_create)})()})()

    embedder = embeddings.OpenAICompatibleEmbedder(client=client, model="text-embedding-3-small")
    vectors = embedder.embed_texts(["hello", "world"])

    assert vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert captured["model"] == "text-embedding-3-small"
    assert captured["input"] == ["hello", "world"]


def test_embed_texts_requires_matching_embedding_count(monkeypatch):
    client = type("C", (), {"embeddings": type("E", (), {"create": lambda self, **kw: type("R", (), {"data": []})()})()})()

    embedder = embeddings.OpenAICompatibleEmbedder(client=client, model="m")

    with pytest.raises(embeddings.EmbeddingError):
        embedder.embed_texts(["one"])


def test_embed_texts_rejects_empty_input():
    embedder = embeddings.OpenAICompatibleEmbedder(client=None, model="m")
    with pytest.raises(ValueError):
        embedder.embed_texts([])


def _make_store(tmp_path, monkeypatch):
    from services.kb.store import KBStore
    store = KBStore(str(tmp_path / "kb.sqlite"))
    store.init_schema()
    return store


def _insert_chunk(store, doc_path, text):
    doc_id = store.upsert_doc(doc_path, mtime=1, size=len(text), loader="test", title=None)
    from services.kb.types import Chunk
    chunk = Chunk(section_path=doc_path, text=text, ord=0)
    store.replace_chunks(doc_id, [chunk])
    from services.kb.indexer import _get_store
    # ensure fresh store instance resolves to tmp db
    return doc_id


def test_save_embeddings_roundtrip(tmp_path, monkeypatch):
    store = _make_store(tmp_path, monkeypatch)
    from services.kb.types import Chunk
    doc_id = store.upsert_doc("a.md", mtime=1, size=1, loader="test", title=None)
    store.replace_chunks(doc_id, [Chunk(section_path="a.md", text="hello", ord=0)])

    row = store.get_chunk_rows(doc_id)
    assert row, "expected at least one chunk"
    chunk_id = row[0]["id"]

    store.save_embeddings({chunk_id: [0.1, 0.2, 0.3]})
    vectors = store.load_embeddings([chunk_id])
    assert vectors[chunk_id] == [0.1, 0.2, 0.3]


def test_semantic_search_by_vector_returns_ranked_hits(tmp_path, monkeypatch):
    store = _make_store(tmp_path, monkeypatch)
    from services.kb.types import Chunk
    doc_id = store.upsert_doc("a.md", mtime=1, size=1, loader="test", title=None)
    store.replace_chunks(doc_id, [
        Chunk(section_path="a.md#1", text="alpha", ord=0),
        Chunk(section_path="a.md#2", text="beta", ord=1),
    ])
    rows = store.get_chunk_rows(doc_id)
    c1, c2 = rows[0]["id"], rows[1]["id"]
    store.save_embeddings({c1: [1.0, 0.0], c2: [0.0, 1.0]})

    hits = store.semantic_search_by_vector([1.0, 0.0], limit=2)
    assert len(hits) == 2
    assert hits[0]["id"] == c1
    assert hits[0]["score"] > hits[1]["score"]


def test_replace_chunks_clears_old_embeddings(tmp_path, monkeypatch):
    store = _make_store(tmp_path, monkeypatch)
    from services.kb.types import Chunk
    doc_id = store.upsert_doc("a.md", mtime=1, size=1, loader="test", title=None)
    store.replace_chunks(doc_id, [Chunk(section_path="a.md", text="v1", ord=0)])
    old_id = store.get_chunk_rows(doc_id)[0]["id"]
    store.save_embeddings({old_id: [1.0]})

    store.replace_chunks(doc_id, [Chunk(section_path="a.md", text="v2", ord=0)])

    assert store.load_embeddings([old_id]) == {}
