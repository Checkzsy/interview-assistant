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
