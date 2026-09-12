"""模拟面试点评质量评测 CLI 样例集与 dry-run evaluator。

真实 evaluator 可替换为 DeepSeek/OpenAI 兼容模型，对每条 case
生成事实正确性、简历忠实度、schema 校验三维判断；dry-run 用于
先验证 harness 与报告流程，不调用真实模型。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.eval.llm_evaluator import build_llm_evaluator
from services.eval.mock_interview_eval import run_eval

SAMPLE_CASES: list[dict[str, Any]] = [
    {
        "id": "E-1",
        "session": {"role": "后端开发", "resume_snapshot": "做过 Redis 缓存优化，P95 从 800ms 降到 120ms。"},
        "question": {
            "question_text": "请介绍一次你做过的缓存优化。",
            "answer_text": "我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。",
        },
        "feedback": {
            "overall_score": 8,
            "dimensions": [{"name": "事实正确性", "score": 8, "comment": "技术描述基本正确"}],
            "strengths": ["量化了性能收益"],
            "improvements": ["补充背景与取舍"],
            "evidence": ["P95 从 800ms 降到 120ms"],
            "reference_answer": "建议按背景-做法-结果-取舍结构回答。",
        },
        "expected": {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True},
    },
    {
        "id": "E-2",
        "session": {"role": "后端开发", "resume_snapshot": "做过订单查询接口优化。"},
        "question": {
            "question_text": "Redis 持久化有哪些方式？",
            "answer_text": "RDB 和 AOF。RDB 是快照，AOF 追加日志。",
        },
        "feedback": {
            "overall_score": 7,
            "dimensions": [{"name": "事实正确性", "score": 7, "comment": "答到两类方式"}],
            "strengths": ["覆盖基础概念"],
            "improvements": ["补充混合持久化和取舍"],
            "evidence": [],
            "reference_answer": "RDB、AOF 与混合持久化。",
        },
        "expected": {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True},
    },
    {
        "id": "E-3",
        "session": {"role": "后端开发", "resume_snapshot": "做过 Kafka 消息链路重构。"},
        "question": {
            "question_text": "Kafka 如何保证消息不丢失？",
            "answer_text": "生产端 acks=all，消费端手动提交 offset，Broker 端副本因子 >=2。",
        },
        "feedback": {
            "overall_score": 9,
            "dimensions": [{"name": "事实正确性", "score": 9, "comment": "三端都覆盖"}],
            "strengths": ["端到端覆盖"],
            "improvements": ["补充幂等与限流"],
            "evidence": ["acks=all", "手动提交 offset"],
            "reference_answer": "生产端 acks=all + 幂等，消费端手动提交，Broker 副本因子 >=2。",
        },
        "expected": {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True},
    },
]


def build_dry_run_evaluator() -> Callable[[dict[str, Any]], dict[str, bool]]:
    """Always-true evaluator; only for harness validation. Real evaluator goes in a separate module."""
    def evaluator(_case: dict[str, Any]) -> dict[str, bool]:
        return {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True}
    return evaluator


def build_real_evaluator() -> Callable[[dict[str, Any]], dict[str, bool]]:
    """Evaluator backed by the configured review model (DeepSeek/OpenAI-compatible)."""
    from services.mock_interview_llm import default_chat_json

    return build_llm_evaluator(chat_json=default_chat_json)


def main() -> None:
    parser = argparse.ArgumentParser(description="模拟面试点评质量评测")
    parser.add_argument("--dry-run", action="store_true", help="使用 dry-run evaluator，不调用真实模型")
    parser.add_argument("--out", default=None, help="输出报告 JSON 路径；不传则打印到 stdout")
    args = parser.parse_args()

    evaluator = build_dry_run_evaluator() if args.dry_run else build_real_evaluator()
    report = run_eval(SAMPLE_CASES, evaluator)
    output = json.dumps(report, ensure_ascii=False, indent=2)

    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
        print(f"[OK] report written to {args.out}")
    else:
        print(output)


if __name__ == "__main__":
    main()
