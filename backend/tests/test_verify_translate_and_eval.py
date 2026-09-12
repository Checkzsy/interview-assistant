from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.verify_translate_and_eval import verify_eval, verify_translate


def test_verify_translate_returns_content(monkeypatch):
    calls = []

    def fake_create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="你好"))])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create)))
    model = SimpleNamespace(model="gpt-4o-mini")

    result = verify_translate(client, model, "Hello")

    assert result == "你好"
    assert calls[0]["messages"][0]["role"] == "system"
    assert "翻译引擎" in calls[0]["messages"][0]["content"]
    assert calls[0]["messages"][1]["content"].startswith("目标语言：zh")
    assert "Hello" in calls[0]["messages"][1]["content"]


def test_verify_eval_returns_pass_rate(monkeypatch):
    import scripts.verify_translate_and_eval as mod

    def fake_build(chat_json):
        return lambda case: {"factual_ok": True, "faithful_to_resume": True, "schema_valid": True}

    monkeypatch.setattr(mod, "build_llm_evaluator", fake_build)

    client = SimpleNamespace()
    model = SimpleNamespace(model="gpt-4o-mini")

    report = verify_eval(client, model)

    assert "pass_rate" in report
    assert report["total"] >= 1