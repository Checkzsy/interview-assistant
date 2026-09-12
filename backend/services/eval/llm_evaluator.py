"""LLM evaluator for mock-interview quality verdicts.

Wraps an injectable ``chat_json`` callable (same shape as
mock_interview_llm) and returns the three-dimension verdict. Any
parse/connection failure degrades to all-False so one bad case never
aborts the whole eval run.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable

Verdict = dict[str, bool]
ChatJson = Callable[[str], Any]

_FALSE_VERDICT: Verdict = {
    "factual_ok": False,
    "faithful_to_resume": False,
    "schema_valid": False,
}


def _extract_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    text = str(raw or "")
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("not a dict")
    return parsed


def _prompt(case: dict[str, Any]) -> str:
    session = case.get("session") or {}
    question = case.get("question") or {}
    feedback = case.get("feedback") or {}
    return f"""你是严谨的模拟面试点评质量评审员。请从三个维度判断本轮“点评”是否合格，只返回 JSON。

岗位与简历快照：
{session.get('role') or '未提供'}
{session.get('resume_snapshot') or '未提供'}

面试题：
{question.get('question_text') or ''}

候选人回答：
{question.get('answer_text') or ''}

AI 点评：
{json.dumps(feedback, ensure_ascii=False)}

判断维度：
1. factual_ok：点评中的技术事实是否正确，不能有明显错误。
2. faithful_to_resume：点评涉及的经历必须与简历快照一致，不得编造简历中没有的经历。
3. schema_valid：点评含 overall_score、dimensions、strengths、improvements、evidence、reference_answer 等结构化字段，且 evidence 只引用回答原文。

JSON：{{"factual_ok": true/false, "faithful_to_resume": true/false, "schema_valid": true/false}}
"""


def build_llm_evaluator(chat_json: ChatJson) -> Callable[[dict[str, Any]], Verdict]:
    def evaluator(case: dict[str, Any]) -> Verdict:
        try:
            verdict = _extract_json(chat_json(_prompt(case)))
        except Exception:
            return dict(_FALSE_VERDICT)
        return {
            "factual_ok": bool(verdict.get("factual_ok", False)),
            "faithful_to_resume": bool(verdict.get("faithful_to_resume", False)),
            "schema_valid": bool(verdict.get("schema_valid", False)),
        }

    return evaluator
