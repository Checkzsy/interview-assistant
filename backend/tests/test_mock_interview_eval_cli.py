from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.run_mock_interview_eval import SAMPLE_CASES, build_dry_run_evaluator


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
