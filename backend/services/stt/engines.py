"""STT engine implementations: Whisper (local), Doubao, and generic HTTP ASR."""

import io
import gzip
import json
import logging
import os
import shutil
import struct
import sys
import time
import uuid
import wave
from pathlib import Path
import numpy as np
import threading
from typing import Optional, Any

import requests

from core.logger import get_logger
from .text_utils import TECH_VOCAB, _postprocess, _build_initial_prompt

_log = get_logger("stt.engines")

try:
    import websocket
except ImportError:
    websocket = None


# ---------------------------------------------------------------------------
# Shared audio helpers
# ---------------------------------------------------------------------------

def _audio_to_pcm_int16(audio: np.ndarray) -> np.ndarray:
    if audio.dtype == np.float32 or audio.dtype == np.float64:
        if audio.max() <= 1.0 and audio.min() >= -1.0:
            return (audio * 32767).astype(np.int16)
        return np.clip(audio, -32768, 32767).astype(np.int16)
    if audio.dtype != np.int16:
        return audio.astype(np.int16)
    return audio


def _audio_to_wav_bytes(audio: np.ndarray, sample_rate: int = 16000) -> bytes:
    pcm = _audio_to_pcm_int16(audio)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate or 16000))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------------------
# DoubaoSTT – Volcengine streaming ASR
# ---------------------------------------------------------------------------

DOUBAO_ASR_WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
MSG_FULL_CLIENT_REQUEST = 0x01
MSG_AUDIO_ONLY = 0x02
MSG_FULL_SERVER_RESPONSE = 0x09
MSG_ERROR = 0x0F
FLAG_LAST_AUDIO = 0x02
COMPRESSION_GZIP = 0x01
CHUNK_MS = 200
CHUNK_SAMPLES = 16000 * CHUNK_MS // 1000


def _build_ws_frame_full_request(
    app_key: str,
    boosting_table_id: str,
    language: str = "zh-CN",
) -> bytes:
    req: dict[str, Any] = {
        "user": {"uid": app_key},
        "audio": {
            "format": "pcm",
            "rate": 16000,
            "bits": 16,
            "channel": 1,
            "language": language if language and language != "auto" else "zh-CN",
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
        },
    }
    if boosting_table_id and boosting_table_id.strip():
        req["request"]["corpus"] = {"boosting_table_id": boosting_table_id.strip()}
    payload_raw = json.dumps(req, ensure_ascii=False).encode("utf-8")
    payload = gzip.compress(payload_raw)
    header = bytes([0x11, 0x10, 0x11, 0x00])
    return header + struct.pack(">I", len(payload)) + payload


def _build_ws_frame_audio(pcm_chunk: bytes, is_last: bool = False) -> bytes:
    payload = gzip.compress(pcm_chunk)
    header = bytes([0x11, 0x22 if is_last else 0x20, 0x01, 0x00])
    return header + struct.pack(">I", len(payload)) + payload


def _parse_ws_response(data: bytes) -> tuple[int, Optional[dict]]:
    if len(data) < 4:
        return 0, None
    msg_type = (data[1] >> 4) & 0x0F
    compression = data[2] & 0x0F
    if msg_type == MSG_ERROR:
        return MSG_ERROR, None
    if msg_type == MSG_FULL_SERVER_RESPONSE:
        if len(data) < 12:
            return msg_type, None
        payload_size = struct.unpack(">I", data[8:12])[0]
        if len(data) < 12 + payload_size:
            return msg_type, None
        raw = data[12 : 12 + payload_size]
        if compression == COMPRESSION_GZIP:
            try:
                raw = gzip.decompress(raw)
            except Exception:
                _log.warning("_parse_ws_response gzip decompress failed")
                return msg_type, None
        try:
            payload = json.loads(raw.decode("utf-8"))
            return msg_type, payload
        except Exception:
            _log.warning("_parse_ws_response invalid JSON at offset %d", len(raw))
            return msg_type, None
    return msg_type, None


class DoubaoSTT:
    """豆包流式语音识别模型，WebSocket 双流式。

    支持两种鉴权方式（自动选择）：
    - 新版控制台：X-Api-Key（api_key 非空时优先使用）
    - 旧版控制台：X-Api-App-Key + X-Api-Access-Key
    """

    def __init__(
        self,
        app_id: str = "",
        access_token: str = "",
        api_key: str = "",
        resource_id: str = "volc.bigasr.sauc.duration",
        boosting_table_id: str = "",
        ws_url: str = "",
    ):
        self.app_id = app_id or ""
        self.access_token = access_token or ""
        self.api_key = api_key or ""
        self.resource_id = resource_id or "volc.bigasr.sauc.duration"
        self.boosting_table_id = boosting_table_id or ""
        self.ws_url = (ws_url or DOUBAO_ASR_WS_URL).rstrip("/")

    @property
    def model_size(self) -> str:
        return "doubao"

    @property
    def is_loaded(self) -> bool:
        return bool(self.api_key or self.access_token)

    @property
    def is_loading(self) -> bool:
        return False

    def load_model(self) -> None:
        pass

    def change_model(self, _model_size: str) -> None:
        pass

    def _build_headers(self) -> dict:
        # 双向流式接口（bigmodel_async）要求 X-Api-Request-Id + X-Api-Sequence(-1)，
        # 旧版控制台鉴权仍用 X-Api-App-Key + X-Api-Access-Key。
        if self.api_key:
            return {
                "X-Api-Key": self.api_key,
                "X-Api-Resource-Id": self.resource_id,
                "X-Api-Request-Id": uuid.uuid4().hex,
                "X-Api-Sequence": "-1",
            }
        app_key = self.app_id or self.access_token
        return {
            "X-Api-App-Key": app_key,
            "X-Api-Access-Key": self.access_token,
            "X-Api-Resource-Id": self.resource_id,
            "X-Api-Request-Id": uuid.uuid4().hex,
            "X-Api-Sequence": "-1",
        }

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000,
                   position: str = "后端开发", language: str = "Python") -> str:
        if not self.api_key and not self.access_token:
            return ""
        if websocket is None:
            return ""
        app_key = self.app_id or self.access_token or self.api_key
        pcm = _audio_to_pcm_int16(audio)
        if sample_rate != 16000:
            n_orig = len(pcm)
            n_new = int(round(n_orig * 16000 / sample_rate))
            if n_new < 1:
                n_new = 1
            indices = np.linspace(0, n_orig - 1, n_new).astype(np.int32)
            pcm = pcm[indices]

        first_frame = _build_ws_frame_full_request(
            app_key, self.boosting_table_id, language="zh-CN"
        )
        n_samples = len(pcm)
        chunks = []
        offset = 0
        while offset < n_samples:
            take = min(CHUNK_SAMPLES, n_samples - offset)
            chunk_bytes = pcm[offset : offset + take].tobytes()
            is_last = offset + take >= n_samples
            chunks.append(_build_ws_frame_audio(chunk_bytes, is_last=is_last))
            offset += take
        if not chunks:
            pad = np.zeros(CHUNK_SAMPLES, dtype=np.int16)
            chunks = [_build_ws_frame_audio(pad.tobytes(), is_last=True)]

        try:
            ws = websocket.create_connection(
                DOUBAO_ASR_WS_URL,
                header=[f"{k}: {v}" for k, v in self._build_headers().items()],
                timeout=10,
            )
            try:
                ws.send_binary(first_frame)
                time.sleep(0.05)
                for i, frame in enumerate(chunks):
                    ws.send_binary(frame)
                    if i % 10 == 9:
                        time.sleep(0.02)
                final_text = ""
                ws.settimeout(5)
                first_packet = True
                while True:
                    try:
                        raw = ws.recv()
                    except Exception:
                        break
                    if first_packet:
                        ws.settimeout(15)
                        first_packet = False
                    if raw is None:
                        break
                    if isinstance(raw, str):
                        raw = raw.encode("utf-8")
                    msg_type, payload = _parse_ws_response(raw)
                    if msg_type == MSG_ERROR:
                        code = struct.unpack(">I", raw[4:8])[0] if len(raw) >= 8 else 0
                        err_size = struct.unpack(">I", raw[8:12])[0] if len(raw) >= 12 else 0
                        err_msg = raw[12:12 + err_size].decode("utf-8", errors="replace") if err_size else ""
                        raise RuntimeError(f"豆包 ASR 错误: {code} {err_msg}")
                    if msg_type == MSG_FULL_SERVER_RESPONSE and payload:
                        res = payload.get("result") or {}
                        text = (res.get("text") or "").strip()
                        if text:
                            final_text = text
                return _postprocess(final_text) if final_text else ""
            finally:
                ws.close()
        except Exception as e:
            _log.warning("Doubao ASR error: %s", e, exc_info=True)
            if "websocket" in str(type(e).__name__).lower():
                raise RuntimeError(f"豆包 ASR 连接异常: {e}") from e
            raise

    def create_streaming_session(
        self,
        on_partial: Optional[Any] = None,
        on_final: Optional[Any] = None,
    ) -> Optional["DoubaoStreamingSession"]:
        """创建双向流式会话（边说边发，实时返回部分结果）。

        仅 wss 协议支持；返回 None 表示当前引擎不可流式（HTTP 等）。
        """
        if not self.api_key and not self.access_token:
            return None
        if websocket is None:
            return None
        app_key = self.app_id or self.access_token or self.api_key
        first_frame = _build_ws_frame_full_request(
            app_key, self.boosting_table_id, language="zh-CN"
        )
        return DoubaoStreamingSession(
            ws_url=self.ws_url,
            headers=self._build_headers(),
            first_frame=first_frame,
            on_partial=on_partial,
            on_final=on_final,
        )


class DoubaoStreamingSession:
    """豆包双向流式会话：主线程边采边发，后台线程收部分/最终结果。

    - ``feed(audio)``：主循环调用，喂 float32/int16 音频，内部累积到 200ms 块再发。
    - ``finish()``：发结束帧，阻塞等待最终结果（definite:true）并返回文本。
    - ``on_partial(text)`` / ``on_final(text)``：收到结果时的回调。
    """

    def __init__(
        self,
        ws_url: str,
        headers: dict,
        first_frame: bytes,
        on_partial: Optional[Any] = None,
        on_final: Optional[Any] = None,
    ):
        self._on_partial = on_partial
        self._on_final = on_final
        self._final_text = ""
        self._done = threading.Event()
        self._opened = threading.Event()
        self._buf = bytearray()
        self._chunk_bytes = CHUNK_SAMPLES * 2  # int16 每样本 2 字节

        self._ws = websocket.WebSocketApp(
            ws_url,
            header=[f"{k}: {v}" for k, v in headers.items()],
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )
        self._recv_thread = threading.Thread(
            target=self._ws.run_forever, daemon=True
        )
        self._recv_thread.start()
        if not self._opened.wait(timeout=10):
            try:
                self._ws.close()
            except Exception:
                pass
            raise RuntimeError("豆包流式连接建立超时")
        self._send(first_frame)

    # ------------------------------------------------------------------
    # WebSocket 回调（recv 线程内执行）
    # ------------------------------------------------------------------

    def _on_open(self, _ws) -> None:
        _log.info("doubao streaming on_open")
        self._opened.set()

    def _on_message(self, _ws, message) -> None:
        try:
            raw = message if isinstance(message, bytes) else message.encode("utf-8")
            msg_type, payload = _parse_ws_response(raw)
        except Exception:
            return
        if msg_type == MSG_ERROR:
            _log.warning("doubao streaming on_message MSG_ERROR")
            self._done.set()
            return
        if msg_type != MSG_FULL_SERVER_RESPONSE or not payload:
            _log.info("doubao streaming on_message skip msg_type=%s payload=%s", msg_type, payload is not None)
            return
        result = payload.get("result") or {}
        text = (result.get("text") or "").strip()
        if not text:
            return
        utterances = result.get("utterances") or []
        is_final = any(
            isinstance(u, dict) and u.get("definite") for u in utterances
        )
        _log.info(
            "doubao streaming result text=%r definite=%s is_last=%s",
            text[:60],
            [u.get("definite") for u in utterances if isinstance(u, dict)],
            payload.get("is_last_package"),
        )
        if is_final:
            self._final_text = text
            self._done.set()
            if self._on_final:
                try:
                    self._on_final(text)
                except Exception as e:
                    _log.warning("doubao streaming on_final failed: %s", e)
        elif self._on_partial:
            try:
                self._on_partial(text)
            except Exception as e:
                _log.warning("doubao streaming on_partial failed: %s", e)

    def _on_error(self, _ws, error) -> None:
        _log.warning("doubao streaming on_error: %r", error)
        self._done.set()

    def _on_close(self, _ws, *_args) -> None:
        _log.warning("doubao streaming on_close: code=%s reason=%s", _args[0] if _args else None, _args[1] if len(_args) > 1 else None)
        self._done.set()

    # ------------------------------------------------------------------
    # 主循环调用（音频采集线程）
    # ------------------------------------------------------------------

    def _send(self, frame: bytes) -> None:
        self._ws.send(frame, opcode=websocket.ABNF.OPCODE_BINARY)

    def feed(self, audio: np.ndarray) -> None:
        """喂一段音频，累积到 200ms 块再发送。"""
        if self._done.is_set():
            return
        pcm = _audio_to_pcm_int16(audio)
        self._buf.extend(pcm.tobytes())
        while len(self._buf) >= self._chunk_bytes:
            chunk = bytes(self._buf[: self._chunk_bytes])
            del self._buf[: self._chunk_bytes]
            try:
                self._send(_build_ws_frame_audio(chunk, is_last=False))
            except Exception as e:
                _log.warning("doubao streaming feed failed: %s", e)
                self._done.set()
                return

    def finish(self, timeout: float = 8.0) -> str:
        """发结束帧并阻塞等待最终结果，返回最终文本（可能为空串）。"""
        if not self._done.is_set():
            try:
                if self._buf:
                    self._send(_build_ws_frame_audio(bytes(self._buf), is_last=False))
                    self._buf = bytearray()
                self._send(_build_ws_frame_audio(b"", is_last=True))
            except Exception as e:
                _log.warning("doubao streaming finish send failed: %s", e)
        self._done.wait(timeout=timeout)
        try:
            self._ws.close()
        except Exception:
            pass
        return _postprocess(self._final_text) if self._final_text else ""


# ---------------------------------------------------------------------------
# GenericHTTPSTT – OpenAI-compatible multipart ASR
# ---------------------------------------------------------------------------

class GenericHTTPSTT:
    """通用 HTTP ASR: POST {base_url}/audio/transcriptions with multipart file."""

    def __init__(self, api_base_url: str, api_key: str, model: str,
                 custom_headers: str = ""):
        self.api_base_url = (api_base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model or ""
        self.custom_headers = custom_headers or ""

    @property
    def model_size(self) -> str:
        return "generic"

    @property
    def is_loaded(self) -> bool:
        return bool(self.api_base_url and self.api_key and self.model)

    @property
    def is_loading(self) -> bool:
        return False

    def load_model(self) -> None:
        pass

    def change_model(self, _model_size: str) -> None:
        pass

    def _extract_text(self, data: Any) -> str:
        if isinstance(data, str):
            return data.strip()
        if not isinstance(data, dict):
            return ""
        for key in ("text", "transcript", "result", "content"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        result = data.get("result")
        if isinstance(result, dict):
            for key in ("text", "transcript", "content"):
                value = result.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return ""

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000,
                   position: str = "后端开发", language: str = "Python") -> str:
        if not self.api_base_url:
            raise RuntimeError("通用 ASR Base URL 未配置")
        if not self.api_key:
            raise RuntimeError("通用 ASR API Key 未配置")
        if not self.model:
            raise RuntimeError("通用 ASR Model 未配置")

        url = f"{self.api_base_url}/audio/transcriptions"
        wav_bytes = _audio_to_wav_bytes(audio, sample_rate=sample_rate)
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if self.custom_headers.strip():
            try:
                extra = json.loads(self.custom_headers)
                if isinstance(extra, dict):
                    headers.update({k: str(v) for k, v in extra.items()})
            except (json.JSONDecodeError, ValueError):
                for line in self.custom_headers.strip().splitlines():
                    line = line.strip()
                    if ":" in line:
                        k, v = line.split(":", 1)
                        headers[k.strip()] = v.strip()
        files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
        data = {"model": self.model, "response_format": "json"}
        try:
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=(10, 60))
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype.lower():
                payload = resp.json()
            else:
                try:
                    payload = resp.json()
                except Exception:
                    payload = resp.text
            text = self._extract_text(payload)
            return _postprocess(text) if text else ""
        except requests.exceptions.Timeout as e:
            raise RuntimeError(f"通用 ASR 请求超时: {e}") from e
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"通用 ASR 请求失败: {e}") from e


# ---------------------------------------------------------------------------
# STTEngine – Whisper (local)
# ---------------------------------------------------------------------------

# The packaged desktop build bundles the default base model under
# backend/assets/whisper-base (PyInstaller maps backend/assets -> assets), so
# first use works with no network. Only sizes listed here may be loaded from
# the bundle; other sizes still resolve through the normal HF cache/download.
_BUNDLED_WHISPER_SIZES = ("base",)
_BUNDLED_WHISPER_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


def _bundled_whisper_model_dir() -> Path:
    # engines.py is backend/services/stt/engines.py, so parents[2] is backend/.
    return Path(__file__).resolve().parents[2] / "assets" / "whisper-base"


def _bundled_model_path(model_size: str) -> Optional[Path]:
    if model_size not in _BUNDLED_WHISPER_SIZES:
        return None
    bundled = _bundled_whisper_model_dir()
    if bundled.is_dir():
        return bundled
    if getattr(sys, "frozen", False):
        # Packaged builds must never silently fall back to a network download.
        raise RuntimeError(
            f"内置 Whisper 模型目录缺失（{bundled}）。请重新安装应用修复，或改用其他 STT 引擎。"
        )
    return None


def _require_bundled_model_files(path: Path) -> None:
    missing = [name for name in _BUNDLED_WHISPER_FILES if not (path / name).is_file()]
    if missing:
        raise RuntimeError(
            f"内置 Whisper 模型文件不完整（{path}），缺少：{', '.join(missing)}。"
            "请重新安装应用修复，或改用其他 STT 引擎。"
        )


def _looks_like_network_error(err: Exception) -> bool:
    if isinstance(err, requests.exceptions.RequestException):
        return True
    message = str(err).lower()
    return any(
        token in message
        for token in (
            "connection", "network", "timeout", "timed out", "resolve",
            "huggingface.co", "offline", "proxy", "ssl", "certificate",
        )
    )


def _whisper_load_error(err: Exception, bundled: Optional[Path], model_size: str) -> str:
    detail = str(err) or err.__class__.__name__
    if bundled is not None:
        return (
            f"内置 Whisper 模型加载失败（{bundled}）：{detail}。"
            "模型文件可能已损坏，请重新安装应用修复。"
        )
    if _looks_like_network_error(err):
        return (
            f"Whisper 模型 {model_size} 下载失败（网络问题）：{detail}。"
            "请检查网络后重试，或改用其他 STT 引擎。"
        )
    return f"Whisper 模型加载失败（model={model_size}）：{detail}"


# ---------------------------------------------------------------------------
# 旧版本联网下载的 base 模型在内置之后成为冗余副本，升级后一次性清理
# ---------------------------------------------------------------------------

# 与 faster_whisper.utils._MODELS["base"] 对应；缓存目录名由 huggingface_hub 固定为
# models--<owner>--<repo>。只清理 base：其他档位仍然依赖这个共享缓存。
_SUPERSEDED_BASE_CACHE_DIR = "models--Systran--faster-whisper-base"
_CACHE_PRUNE_MARKER = "whisper-bundled-migration.json"


def _hf_cache_root() -> Path:
    hub_cache_override = os.environ.get("HF_HUB_CACHE", "").strip()
    if hub_cache_override:
        return Path(hub_cache_override)
    hf_home = os.environ.get("HF_HOME", "").strip()
    if hf_home:
        return Path(hf_home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def _prune_superseded_whisper_cache(data_dir: str) -> None:
    """删除旧版本下载的 base 缓存；只做一次，失败不影响启动。

    内置模型优先于缓存被加载，所以这份缓存只是磁盘上的冗余副本。但用户可能对
    small/medium/large-v3 仍有缓存需求，因此只动 base 这一个目录。
    """
    bundled = _bundled_model_path("base")
    if bundled is None:
        return
    marker = Path(data_dir) / _CACHE_PRUNE_MARKER
    if marker.is_file():
        return
    target = _hf_cache_root() / _SUPERSEDED_BASE_CACHE_DIR
    if target.is_dir():
        _log.info("Removing superseded downloaded whisper base cache: %s", target)
        shutil.rmtree(target, ignore_errors=True)
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(
            json.dumps({"pruned": ["base"], "location": str(target)}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        # 记录失败就下次再试，不值得报错。
        pass


class STTEngine:
    """Speech-to-text engine using faster-whisper."""

    TEMPERATURE_FALLBACK = [0.0, 0.2]

    def __init__(self, model_size: str = "base", language: str = "zh"):
        self.model_size = model_size
        self.language = language
        self._model = None
        self._lock = threading.Lock()
        self._loading = False

    @staticmethod
    def _best_device() -> tuple[str, str]:
        # Torch can report a CUDA backend that faster-whisper/ctranslate2
        # cannot actually use (e.g. ROCm/HIP builds on AMD GPUs, or CUDA-less
        # wheels where torch.cuda.is_available() lies). Trust ctranslate2's own
        # device probe instead: it is the runtime that will actually load the
        # model, and it knows the truth about real CUDA devices.
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", "float16"
        except Exception:
            pass
        return "cpu", "int8"

    def load_model(self):
        with self._lock:
            if self._model is not None:
                return
            self._loading = True
            try:
                bundled = _bundled_model_path(self.model_size)
                if bundled is not None:
                    _require_bundled_model_files(bundled)
                try:
                    from faster_whisper import WhisperModel
                except ImportError as e:
                    raise RuntimeError(
                        "缺少 faster-whisper 依赖，无法使用 Whisper 本地引擎。"
                        "请运行 pip install faster-whisper，或重新安装应用修复。"
                    ) from e
                device, compute_type = self._best_device()
                try:
                    self._model = WhisperModel(
                        str(bundled) if bundled is not None else self.model_size,
                        device=device,
                        compute_type=compute_type,
                    )
                except Exception as e:
                    raise RuntimeError(_whisper_load_error(e, bundled, self.model_size)) from e
            finally:
                self._loading = False

    def change_model(self, model_size: str):
        if model_size == self.model_size and self._model is not None:
            return
        with self._lock:
            self._model = None
            self.model_size = model_size
        self.load_model()

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000,
                   position: str = "后端开发", language: str = "Python") -> str:
        if self._model is None:
            self.load_model()

        audio_f = audio.astype(np.float32)
        if audio_f.max() > 1.0:
            audio_f = audio_f / 32768.0

        whisper_lang: Optional[str] = None if self.language in ("auto", "zh-en") else self.language
        initial_prompt = _build_initial_prompt(position, language)

        hotwords_list = []
        for key in ["通用", language, position]:
            v = TECH_VOCAB.get(key)
            if v:
                for w in v.split():
                    if w and any(c.isascii() and c.isalpha() for c in w):
                        hotwords_list.append(w)
        hotwords_str = " ".join(dict.fromkeys(hotwords_list))[:900]

        kwargs = dict(
            language=whisper_lang,
            beam_size=3,
            temperature=self.TEMPERATURE_FALLBACK,
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=300,
                speech_pad_ms=200,
            ),
            word_timestamps=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
        )

        try:
            segments, _ = self._model.transcribe(audio_f, hotwords=hotwords_str, **kwargs)
        except TypeError:
            segments, _ = self._model.transcribe(audio_f, **kwargs)

        texts = []
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            if hasattr(seg, "no_speech_prob") and seg.no_speech_prob > 0.5:
                continue
            texts.append(text)

        return _postprocess(" ".join(texts))

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def is_loading(self) -> bool:
        return self._loading
