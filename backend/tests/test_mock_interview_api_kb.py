from __future__ import annotations

import importlib
import sys
from pathlib import Path

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


def test_generate_question_passes_kb_context_when_kb_enabled(tmp_path, monkeypatch):
    from services.kb import retriever as kb_retriever
    from services.kb.types import KBHit

    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    router = importlib.import_module("api.mock_interview.router")
    captured: dict = {}

    def fake_generate_question(*, session, previous_questions, chat_json, **kwargs):
        captured["kb_context"] = kwargs.get("kb_context")
        return {
            "question_text": "基于资料出题：Redis 缓存优化。",
            "question_type": "project",
            "skill_tags": ["Redis"],
        }

    monkeypatch.setattr(router.mock_interview_llm, "generate_question", fake_generate_question)

    class _Cfg:
        kb_enabled = True
        kb_top_k = 4
        kb_deadline_ms = 150

        def __getattr__(self, _name):
            return None

    monkeypatch.setattr(router, "get_config", lambda: _Cfg())

    hit = KBHit(path="notes.md", section_path="s1", text="Redis 缓存优化经验：热点数据、过期策略。", score=0.9)
    monkeypatch.setattr(kb_retriever, "retrieve", lambda *a, **k: [hit])

    with _client() as client:
        created = client.post(
            "/api/mock-interview/sessions",
            json={"company": "ACME", "role": "后端开发", "jd_snapshot": "负责 Redis 相关服务。", "planned_question_count": 1},
        )
        assert created.status_code == 200
        session = created.json()
        q = client.post(f"/api/mock-interview/sessions/{session['id']}/questions")
        assert q.status_code == 200
        assert captured["kb_context"] == [{"path": "notes.md", "text": "Redis 缓存优化经验：热点数据、过期策略。"}]


def test_generate_question_omits_kb_context_when_kb_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    router = importlib.import_module("api.mock_interview.router")
    captured: dict = {}

    def fake_generate_question(*, session, previous_questions, chat_json, **kwargs):
        captured["kb_context"] = kwargs.get("kb_context")
        return {
            "question_text": "普通出题。",
            "question_type": "general",
            "skill_tags": [],
        }

    monkeypatch.setattr(router.mock_interview_llm, "generate_question", fake_generate_question)

    class _Cfg:
        kb_enabled = False

    monkeypatch.setattr(router, "get_config", lambda: _Cfg())

    with _client() as client:
        created = client.post(
            "/api/mock-interview/sessions",
            json={"company": "ACME", "role": "后端开发", "planned_question_count": 1},
        )
        session = created.json()
        q = client.post(f"/api/mock-interview/sessions/{session['id']}/questions")
        assert q.status_code == 200
        assert captured["kb_context"] is None or captured["kb_context"] == []


def test_generate_question_omits_kb_context_when_retrieve_raises(tmp_path, monkeypatch):
    from services.kb import retriever as kb_retriever

    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    router = importlib.import_module("api.mock_interview.router")
    captured: dict = {}

    def fake_generate_question(*, session, previous_questions, chat_json, **kwargs):
        captured["kb_context"] = kwargs.get("kb_context")
        return {"question_text": "出题。", "question_type": "general", "skill_tags": []}

    monkeypatch.setattr(router.mock_interview_llm, "generate_question", fake_generate_question)

    class _Cfg:
        kb_enabled = True
        kb_top_k = 4
        kb_deadline_ms = 150

    monkeypatch.setattr(router, "get_config", lambda: _Cfg())
    monkeypatch.setattr(kb_retriever, "retrieve", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("kb down")))

    with _client() as client:
        created = client.post(
            "/api/mock-interview/sessions",
            json={"company": "ACME", "role": "后端开发", "planned_question_count": 1},
        )
        session = created.json()
        q = client.post(f"/api/mock-interview/sessions/{session['id']}/questions")
        assert q.status_code == 200
        assert captured["kb_context"] is None or captured["kb_context"] == []

def test_export_session_report_returns_markdown_download(tmp_path, monkeypatch):
    import importlib
    router = importlib.import_module("api.mock_interview.router")
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    session = mock_interview.create_session(
        company="ACME", role="后端", language="中文",
        jd_snapshot="", resume_snapshot="", planned_question_count=1,
    )
    q = mock_interview.add_question(session_id=session["id"], seq=1, question_text="Redis 持久化有哪些方式？")
    mock_interview.submit_answer(question_id=q["id"], answer_text="RDB 和 AOF。")
    mock_interview.save_feedback(
        question_id=q["id"], overall_score=7,
        dimensions=[{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
        strengths=["覆盖基础概念"], improvements=["补充混合持久化和取舍"],
        evidence=[], reference_answer="RDB、AOF 与混合持久化。",
    )
    assert mock_interview.finish_session(session["id"])
    mock_interview.save_session_report(
        session_id=session["id"],
        summary_markdown="## 整场总结\n基础概念覆盖较好，但需要补足持久化取舍。",
        strengths=["基础概念覆盖较好"],
        weaknesses=["持久化取舍表达不足"],
        focus_areas=["Redis 持久化与恢复"],
    )

    with _client() as client:
        resp = client.get(f"/api/mock-interview/sessions/{session['id']}/report/export")
        assert resp.status_code == 200
        assert "text/markdown" in resp.headers.get("content-type", "")
        assert "filename*=UTF-8''" in resp.headers.get("content-disposition", "")
        body = resp.content.decode("utf-8")
        assert "ACME" in body
        assert "Redis 持久化与恢复" in body
        assert "整场总结" in body


def test_export_session_report_409_when_not_generated(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(role="后端", planned_question_count=1)

    with _client() as client:
        resp = client.get(f"/api/mock-interview/sessions/{session['id']}/report/export")
        assert resp.status_code == 409

