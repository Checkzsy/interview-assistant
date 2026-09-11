from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.eval import mock_interview_eval as ev


def _case(**overrides):
    base = {
        "id": "E-1",
        "session": {"role": "后端开发", "resume_snapshot": "做过 Redis 缓存优化"},
        "question": {"question_text": "请介绍一次你做过的缓存优化。", "answer_text": "我用 Redis 缓存热点查询，P95 从 800ms 降到 120ms。"},
        "feedback": {
            "overall_score": 8,
            "dimensions": [{"name": "事实正确性", "score": 8, "comment": "技术描述基本正确"}],
            "strengths": ["量化了收益"],
            "improvements": ["补充背景"],
            "evidence": ["P95 从 800ms 降到 120ms"],
            "reference_answer": "建议按背景-做法-结果-取舍回答。",
        },
        "expected": {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True},
    }
    base.update(overrides)
    return base


def test_run_eval_aggregates_pass_rates():
    evaluator = lambda case: {
        "factual_ok": case["expected"]["factual_ok"],
        "faithful_to_resume": case["expected"]["faithful_to_resume"],
        "schema_valid": case["expected"]["schema_valid"],
    }
    cases = [
        _case(),
        _case(id="E-2", expected={"factual_ok": False, "faithful_to_resume": True, "schema_valid": True}),
        _case(id="E-3", expected={"factual_ok": True, "faithful_to_resume": False, "schema_valid": True}),
    ]

    report = ev.run_eval(cases, evaluator)

    assert report["total"] == 3
    assert report["passed"] == 1
    assert report["pass_rate"] == pytest.approx(1 / 3)
    assert report["dimensions"]["factual_ok"]["pass_rate"] == pytest.approx(2 / 3)
    assert report["dimensions"]["faithful_to_resume"]["pass_rate"] == pytest.approx(2 / 3)
    assert report["dimensions"]["schema_valid"]["pass_rate"] == 1.0
    assert [f["id"] for f in report["failures"]] == ["E-2", "E-3"]


def test_run_eval_handles_empty_cases():
    report = ev.run_eval([], lambda case: {})
    assert report["total"] == 0
    assert report["pass_rate"] == 0.0


def test_run_eval_degrades_when_evaluator_raises():
    def evaluator(case):
        raise RuntimeError("evaluator down")

    report = ev.run_eval([_case()], evaluator)

    assert report["total"] == 1
    assert report["passed"] == 0
    assert report["errors"] == 1
    assert report["failures"][0]["id"] == "E-1"
