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


def test_mock_interview_text_flow_persists_question_answer_and_feedback(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    router = importlib.import_module("api.mock_interview.router")
    generated_sessions: list[dict] = []
    generated_previous: list[list[dict]] = []

    def fake_generate_question(*, session, previous_questions, chat_json):
        generated_sessions.append(session)
        generated_previous.append(previous_questions)
        return {
            "question_text": "请介绍你在 FastAPI 项目中做过的一次接口性能优化。",
            "question_type": "project",
            "skill_tags": ["FastAPI", "性能优化"],
        }

    def fake_generate_feedback(*, question, chat_json):
        assert question["answer_text"].startswith("我用 Redis")
        return {
            "overall_score": 8,
            "dimensions": [
                {"name": "事实正确性", "score": 8, "comment": "技术描述基本正确"},
                {"name": "表达结构", "score": 7, "comment": "缺少背景与结果衔接"},
            ],
            "strengths": ["量化了性能收益"],
            "improvements": ["补充排查过程和取舍"],
            "evidence": ["P95 延迟从 800ms 降到 120ms"],
            "reference_answer": "建议按背景-做法-结果-取舍结构回答。",
        }

    monkeypatch.setattr(router.mock_interview_llm, "generate_question", fake_generate_question)
    monkeypatch.setattr(router.mock_interview_llm, "generate_feedback", fake_generate_feedback)

    with _client() as client:
        created = client.post(
            "/api/mock-interview/sessions",
            json={
                "company": "ACME",
                "role": "后端开发",
                "language": "中文",
                "jd_snapshot": "负责高并发服务，熟悉 Redis 和 FastAPI。",
                "resume_snapshot": "做过订单查询接口优化，P95 从 800ms 降到 120ms。",
                "planned_question_count": 1,
            },
        )
        assert created.status_code == 200
        session = created.json()
        assert session["status"] == "created"
        assert session["planned_question_count"] == 1

        question_res = client.post(f"/api/mock-interview/sessions/{session['id']}/questions")
        assert question_res.status_code == 200
        question = question_res.json()
        assert question["seq"] == 1
        assert question["status"] == "waiting_answer"
        assert question["skill_tags"] == ["FastAPI", "性能优化"]

        answer_res = client.post(
            f"/api/mock-interview/questions/{question['id']}/answer",
            json={"answer_text": "我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。", "duration_ms": 42000},
        )
        assert answer_res.status_code == 200
        assert answer_res.json()["status"] == "answered"

        feedback_res = client.post(f"/api/mock-interview/questions/{question['id']}/feedback")
        assert feedback_res.status_code == 200
        feedback = feedback_res.json()
        assert feedback["status"] == "reviewed"
        assert feedback["overall_score"] == 8
        assert feedback["feedback"]["evidence"] == ["P95 延迟从 800ms 降到 120ms"]

        finish_res = client.post(f"/api/mock-interview/sessions/{session['id']}/finish")
        assert finish_res.status_code == 200
        assert finish_res.json() == {"ok": True, "status": "completed"}

        detail_res = client.get(f"/api/mock-interview/sessions/{session['id']}")
        assert detail_res.status_code == 200
        detail = detail_res.json()
        assert detail["status"] == "completed"
        assert detail["answered_question_count"] == 1
        assert detail["average_score"] == 8

        list_res = client.get("/api/mock-interview/sessions")
        assert list_res.status_code == 200
        assert list_res.json()["items"][0]["id"] == session["id"]

    assert generated_sessions[0]["role"] == "后端开发"
    assert generated_sessions[0]["jd_snapshot"].startswith("负责高并发服务")
    assert generated_previous[0] == []


def test_finish_rejects_unreviewed_session(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(role="后端开发", planned_question_count=1)
    mock_interview.add_question(session_id=session["id"], seq=1, question_text="Redis 持久化有哪些方式？")

    with _client() as client:
        res = client.post(f"/api/mock-interview/sessions/{session['id']}/finish")

    assert res.status_code == 409
    assert "未完成" in res.json()["detail"]


def test_missing_session_returns_404(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    with _client() as client:
        res = client.get("/api/mock-interview/sessions/999")

    assert res.status_code == 404


def test_mock_interview_router_is_mounted_in_main_app():
    source = (BACKEND_DIR / "main.py").read_text(encoding="utf-8")
    assert "mock_interview" in source
    assert 'app.include_router(mock_interview.router, prefix="/api")' in source


def test_main_app_lifespan_initializes_mock_interview_db():
    source = (BACKEND_DIR / "main.py").read_text(encoding="utf-8")
    assert "mock_interview.init_db()" in source


def test_generate_session_report_endpoint_saves_completed_report(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(role="后端开发", planned_question_count=1)
    question = mock_interview.add_question(session_id=session["id"], seq=1, question_text="Redis 持久化有哪些方式？")
    mock_interview.submit_answer(question_id=question["id"], answer_text="RDB 和 AOF。")
    mock_interview.save_feedback(
        question_id=question["id"],
        overall_score=7,
        dimensions=[{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
        strengths=["覆盖基础概念"],
        improvements=["补充混合持久化和取舍"],
        evidence=[],
        reference_answer="RDB、AOF 与混合持久化。",
    )
    assert mock_interview.finish_session(session["id"])

    router = importlib.import_module("api.mock_interview.router")
    received_sessions: list[dict] = []

    def fake_report(*, session, chat_json):
        received_sessions.append(session)
        return {
            "summary_markdown": "## 整场总结\n基础概念覆盖较好，但需要补足持久化取舍。",
            "strengths": ["基础概念覆盖较好"],
            "weaknesses": ["持久化取舍表达不足"],
            "focus_areas": ["Redis 持久化与恢复", "缓存场景取舍"],
        }

    monkeypatch.setattr(router.mock_interview_llm, "generate_session_report", fake_report)

    with _client() as client:
        res = client.post(f"/api/mock-interview/sessions/{session['id']}/report")

    assert res.status_code == 200
    data = res.json()
    assert data["report_markdown"].startswith("## 整场总结")
    assert data["report_strengths"] == ["基础概念覆盖较好"]
    assert data["report_weaknesses"] == ["持久化取舍表达不足"]
    assert data["report_focus_areas"] == ["Redis 持久化与恢复", "缓存场景取舍"]
    assert received_sessions[0]["id"] == session["id"]
    assert received_sessions[0]["questions"][0]["answer_text"] == "RDB 和 AOF。"


def test_generate_session_report_rejects_unfinished_session(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(role="后端开发", planned_question_count=1)

    with _client() as client:
        res = client.post(f"/api/mock-interview/sessions/{session['id']}/report")

    assert res.status_code == 409
    assert "未完成" in res.json()["detail"]
