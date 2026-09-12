from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.eval import llm_evaluator as ev


def _case():
    return {
        "id": "E-1",
        "session": {"role": "后端开发", "resume_snapshot": "做过 Redis 缓存优化"},
        "question": {"question_text": "请介绍一次你做过的缓存优化。", "answer_text": "我用 Redis 缓存热点查询。"},
        "feedback": {
            "overall_score": 8,
            "dimensions": [{"name": "事实正确性", "score": 8, "comment": "正确"}],
            "strengths": [], "improvements": [], "evidence": [], "reference_answer": "",
        },
    }


def test_llm_evaluator_parses_json_verdict(monkeypatch):
    prompts: list[str] = []

    def fake_chat(prompt):
        prompts.append(prompt)
        return '{"factual_ok": true, "faithful_to_resume": true, "schema_valid": true}'

    evaluator = ev.build_llm_evaluator(chat_json=fake_chat)

    result = evaluator(_case())

    assert result == {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True}
    assert "事实正确性" in prompts[0]
    assert "简历" in prompts[0]


def test_llm_evaluator_degrades_on_invalid_json(monkeypatch):
    evaluator = ev.build_llm_evaluator(chat_json=lambda prompt: "not json")
    result = evaluator(_case())
    assert result == {"factual_ok": False, "faithful_to_resume": False, "schema_valid": False}


def test_llm_evaluator_degrades_on_chat_error():
    def boom(prompt):
        raise RuntimeError("service down")

    evaluator = ev.build_llm_evaluator(chat_json=boom)
    result = evaluator(_case())
    assert result == {"factual_ok": False, "faithful_to_resume": False, "schema_valid": False}


def test_llm_evaluator_partial_verdict():
    evaluator = ev.build_llm_evaluator(
        chat_json=lambda prompt: '{"factual_ok": true}'
    )
    result = evaluator(_case())
    assert result == {"factual_ok": True, "faithful_to_resume": False, "schema_valid": False}
