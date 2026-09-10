"""OpenAI-compatible embedding provider for optional semantic KB retrieval."""
from __future__ import annotations

from typing import Any, Optional

from core.logger import get_logger

_log = get_logger(__name__)


class EmbeddingError(RuntimeError):
    """Raised when the embedding backend returns unusable output."""


class OpenAICompatibleEmbedder:
    """Wrap an OpenAI-compatible client's ``embeddings.create`` endpoint.

    The client is injected so tests use a fake and production can use the
    project's existing ``get_client_for_model`` helper.
    """

    def __init__(self, client: Any, model: str):
        self.client = client
        self.model = model

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            raise ValueError("texts must not be empty")
        if not self.client:
            raise EmbeddingError("embedding client is not configured")

        response = self.client.embeddings.create(model=self.model, input=texts)
        data = getattr(response, "data", None)
        if data is None or len(data) != len(texts):
            raise EmbeddingError(
                f"embedding response count mismatch: expected {len(texts)}, got {len(data or [])}"
            )
        vectors: list[list[float]] = []
        for item in data:
            embedding = getattr(item, "embedding", None)
            if embedding is None:
                raise EmbeddingError("embedding item missing 'embedding' field")
            vectors.append(list(embedding))
        return vectors
