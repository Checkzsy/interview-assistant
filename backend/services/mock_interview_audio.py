"""mock-interview 语音作答：WAV 解析与 ASR 转写辅助。

从 multipart 上传的 WAV 字节解码为 float32 单声道音频，再经
services.stt.factory.transcribe_with_fallback 转写为文本。失败时抛
AudioAnswerError，由路由映射为 400/422；不直接依赖真实 STT 引擎，
测试可注入 fake 转写函数。
"""
from __future__ import annotations

import io
import wave
from typing import Any, Callable, Optional

import numpy as np

from core.logger import get_logger

_log = get_logger("mock_interview_audio")

MAX_WAV_BYTES = 20 * 1024 * 1024


class AudioAnswerError(RuntimeError):
    """语音作答处理失败（超限 / 解析失败 / 转写失败 / 静音）。"""


def decode_wav_to_float32(data: bytes) -> tuple[np.ndarray, int]:
    """把 16-bit PCM WAV 字节解码为 (float32 单声道音频, sample_rate)。

    支持多声道（取平均），采样率保持一致；非 16-bit 或损坏文件抛 AudioAnswerError。
    """
    if not data:
        raise AudioAnswerError("上传的语音为空")
    if len(data) > MAX_WAV_BYTES:
        raise AudioAnswerError(f"语音文件超过 {MAX_WAV_BYTES} bytes 限制")
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            sr = wf.getframerate()
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())
    except (wave.Error, EOFError, OSError) as exc:
        raise AudioAnswerError("无法解析 WAV 音频文件") from exc
    if width != 2:
        raise AudioAnswerError("仅支持 16-bit PCM WAV")
    if sr <= 0 or channels <= 0:
        raise AudioAnswerError("WAV 音频参数无效")
    pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm.astype(np.float32), sr


def transcribe_answer(
    audio: np.ndarray,
    sample_rate: int,
    *,
    position: str = "",
    language: str = "",
    transcribe_fn: Optional[Callable[..., str]] = None,
) -> str:
    """转写回答音频为文本；转写函数抛错时记录并抛 AudioAnswerError。"""
    from services.stt.factory import transcribe_with_fallback as _default_fn

    fn = transcribe_fn or _default_fn
    try:
        text = fn(
            audio,
            sample_rate,
            position,
            language,
            scope="mock_interview",
            allow_remote=True,
        )
    except Exception as exc:
        _log.exception("mock interview audio transcribe failed")
        raise AudioAnswerError(f"语音转写失败：{exc}") from exc
    text = (text or "").strip()
    if not text:
        raise AudioAnswerError("未识别到有效语音内容，请重试")
    return text
