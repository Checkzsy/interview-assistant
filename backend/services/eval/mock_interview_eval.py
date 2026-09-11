"""模拟面试点评质量评测 harness。

纯本地、无 LLM 调用：评测逻辑只依赖注入的 ``evaluator_fn``。
生产环境可用 DeepSeek/OpenAI 兼容 evaluator 包装实际点评，
测试用 fake evaluator 验证聚合与降级行为。
"""
from __future__ import annotations

from typing import Any, Callable

DIMENSIONS = ("factual_ok", "faithful_to_resume", "schema_valid")


def run_eval(
    cases: list[dict[str, Any]],
    evaluator_fn: Callable[[dict[str, Any]], dict[str, bool]],
) -> dict[str, Any]:
    """逐条评测并聚合通过率。evaluator 抛错记入 errors，不中断整轮。"""
    total = len(cases)
    passed = 0
    errors = 0
    failures: list[dict[str, Any]] = []
    dim_scores: dict[str, int] = {d: 0 for d in DIMENSIONS}

    for case in cases:
        case_id = str(case.get("id") or "?")
        try:
            result = evaluator_fn(case)
        except Exception:
            errors += 1
            failures.append({"id": case_id, "reason": "evaluator_error"})
            continue

        ok_flags = [bool(result.get(d, False)) for d in DIMENSIONS]
        if all(ok_flags):
            passed += 1
        else:
            failures.append({"id": case_id, "reason": "dimensions", "result": result})
        for dim, ok in zip(DIMENSIONS, ok_flags):
            if ok:
                dim_scores[dim] += 1

    def pass_rate(n: int) -> float:
        return (n / total) if total else 0.0

    return {
        "total": total,
        "passed": passed,
        "errors": errors,
        "pass_rate": pass_rate(passed),
        "dimensions": {
            dim: {"passed": dim_scores[dim], "pass_rate": pass_rate(dim_scores[dim])}
            for dim in DIMENSIONS
        },
        "failures": failures,
    }
