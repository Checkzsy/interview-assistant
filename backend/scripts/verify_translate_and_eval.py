"""端到端实时翻译集成与验证器。

独立验证脚本：在本地验证翻译 worker 与 LLM evaluator 都能接入真实
DeepSeek/OpenAI 兼容模型，而不用等 translate_worker / mock_interview kb
注入完成。默认不调用真实模型，只有显式 --run 才调用。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.config import get_config
from services.eval.llm_evaluator import build_llm_evaluator
from services.eval.mock_interview_eval import run_eval
from services.llm.streaming import get_client_for_model
from scripts.run_mock_interview_eval import SAMPLE_CASES

DEFAULT_TEXT = "Hello, I have three years of backend development experience with Python and Redis."

_PLACEHOLDER_KEYS = {"", "sk-your-api-key-here", "YOUR_API_KEY_HERE"}


def _api_key_ok(api_key: str) -> bool:
    return bool(api_key) and api_key.strip() not in _PLACEHOLDER_KEYS


def _resolve_model(cfg, model_arg: str | None):
    if not model_arg:
        return cfg.get_review_model()
    for m in cfg.models:
        if m.name == model_arg or m.model == model_arg:
            return m
    raise ValueError(f"未找到模型：{model_arg}")


def verify_translate(client, model, text: str) -> str:
    """调用兼容 OpenAI 的 chat.completions 做一次翻译验证。"""
    response = client.chat.completions.create(
        model=model.model,
        messages=[
            {"role": "system", "content": "你是翻译引擎，只输出译文，不要解释。"},
            {"role": "user", "content": f"目标语言：zh\n\n待翻译文本：\n{text}"},
        ],
        temperature=0.2,
        max_tokens=1600,
    )
    return response.choices[0].message.content.strip()


def verify_eval(client, model) -> dict[str, Any]:
    """用传入 client 构造 chat_json 包装，跑 SAMPLE_CASES 并返回聚合报告。"""
    def chat_json(prompt: str) -> Any:
        response = client.chat.completions.create(
            model=model.model,
            messages=[
                {"role": "system", "content": "你是严谨的面试官，只返回合法 JSON。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=1600,
        )
        return response.choices[0].message.content

    evaluator = build_llm_evaluator(chat_json=chat_json)
    return run_eval(SAMPLE_CASES, evaluator)


def _force_utf8_stdio() -> None:
    """Force UTF-8 stdout/stderr so Chinese diagnostics survive GBK consoles."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def main() -> int:
    _force_utf8_stdio()
    parser = argparse.ArgumentParser(description="端到端实时翻译集成与验证器")
    parser.add_argument("--model", default=None, help="模型名称或配置名；默认使用 review model")
    parser.add_argument("--text", default=DEFAULT_TEXT, help="待翻译文本")
    parser.add_argument("--run", action="store_true", help="真正调用模型（默认不调用）")
    parser.add_argument("--translate", action="store_true", help="只验证翻译")
    parser.add_argument("--eval", action="store_true", help="只验证 evaluator")
    args = parser.parse_args()

    cfg = get_config()
    try:
        model = _resolve_model(cfg, args.model)
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if not _api_key_ok(model.api_key):
        print(
            "错误：未配置有效的 API Key。请在 backend/config.json 中为 review model 填写 api_key。",
            file=sys.stderr,
        )
        return 2

    if not args.run:
        print("未指定 --run，跳过真实模型调用。使用 --run 调用真实模型。")
        return 0

    client = get_client_for_model(model)
    run_translate = args.translate or not args.eval
    run_eval_flag = args.eval or not args.translate

    try:
        if run_translate:
            translated = verify_translate(client, model, args.text)
            print(json.dumps(
                {"type": "translate", "text": args.text, "translated": translated},
                ensure_ascii=False,
                indent=2,
            ))
        if run_eval_flag:
            report = verify_eval(client, model)
            print(json.dumps(report, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(f"错误：调用模型失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())