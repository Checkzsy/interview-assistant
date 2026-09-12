"""实时翻译后台 worker。

段落级翻译：asr_state 广播 transcription 后，把 (seq, text) 投递到本模块的有界队列，
由单条后台线程非流式调用本地 OpenAI-compatible LLM 翻译，完成后广播译文。
翻译失败只广播错误占位，不重试、不阻塞转录与答题主流程。

线程循环用 timeout=0.5 的 get() 轮询，配合 stop event 可在 2 秒内退出。
模块导入时不执行任何网络调用或 get_config()，全部延迟到 worker 线程运行时。
"""
from __future__ import annotations

import queue
import threading
from typing import Callable, Optional

from core.logger import get_logger

_log = get_logger("translate_worker")

_QUEUE_MAXSIZE = 32

_translate_queue: Optional[queue.Queue] = None
_translate_thread: Optional[threading.Thread] = None
_translate_stop = threading.Event()
_broadcast: Callable[[dict], None] = lambda _data: None


def init_translate_worker(broadcast_fn: Callable[[dict], None]) -> None:
    """启动翻译后台线程。broadcast_fn 用于广播译文/错误消息。"""
    global _translate_queue, _translate_thread, _broadcast
    if _translate_thread and _translate_thread.is_alive():
        return
    _broadcast = broadcast_fn
    _translate_queue = queue.Queue(maxsize=_QUEUE_MAXSIZE)
    _translate_stop.clear()
    _translate_thread = threading.Thread(
        target=_translate_loop, name="translate-worker", daemon=True
    )
    _translate_thread.start()


def submit_translation(seq: int, text: str, target_lang: str) -> bool:
    """把一条待翻译转录投递到队列。未初始化时返回 False。

    seq<=0 或空文本返回 False；队列满时返回 False（不阻塞、不丢日志）。
    """
    q = _translate_queue
    if q is None:
        return False
    if seq <= 0 or not (text or "").strip():
        return False
    try:
        q.put_nowait((seq, text, target_lang or "zh"))
        return True
    except queue.Full:
        return False


def stop_translate_worker() -> None:
    """停止后端翻译线程：置位 stop event，join(timeout=2)，队列置 None。"""
    global _translate_thread, _translate_queue
    _translate_stop.set()
    thread = _translate_thread
    _translate_thread = None
    _translate_queue = None
    if thread:
        thread.join(timeout=2.0)


def _translate_loop() -> None:
    while not _translate_stop.is_set():
        q = _translate_queue
        if q is None:
            return
        try:
            seq, text, target_lang = q.get(timeout=0.5)
        except queue.Empty:
            continue
        _process_translation(seq, text, target_lang, _broadcast)


def _process_translation(
    seq: int,
    text: str,
    target_lang: str,
    broadcast_fn: Callable[[dict], None],
) -> None:
    """同步翻译一条转录并广播结果。抽出独立函数便于单测。"""
    try:
        translated = _translate_text(text, target_lang)
    except Exception:
        _log.exception("translation failed seq=%s", seq)
        broadcast_fn({"type": "transcription_translate_error", "seq": seq})
        return
    if translated:
        broadcast_fn({"type": "transcription_translated", "seq": seq, "text": translated})
    else:
        broadcast_fn({"type": "transcription_translate_error", "seq": seq})


def _translate_text(text: str, target_lang: str) -> str:
    """调用配置的 review model 做非流式翻译。

    实现是模块级函数，测试可通过 monkeypatch 替换。延迟到调用时才 import
    core.config / services.llm.streaming，模块导入阶段不触发任何网络调用。
    """
    from core.config import get_config
    from services.llm.streaming import get_client_for_model

    cfg = get_config()
    model = cfg.get_review_model()
    if not model.api_key or model.api_key in ("", "sk-your-api-key-here"):
        raise RuntimeError("翻译模型未配置有效 API Key。")

    client = get_client_for_model(model)
    response = client.chat.completions.create(
        model=model.model,
        messages=[
            {
                "role": "system",
                "content": "你是翻译引擎。把用户输入翻译成目标语言，自动识别源语言，只输出译文，不要解释、不要原文、不要任何额外说明。",
            },
            {
                "role": "user",
                "content": f"目标语言：{target_lang}\n\n待翻译文本：\n{text}",
            },
        ],
        temperature=0.3,
        max_tokens=2048,
    )
    content = ""
    if getattr(response, "choices", None):
        content = response.choices[0].message.content or ""
    return (content or "").strip()
