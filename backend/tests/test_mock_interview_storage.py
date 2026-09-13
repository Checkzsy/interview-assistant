from __future__ import annotations

import pytest

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.storage import mock_interview


def test_create_session_persists_immutable_context(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    session = mock_interview.create_session(
        company="ACME",
        role="后端开发",
        language="中文",
        jd_snapshot="负责高并发服务",
        resume_snapshot="Python、Redis、FastAPI 项目经历",
        planned_question_count=5,
    )

    assert session["id"] > 0
    assert session["status"] == "created"
    assert session["company"] == "ACME"
    assert session["role"] == "后端开发"
    assert session["language"] == "中文"
    assert session["jd_snapshot"] == "负责高并发服务"
    assert session["resume_snapshot"] == "Python、Redis、FastAPI 项目经历"
    assert session["planned_question_count"] == 5
    assert session["answered_question_count"] == 0
    assert session["average_score"] is None


def test_question_and_answer_roundtrip_preserves_evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(
        company="ACME",
        role="后端开发",
        language="中文",
        jd_snapshot="负责高并发服务",
        resume_snapshot="Python、Redis、FastAPI 项目经历",
        planned_question_count=1,
    )

    question = mock_interview.add_question(
        session_id=session["id"],
        seq=1,
        question_text="请介绍一次你做过的缓存优化。",
        question_type="behavioral",
        skill_tags=["Redis", "性能优化"],
    )
    assert question["status"] == "waiting_answer"

    answer = mock_interview.submit_answer(
        question_id=question["id"],
        answer_text="我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。",
        duration_ms=42_000,
    )
    assert answer["status"] == "answered"
    assert answer["answer_text"] == "我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。"
    assert answer["duration_ms"] == 42_000

    feedback = mock_interview.save_feedback(
        question_id=question["id"],
        overall_score=8,
        dimensions=[
            {"name": "事实正确性", "score": 8, "comment": "技术描述基本正确"},
            {"name": "表达结构", "score": 7, "comment": "缺少背景与结果衔接"},
        ],
        strengths=["量化了性能收益"],
        improvements=["补充排查过程和取舍"],
        evidence=["P95 延迟从 800ms 降到 120ms"],
        reference_answer="建议按背景-做法-结果-取舍结构回答。",
    )
    assert feedback["status"] == "reviewed"
    assert feedback["overall_score"] == 8
    assert feedback["dimensions"][0]["name"] == "事实正确性"
    assert feedback["evidence"] == ["P95 延迟从 800ms 降到 120ms"]

    detail = mock_interview.get_session_detail(session["id"])
    assert detail["status"] == "in_progress"
    assert detail["answered_question_count"] == 1
    assert detail["average_score"] == 8
    assert detail["questions"][0]["answer_text"].startswith("我用 Redis")
    assert detail["questions"][0]["feedback"]["improvements"] == ["补充排查过程和取舍"]


def test_finish_session_requires_all_answered_questions_reviewed(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(
        company="ACME",
        role="后端开发",
        language="中文",
        jd_snapshot="",
        resume_snapshot="",
        planned_question_count=1,
    )
    question = mock_interview.add_question(session_id=session["id"], seq=1, question_text="Redis 持久化有哪些方式？")

    assert mock_interview.finish_session(session["id"]) is False

    mock_interview.submit_answer(question_id=question["id"], answer_text="RDB 和 AOF。")
    assert mock_interview.finish_session(session["id"]) is False

    mock_interview.save_feedback(
        question_id=question["id"],
        overall_score=7,
        dimensions=[{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
        strengths=["覆盖基础概念"],
        improvements=["补充混合持久化和取舍"],
        evidence=[],
        reference_answer="RDB、AOF 与混合持久化。",
    )
    assert mock_interview.finish_session(session["id"]) is True

    detail = mock_interview.get_session_detail(session["id"])
    assert detail["status"] == "completed"
    assert detail["average_score"] == 7


def test_feedback_is_null_until_question_is_reviewed(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(role="后端开发", planned_question_count=1)
    question = mock_interview.add_question(session_id=session["id"], seq=1, question_text="Redis 持久化有哪些方式？")

    assert question["feedback"] is None

    answered = mock_interview.submit_answer(question_id=question["id"], answer_text="RDB 和 AOF。")
    assert answered["feedback"] is None

    reviewed = mock_interview.save_feedback(
        question_id=question["id"],
        overall_score=7,
        dimensions=[{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
        strengths=["覆盖基础概念"],
        improvements=["补充混合持久化和取舍"],
        evidence=[],
        reference_answer="RDB、AOF 与混合持久化。",
    )
    assert reviewed["feedback"] is not None
    assert reviewed["feedback"]["overall_score"] == 7
    assert reviewed["feedback"]["reference_answer"] == "RDB、AOF 与混合持久化。"


def test_list_sessions_returns_real_progress_counts(tmp_path, monkeypatch):
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

    result = mock_interview.list_sessions()
    item = result["items"][0]

    assert item["question_count"] == 1
    assert item["answered_question_count"] == 1
    assert item["reviewed_question_count"] == 1
    assert item["average_score"] == 7


def test_save_and_get_session_report(tmp_path, monkeypatch):
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
    assert mock_interview.finish_session(session["id"]) is True

    saved = mock_interview.save_session_report(
        session_id=session["id"],
        summary_markdown="## 整场总结\n基础概念覆盖较好，但需要补足持久化取舍。",
        strengths=["基础概念覆盖较好"],
        weaknesses=["持久化取舍表达不足"],
        focus_areas=["Redis 持久化与恢复", "缓存场景取舍"],
    )
    assert saved["report_markdown"].startswith("## 整场总结")

    detail = mock_interview.get_session_detail(session["id"])
    assert detail["report_markdown"].startswith("## 整场总结")
    assert detail["report_strengths"] == ["基础概念覆盖较好"]
    assert detail["report_weaknesses"] == ["持久化取舍表达不足"]
    assert detail["report_focus_areas"] == ["Redis 持久化与恢复", "缓存场景取舍"]
    assert detail["report_generated_at"] > 0


def test_finish_session_requires_planned_question_count(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    session = mock_interview.create_session(role="后端开发", planned_question_count=2)

    first = mock_interview.add_question(session_id=session["id"], seq=1, question_text="Redis 持久化有哪些方式？")
    mock_interview.submit_answer(question_id=first["id"], answer_text="RDB 和 AOF。")
    mock_interview.save_feedback(
        question_id=first["id"],
        overall_score=7,
        dimensions=[{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
        strengths=["覆盖基础概念"],
        improvements=["补充混合持久化和取舍"],
        evidence=[],
        reference_answer="RDB、AOF 与混合持久化。",
    )
    assert mock_interview.finish_session(session["id"]) is False

    second = mock_interview.add_question(session_id=session["id"], seq=2, question_text="缓存穿透如何处理？")
    mock_interview.submit_answer(question_id=second["id"], answer_text="布隆过滤器和空值缓存。")
    mock_interview.save_feedback(
        question_id=second["id"],
        overall_score=8,
        dimensions=[{"name": "事实正确性", "score": 8, "comment": "方案正确"}],
        strengths=["方案可行"],
        improvements=["补充边界条件"],
        evidence=[],
        reference_answer="布隆过滤器、空值缓存与接口限流。",
    )
    assert mock_interview.finish_session(session["id"]) is True


def test_create_practice_session_from_completed_parent_report(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    parent = mock_interview.create_session(
        company="ACME",
        role="后端开发",
        language="中文",
        jd_snapshot="负责高并发服务",
        resume_snapshot="做过订单查询优化",
        planned_question_count=1,
    )
    question = mock_interview.add_question(session_id=parent["id"], seq=1, question_text="Redis 持久化有哪些方式？")
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
    assert mock_interview.finish_session(parent["id"])
    mock_interview.save_session_report(
        session_id=parent["id"],
        summary_markdown="## 整场总结\n基础概念覆盖较好，但需要补足持久化取舍。",
        strengths=["基础概念覆盖较好"],
        weaknesses=["持久化取舍表达不足"],
        focus_areas=["Redis 持久化与恢复", "缓存场景取舍"],
    )

    practice = mock_interview.create_practice_session(parent_session_id=parent["id"])

    assert practice["id"] != parent["id"]
    assert practice["parent_session_id"] == parent["id"]
    assert practice["status"] == "created"
    assert practice["company"] == "ACME"
    assert practice["role"] == "后端开发"
    assert practice["language"] == "中文"
    assert practice["jd_snapshot"] == "负责高并发服务"
    assert practice["resume_snapshot"] == "做过订单查询优化"
    assert practice["planned_question_count"] == 2
    assert practice["focus_areas"] == ["Redis 持久化与恢复", "缓存场景取舍"]
    assert practice["question_count"] == 0


def test_create_practice_session_requires_completed_report(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    parent = mock_interview.create_session(role="后端开发", planned_question_count=1)

    with pytest.raises(ValueError, match="已完成且已生成报告"):
        mock_interview.create_practice_session(parent_session_id=parent["id"])


def test_create_practice_session_normalizes_and_caps_focus_areas(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()
    parent = mock_interview.create_session(role="后端开发", planned_question_count=1)
    question = mock_interview.add_question(session_id=parent["id"], seq=1, question_text="综合技术题")
    mock_interview.submit_answer(question_id=question["id"], answer_text="回答")
    mock_interview.save_feedback(
        question_id=question["id"],
        overall_score=6,
        dimensions=[{"name": "事实正确性", "score": 6, "comment": "需要复练"}],
        strengths=[],
        improvements=[],
        evidence=[],
        reference_answer="参考",
    )
    assert mock_interview.finish_session(parent["id"])
    focus_areas = [f"重点-{i}" for i in range(51)] + ["重点-0"]
    mock_interview.save_session_report(
        session_id=parent["id"],
        summary_markdown="## 总结",
        strengths=[],
        weaknesses=[],
        focus_areas=focus_areas,
    )

    practice = mock_interview.create_practice_session(parent_session_id=parent["id"])

    assert practice["planned_question_count"] == 50
    assert len(practice["focus_areas"]) == 50
    assert len(set(practice["focus_areas"])) == 50
    assert practice["focus_areas"][0] == "重点-0"


def test_practice_session_detail_and_list_carry_parent_summary(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    parent = mock_interview.create_session(
        company="ACME",
        role="后端开发",
        language="中文",
        jd_snapshot="负责高并发服务",
        resume_snapshot="Python、Redis、FastAPI 项目经历",
        planned_question_count=1,
    )
    q = mock_interview.add_question(session_id=parent["id"], seq=1, question_text="Redis 持久化有哪些方式？")
    mock_interview.submit_answer(question_id=q["id"], answer_text="RDB 和 AOF。")
    mock_interview.save_feedback(
        question_id=q["id"],
        overall_score=7,
        dimensions=[{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
        strengths=["覆盖基础概念"],
        improvements=["补充混合持久化和取舍"],
        evidence=[],
        reference_answer="RDB、AOF 与混合持久化。",
    )
    assert mock_interview.finish_session(parent["id"])
    report = mock_interview.save_session_report(
        session_id=parent["id"],
        summary_markdown="## 整场总结",
        strengths=["基础覆盖好"],
        weaknesses=["缓存取舍不足"],
        focus_areas=["Redis 持久化与恢复", "缓存场景取舍"],
    )
    assert report["status"] == "completed"

    practice = mock_interview.create_practice_session(parent_session_id=parent["id"])
    assert practice["parent_session_id"] == parent["id"]

    # 详情带 parent_summary（父场次已完成并点评 -> average_score=7.0）
    detail = mock_interview.get_session_detail(practice["id"])
    assert detail is not None
    assert detail["parent_summary"] == {
        "id": parent["id"],
        "average_score": 7.0,
        "focus_areas": ["Redis 持久化与恢复", "缓存场景取舍"],
    }

    # 列表也带 parent_summary
    listing = mock_interview.list_sessions(page_size=10)
    practice_item = next(item for item in listing["items"] if item["id"] == practice["id"])
    assert practice_item["parent_summary"] is not None
    assert practice_item["parent_summary"]["id"] == parent["id"]
    # 非练习会话没有 parent_summary
    parent_item = next(item for item in listing["items"] if item["id"] == parent["id"])
    assert parent_item.get("parent_summary") is None


def test_delete_session_removes_session_and_questions(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_interview, "DB_PATH", str(tmp_path / "mock_interview.db"))
    mock_interview.init_db()

    session = mock_interview.create_session(role="后端", planned_question_count=1)
    q = mock_interview.add_question(session_id=session["id"], seq=1, question_text="Redis 持久化与恢复")
    mock_interview.submit_answer(question_id=q["id"], answer_text="RDB 与 AOF 的区别")

    assert mock_interview.delete_session(session["id"]) is True
    assert mock_interview.get_session_detail(session["id"]) is None
    assert mock_interview.get_question(q["id"]) is None
    # 再次删除返回 False
    assert mock_interview.delete_session(session["id"]) is False

