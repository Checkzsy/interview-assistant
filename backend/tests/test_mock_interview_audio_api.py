from __future__ import annotations

import importlib
import io
import sys
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.storage import mock_interview


def _client() -> TestClient:
    router = importlib.import_module("api.mock_interview.router")
    app = FastAPI()
    app.include_router(router.router, prefix="/api")
    return TestClient(app)


def _wav_bytes(frames: np.ndarray, sr: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((frames * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


def test_mock_interview_audio_answer_transcribes_and_persists(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    router = importlib.import_module("api.mock_interview.router")
    audio_mod = importlib.import_module("services.mock_interview_audio")
    calls: dict = {}

    def fake_generate_question(*, session, previous_questions, chat_json, **kwargs):
        return {"question_text": "请介绍一次你做过的事情。", "question_type": "general", "skill_tags": []}

    def fake_transcribe(audio, sample_rate, position, language, **kwargs):
        calls["position"] = position
        calls["language"] = language
        return "我用 Redis 做缓存优化。"

    monkeypatch.setattr(router.mock_interview_llm, "generate_question", fake_generate_question)
    monkeypatch.setattr(audio_mod, "transcribe_answer", fake_transcribe)

    async def _no_kb(session):
        return []

    monkeypatch.setattr(router, "_kb_context_for_question", _no_kb)

    wav = _wav_bytes(np.zeros(16000, dtype=np.float32))

    with _client() as client:
        created = client.post(
            "/api/mock-interview/sessions",
            json={"company": "ACME", "role": "后端开发", "planned_question_count": 1},
        )
        assert created.status_code == 200
        session = created.json()
        q = client.post(f"/api/mock-interview/sessions/{session['id']}/questions")
        assert q.status_code == 200
        question = q.json()

        resp = client.post(
            f"/api/mock-interview/questions/{question['id']}/answer/audio",
            files={"file": ("answer.wav", wav, "audio/wav")},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "answered"
        assert body["answer_text"] == "我用 Redis 做缓存优化。"


def test_mock_interview_audio_answer_rejects_invalid_wav(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    router = importlib.import_module("api.mock_interview.router")

    with _client() as client:
        resp = client.post(
            "/api/mock-interview/questions/999/answer/audio",
            files={"file": ("bad.wav", b"not a wav", "audio/wav")},
        )
        assert resp.status_code == 422
