from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.run_mock_interview_eval import SAMPLE_CASES, build_dry_run_evaluator, build_real_evaluator


def test_sample_cases_have_required_fields():
    assert len(SAMPLE_CASES) >= 3
    for c in SAMPLE_CASES:
        assert {"id", "session", "question", "feedback", "expected"}.issubset(c.keys())
        assert {"factual_ok", "faithful_to_resume", "schema_valid"}.issubset(c["expected"].keys())


def test_dry_run_evaluator_returns_all_true():
    evaluator = build_dry_run_evaluator()
    for case in SAMPLE_CASES:
        result = evaluator(case)
        assert result == {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True}


def test_build_real_evaluator_uses_default_chat_json(monkeypatch):
    import sys as _sys
    import types

    calls: list[str] = []

    def fake_chat(prompt: str):
        calls.append(prompt)
        return '{"factual_ok": true, "faithful_to_resume": true, "schema_valid": true}'

    mock_module = types.ModuleType("services.mock_interview_llm")
    mock_module.default_chat_json = fake_chat
    monkeypatch.setitem(_sys.modules, "services.mock_interview_llm", mock_module)

    evaluator = build_real_evaluator()
    result = evaluator(SAMPLE_CASES[0])

    assert result == {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True}
    assert len(calls) == 1
    assert "事实正确性" in calls[0]
