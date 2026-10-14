"""单模型瞬时失败重试（同模型，仅首个 chunk 产出之前）的行为测试。"""

import sys
from pathlib import Path
from types import SimpleNamespace as S

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import services.llm.streaming as streaming
from services.llm.streaming import LLMAuthError, LLMServerError, LLMTimeout


class _FakeTime:
    """虚拟时钟：sleep 不真实等待，只推进 now 并记录调用，避免测试变慢。"""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def fake_time(monkeypatch):
    clock = _FakeTime()
    monkeypatch.setattr(streaming, "time", clock)
    return clock


def _setup(monkeypatch):
    monkeypatch.setattr(streaming, "get_config", lambda: S(
        think_mode=False, think_effort="off", max_tokens=16, temperature=0.2
    ))
    monkeypatch.setattr(streaming, "_broadcast_tokens", lambda: None)


def _model():
    return S(name="GLM", model="glm-5.1", supports_think=False, supports_vision=False)


def _text_chunk(content):
    return S(choices=[S(delta=S(reasoning_content=None, reasoning=None, content=content))], usage=None)


def _run(monkeypatch, attempt_body, **kwargs):
    """安装 fake stream 后跑一次 chat_stream_single_model，返回 (chunks, 请求次数)。"""
    calls = {"n": 0}

    def fake_stream(_model_cfg, _messages, _cfg):
        calls["n"] += 1
        yield from attempt_body(calls["n"])

    monkeypatch.setattr(streaming, "_try_stream_with_model", fake_stream)
    chunks = list(streaming.chat_stream_single_model(_model(), [{"role": "user", "content": "题目"}], **kwargs))
    return chunks, calls["n"]


def test_transient_failure_then_success_is_transparent(monkeypatch, fake_time):
    _setup(monkeypatch)

    def attempt_body(attempt):
        if attempt < 3:
            raise LLMTimeout("provider timeout")
        yield _text_chunk("最终答案")

    chunks, calls = _run(monkeypatch, attempt_body)

    assert chunks == [("text", "最终答案")]
    assert calls == 3
    assert fake_time.sleeps, "重试之间必须退避等待"


def test_server_error_before_first_chunk_is_retried(monkeypatch, fake_time):
    _setup(monkeypatch)

    def attempt_body(attempt):
        if attempt == 1:
            raise LLMServerError("HTTP 503: upstream unavailable")
        yield _text_chunk("答案")

    chunks, calls = _run(monkeypatch, attempt_body)

    assert chunks == [("text", "答案")]
    assert calls == 2


def test_non_retryable_error_is_not_retried(monkeypatch, fake_time):
    _setup(monkeypatch)

    def attempt_body(_attempt):
        raise LLMAuthError("bad api key")
        yield  # pragma: no cover - 保持生成器协议

    with pytest.raises(LLMAuthError):
        _run(monkeypatch, attempt_body)

    assert fake_time.sleeps == [], "非可重试错误不应退避"


def test_retries_exhausted_raises_typed_error(monkeypatch, fake_time):
    _setup(monkeypatch)
    calls = {"n": 0}

    def fake_stream(_model_cfg, _messages, _cfg):
        calls["n"] += 1
        raise LLMTimeout("provider timeout")
        yield  # pragma: no cover - 保持生成器协议

    monkeypatch.setattr(streaming, "_try_stream_with_model", fake_stream)

    with pytest.raises(LLMTimeout):
        list(streaming.chat_stream_single_model(_model(), [{"role": "user", "content": "题目"}]))

    assert calls["n"] == 3, "必须用满 3 次尝试（首次 + 2 次重试）后才放弃"
    assert len(fake_time.sleeps) > 0, "两次重试之间必须退避"


def test_failure_after_first_chunk_is_not_retried(monkeypatch, fake_time):
    """回归防护：已产出正文后重试会导致答案重复，必须直接失败。"""
    _setup(monkeypatch)
    calls = {"n": 0}

    def fake_stream(_model_cfg, _messages, _cfg):
        calls["n"] += 1
        yield _text_chunk("已生成的部分")
        raise LLMTimeout("mid-stream timeout")

    monkeypatch.setattr(streaming, "_try_stream_with_model", fake_stream)

    emitted = []
    with pytest.raises(LLMTimeout):
        for chunk in streaming.chat_stream_single_model(_model(), [{"role": "user", "content": "题目"}]):
            emitted.append(chunk)

    assert calls["n"] == 1
    assert emitted == [("text", "已生成的部分")]
    assert fake_time.sleeps == []


def test_http_503_before_first_chunk_is_retried(monkeypatch, fake_time):
    """_try_stream_with_model 退回 HTTP 时，503 发生在首个 chunk 之前，同样要能重试。"""
    _setup(monkeypatch)

    def _raise_by_alias(**_kwargs):
        raise TypeError("got an unexpected keyword argument 'by_alias'")

    client = S(chat=S(completions=S(create=_raise_by_alias)))
    monkeypatch.setattr(streaming, "get_client_for_model", lambda _model: client)

    post_calls = {"n": 0}

    class _Resp503:
        status_code = 503
        text = "upstream unavailable"

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def json(self):
            raise ValueError("not json")

        def iter_lines(self, decode_unicode=False):
            return iter(())

    class _Resp200:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def iter_lines(self, decode_unicode=False):
            yield b'data: {"choices":[{"delta":{"content":"http-answer"}}]}'
            yield b"data: [DONE]"

    def fake_post(_url, headers=None, json=None, stream=False, timeout=None):
        post_calls["n"] += 1
        return _Resp503() if post_calls["n"] == 1 else _Resp200()

    monkeypatch.setattr(streaming.requests, "post", fake_post)

    model = S(
        name="GLM",
        model="glm-5.1",
        api_base_url="https://example.test/v1",
        api_key="k",
        supports_think=False,
        supports_vision=False,
    )
    chunks = list(streaming.chat_stream_single_model(model, [{"role": "user", "content": "题目"}]))

    assert chunks == [("text", "http-answer")]
    assert post_calls["n"] == 2


def test_abort_during_backoff_stops_silently(monkeypatch, fake_time):
    _setup(monkeypatch)
    calls = {"n": 0}

    def fake_stream(_model_cfg, _messages, _cfg):
        calls["n"] += 1
        raise LLMTimeout("provider timeout")
        yield  # pragma: no cover - 保持生成器协议

    monkeypatch.setattr(streaming, "_try_stream_with_model", fake_stream)

    # 重试循环顶部的第一次检查放过，退避期间命中取消 → 静默收尾，不再发起新请求。
    checks = {"n": 0}

    def abort_check():
        checks["n"] += 1
        return checks["n"] > 1

    chunks = list(
        streaming.chat_stream_single_model(
            _model(), [{"role": "user", "content": "题目"}], abort_check=abort_check
        )
    )

    assert chunks == []
    assert calls["n"] == 1
    assert fake_time.sleeps == []
