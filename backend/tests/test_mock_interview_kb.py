from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import mock_interview_llm


def _session(**overrides) -> dict:
    session = {
        "language": "中文",
        "company": "ACME",
        "role": "后端开发",
        "jd_snapshot": "负责高并发服务，熟悉 Redis 和 FastAPI。",
        "resume_snapshot": "做过订单查询接口优化。",
    }
    session.update(overrides)
    return session


def test_question_prompt_without_kb_unchanged():
    prompt = mock_interview_llm._question_prompt(_session(), [])
    assert "参考资料" not in prompt
    assert "负责高并发服务，熟悉 Redis 和 FastAPI。" in prompt
    assert "做过订单查询接口优化。" in prompt


def test_question_prompt_includes_kb_context():
    prompt = mock_interview_llm._question_prompt(
        _session(),
        [],
        kb_context=[{"path": "notes.md", "text": "Redis 缓存优化经验", "score": 0.9}],
    )
    assert "参考资料" in prompt
    assert "Redis 缓存优化经验" in prompt
    assert "notes.md" in prompt
    assert prompt.find("参考资料") > prompt.find("简历快照")
    assert prompt.find("参考资料") < prompt.find("弱项复练重点")


def test_question_prompt_truncates_long_context():
    long_text = "Redis 缓存优化经验" * 30
    prompt = mock_interview_llm._question_prompt(
        _session(),
        [],
        kb_context=[{"path": "notes.md", "text": long_text}],
    )
    assert long_text not in prompt
    line = next(line for line in prompt.splitlines() if line.startswith("- [notes.md]"))
    assert line == "- [notes.md] " + long_text[:200]


def test_kb_context_more_than_five_truncates():
    items = [
        {"path": f"notes-{index}.md", "text": "片段-" + str(index), "score": 1.0}
        for index in range(1, 7)
    ]
    prompt = mock_interview_llm._question_prompt(_session(), [], kb_context=items)
    assert "片段-6" not in prompt
    assert prompt.count("参考资料") == 1
    assert prompt.count("- [notes-") == 5
    assert prompt.count("notes-1.md") == 1
    assert prompt.count("notes-5.md") == 1


def test_generate_question_passes_kb_context_to_prompt():
    prompts: list[str] = []

    def fake_chat(prompt: str):
        prompts.append(prompt)
        return {
            "question_text": "请基于知识库内容说明 Redis 缓存优化要点。",
            "question_type": "technical",
            "skill_tags": ["Redis"],
        }

    mock_interview_llm.generate_question(
        session=_session(),
        kb_context=[{"path": "notes.md", "text": "Redis 缓存优化经验", "score": 0.9}],
        chat_json=fake_chat,
    )
    assert "参考资料" in prompts[0]
    assert "notes.md" in prompts[0]
    assert "Redis 缓存优化经验" in prompts[0]
