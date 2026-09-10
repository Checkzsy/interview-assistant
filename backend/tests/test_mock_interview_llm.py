from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import mock_interview_llm


def test_generate_question_uses_session_context_and_previous_questions():
    prompts: list[str] = []

    def fake_chat(prompt: str):
        prompts.append(prompt)
        return {
            "question_text": "请介绍你在 FastAPI 项目中做过的一次接口性能优化。",
            "question_type": "project",
            "skill_tags": ["FastAPI", "性能优化"],
        }

    result = mock_interview_llm.generate_question(
        session={
            "company": "ACME",
            "role": "后端开发",
            "language": "中文",
            "jd_snapshot": "负责高并发服务，熟悉 Redis 和 FastAPI。",
            "resume_snapshot": "做过订单查询接口优化，P95 从 800ms 降到 120ms。",
        },
        previous_questions=[
            {"seq": 1, "question_text": "请介绍一次你做过的缓存优化。"}
        ],
        chat_json=fake_chat,
    )

    assert result == {
        "question_text": "请介绍你在 FastAPI 项目中做过的一次接口性能优化。",
        "question_type": "project",
        "skill_tags": ["FastAPI", "性能优化"],
    }
    assert len(prompts) == 1
    assert "负责高并发服务" in prompts[0]
    assert "P95 从 800ms 降到 120ms" in prompts[0]
    assert "请介绍一次你做过的缓存优化。" in prompts[0]
    assert "不得编造简历中不存在的经历" in prompts[0]


def test_generate_feedback_parses_fenced_json_and_preserves_evidence():
    def fake_chat(prompt: str):
        assert "我用 Redis 缓存热点查询" in prompt
        return """```json
        {
          "overall_score": 8,
          "dimensions": [
            {"name": "事实正确性", "score": 8, "comment": "技术描述基本正确"},
            {"name": "表达结构", "score": 7, "comment": "缺少背景与结果衔接"}
          ],
          "strengths": ["量化了性能收益"],
          "improvements": ["补充排查过程和取舍"],
          "evidence": ["P95 延迟从 800ms 降到 120ms"],
          "reference_answer": "建议按背景-做法-结果-取舍结构回答。"
        }
        ```"""

    result = mock_interview_llm.generate_feedback(
        question={
            "question_text": "请介绍一次你做过的缓存优化。",
            "answer_text": "我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。",
        },
        chat_json=fake_chat,
    )

    assert result["overall_score"] == 8
    assert result["dimensions"][0]["name"] == "事实正确性"
    assert result["strengths"] == ["量化了性能收益"]
    assert result["improvements"] == ["补充排查过程和取舍"]
    assert result["evidence"] == ["P95 延迟从 800ms 降到 120ms"]
    assert result["reference_answer"].startswith("建议按")


def test_generate_feedback_rejects_out_of_range_score():
    with pytest.raises(mock_interview_llm.MockInterviewLLMError) as exc_info:
        mock_interview_llm.generate_feedback(
            question={
                "question_text": "Redis 持久化有哪些方式？",
                "answer_text": "RDB 和 AOF。",
            },
            chat_json=lambda prompt: {
                "overall_score": 11,
                "dimensions": [],
                "strengths": [],
                "improvements": [],
                "evidence": [],
                "reference_answer": "RDB、AOF 与混合持久化。",
            },
        )

    assert "overall_score" in str(exc_info.value)
    assert "11" not in str(exc_info.value)


def test_default_chat_json_uses_configured_review_model(monkeypatch):
    import sys
    import types
    from types import SimpleNamespace

    created: dict = {}

    def fake_create(**kwargs):
        created.update(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))]
        )

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create)))
    streaming_module = types.ModuleType("services.llm.streaming")
    streaming_module.get_client_for_model = lambda model: client
    config_module = types.ModuleType("core.config")
    config_module.get_config = lambda: SimpleNamespace(
        get_review_model=lambda: SimpleNamespace(api_key="test-key", model="review-model")
    )

    monkeypatch.setitem(sys.modules, "core.config", config_module)
    monkeypatch.setitem(sys.modules, "services.llm.streaming", streaming_module)

    result = mock_interview_llm.default_chat_json("生成一道题")

    assert result == '{"ok": true}'
    assert created["model"] == "review-model"
    assert created["messages"][1]["content"] == "生成一道题"


def test_generate_question_prompt_includes_previous_answers_for_follow_ups():
    prompts: list[str] = []

    def fake_chat(prompt: str):
        prompts.append(prompt)
        return {
            "question_text": "你刚才提到 P95 降到 120ms，具体做了哪些排查？",
            "question_type": "project",
            "skill_tags": ["性能优化"],
        }

    mock_interview_llm.generate_question(
        session={"role": "后端开发", "language": "中文", "jd_snapshot": "", "resume_snapshot": ""},
        previous_questions=[
            {
                "seq": 1,
                "question_text": "请介绍一次你做过的缓存优化。",
                "answer_text": "我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。",
                "status": "reviewed",
            }
        ],
        chat_json=fake_chat,
    )

    assert "我用 Redis 缓存热点查询" in prompts[0]
    assert "候选人回答" in prompts[0]


def test_generate_session_report_uses_reviewed_answers_and_feedback():
    prompts: list[str] = []

    def fake_chat(prompt: str):
        prompts.append(prompt)
        return {
            "summary_markdown": "## 整场总结\n基础概念覆盖较好，但需要补足持久化取舍。",
            "strengths": ["基础概念覆盖较好"],
            "weaknesses": ["持久化取舍表达不足"],
            "focus_areas": ["Redis 持久化与恢复", "缓存场景取舍"],
        }

    result = mock_interview_llm.generate_session_report(
        session={
            "company": "ACME",
            "role": "后端开发",
            "language": "中文",
            "jd_snapshot": "负责高并发服务",
            "resume_snapshot": "做过订单查询优化",
            "questions": [
                {
                    "seq": 1,
                    "question_text": "Redis 持久化有哪些方式？",
                    "answer_text": "RDB 和 AOF。",
                    "overall_score": 7,
                    "feedback": {
                        "dimensions": [{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
                        "improvements": ["补充混合持久化和取舍"],
                    },
                }
            ],
        },
        chat_json=fake_chat,
    )

    assert result["summary_markdown"].startswith("## 整场总结")
    assert result["strengths"] == ["基础概念覆盖较好"]
    assert result["weaknesses"] == ["持久化取舍表达不足"]
    assert result["focus_areas"] == ["Redis 持久化与恢复", "缓存场景取舍"]
    assert "RDB 和 AOF。" in prompts[0]
    assert "补充混合持久化和取舍" in prompts[0]
    assert "负责高并发服务" in prompts[0]


def test_required_llm_text_rejects_whitespace_only_values():
    import pytest

    with pytest.raises(mock_interview_llm.MockInterviewLLMError):
        mock_interview_llm.generate_question(
            session={"role": "后端开发", "language": "中文"},
            chat_json=lambda prompt: {
                "question_text": "   ",
                "question_type": "project",
                "skill_tags": [],
            },
        )

    with pytest.raises(mock_interview_llm.MockInterviewLLMError):
        mock_interview_llm.generate_session_report(
            session={"role": "后端开发", "questions": []},
            chat_json=lambda prompt: {
                "summary_markdown": "   ",
                "strengths": [],
                "weaknesses": [],
                "focus_areas": [],
            },
        )


def test_generate_question_prompt_prioritizes_practice_focus_areas():
    prompts: list[str] = []

    def fake_chat(prompt: str):
        prompts.append(prompt)
        return {
            "question_text": "请对比 Redis RDB 与 AOF 的恢复流程和取舍。",
            "question_type": "technical",
            "skill_tags": ["Redis", "持久化"],
        }

    mock_interview_llm.generate_question(
        session={
            "role": "后端开发",
            "language": "中文",
            "jd_snapshot": "",
            "resume_snapshot": "",
            "focus_areas": ["Redis 持久化与恢复", "缓存场景取舍"],
        },
        chat_json=fake_chat,
    )

    assert "弱项复练重点" in prompts[0]
    assert "Redis 持久化与恢复" in prompts[0]
    assert "缓存场景取舍" in prompts[0]
    assert "本题必须围绕“本题弱项复练重点”出题" in prompts[0]


def test_generate_question_prompt_rotates_practice_focus_area_by_seq():
    prompts: list[str] = []

    def fake_chat(prompt: str):
        prompts.append(prompt)
        return {
            "question_text": "练习题",
            "question_type": "technical",
            "skill_tags": [],
        }

    session = {
        "role": "后端开发",
        "language": "中文",
        "focus_areas": ["Redis 持久化与恢复", "缓存场景取舍"],
    }
    mock_interview_llm.generate_question(session=session, chat_json=fake_chat)
    mock_interview_llm.generate_question(
        session=session,
        previous_questions=[{"seq": 1, "question_text": "第一题"}],
        chat_json=fake_chat,
    )

    assert "本题弱项复练重点：Redis 持久化与恢复" in prompts[0]
    assert "本题弱项复练重点：缓存场景取舍" in prompts[1]
