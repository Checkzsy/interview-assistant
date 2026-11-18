"""Resolve Whisper files locally, with metadata-backed transfer progress."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Callable

_MODEL_REPOSITORIES = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}
_ALLOWED_FILES = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*")
_REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json")
_BUNDLED_WHISPER_FILES = (*_REQUIRED_FILES, "vocabulary.txt")
_METADATA_TIMEOUT = 10.0
_ETAG_TIMEOUT = 10.0


def _bundled_whisper_model_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "assets" / "whisper-base"


def _bundled_model_path(model_size: str) -> Path | None:
    if model_size != "base":
        return None
    bundled = _bundled_whisper_model_dir()
    if bundled.is_dir():
        return bundled
    if getattr(sys, "frozen", False):
        raise RuntimeError(
            f"内置 Whisper 模型目录缺失（{bundled}）。请重新安装应用修复，或改用其他 STT 引擎。"
        )
    return None


def _hf_cache_root() -> Path:
    override = os.environ.get("HF_HUB_CACHE", "").strip() or os.environ.get("HUGGINGFACE_HUB_CACHE", "").strip()
    if override:
        return Path(override).expanduser()
    hf_home = os.environ.get("HF_HOME", "").strip()
    if hf_home:
        return Path(hf_home).expanduser() / "hub"
    cache_home = os.environ.get("XDG_CACHE_HOME", "").strip()
    return (Path(cache_home).expanduser() if cache_home else Path.home() / ".cache") / "huggingface" / "hub"


def _allowed_file(name: str) -> bool:
    return name in _ALLOWED_FILES[:-1] or (
        name.startswith("vocabulary.") and "/" not in name and "\\" not in name
    )


def _verify_file(path: Path, name: str, expected_size: int | None = None) -> int:
    if not path.is_file():
        raise RuntimeError(f"Whisper 模型文件缺失：{name}（{path.parent}）")
    size = path.stat().st_size
    if size <= 0 or (expected_size is not None and size != expected_size):
        raise RuntimeError(f"Whisper 模型文件大小校验失败：{name}（实际 {size}，预期 {expected_size}）")
    if name.endswith(".json"):
        try:
            with path.open("r", encoding="utf-8") as file:
                value = json.load(file)
            if name in ("config.json", "preprocessor_config.json", "tokenizer.json") and not isinstance(value, dict):
                raise ValueError("JSON 内容必须是对象")
        except (OSError, UnicodeError, ValueError) as error:
            raise RuntimeError(f"Whisper 模型文件损坏：{name}（{path.parent}）：{error}") from error
    return size


def _verify_directory(directory: Path, expected_sizes: dict[str, int] | None = None) -> dict[str, int]:
    names = list(expected_sizes) if expected_sizes is not None else [path.name for path in directory.iterdir() if _allowed_file(path.name)]
    missing = [name for name in _REQUIRED_FILES if name not in names or not (directory / name).is_file()]
    if not any(name.startswith("vocabulary.") and (directory / name).is_file() for name in names):
        missing.append("vocabulary.*")
    if missing:
        raise RuntimeError(f"Whisper 模型文件不完整（{directory}），缺少：{', '.join(missing)}")
    return {name: _verify_file(directory / name, name, expected_sizes[name] if expected_sizes is not None else None) for name in names}


def _require_bundled_model_files(path: Path) -> dict[str, int]:
    missing = [name for name in _BUNDLED_WHISPER_FILES if not (path / name).is_file()]
    if missing:
        raise RuntimeError(
            f"内置 Whisper 模型文件不完整（{path}），缺少：{', '.join(missing)}。"
            "请重新安装应用修复，或改用其他 STT 引擎。"
        )
    try:
        return _verify_directory(path)
    except RuntimeError as error:
        raise RuntimeError(f"内置 Whisper 模型文件损坏（{path}）：{error}。请重新安装应用修复。") from error


def _cached_directory(repo_id: str, cache_dir: Path) -> Path | None:
    from huggingface_hub import scan_cache_dir, snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError
    from huggingface_hub.utils import CacheNotFound

    try:
        directory = Path(snapshot_download(repo_id, cache_dir=cache_dir, local_files_only=True, allow_patterns=list(_ALLOWED_FILES)))
        _verify_directory(directory)
        return directory.resolve()
    except (LocalEntryNotFoundError, RuntimeError):
        pass

    # Fixed-commit downloads need not create a `main` ref. Scan only the public
    # finalized-snapshot records; historical .incomplete blobs are never counted.
    try:
        cache = scan_cache_dir(cache_dir)
    except CacheNotFound:
        return None
    for repo in cache.repos:
        if repo.repo_id != repo_id or repo.repo_type != "model":
            continue
        for revision in sorted(repo.revisions, key=lambda item: item.last_modified, reverse=True):
            directory = revision.snapshot_path
            try:
                _verify_directory(directory)
            except RuntimeError:
                continue
            return directory.resolve()
    return None


def _download_tqdm_class(report_bytes: Callable[[int], None], file_size: int):
    from huggingface_hub.utils.tqdm import tqdm

    current_bar = None

    class ModelFileProgress(tqdm):
        def __init__(self, *args, **kwargs):
            nonlocal current_bar
            self._received_bytes = float(kwargs.get("initial", 0) or 0)
            super().__init__(*args, **kwargs)
            current_bar = self
            report_bytes(int(max(0, min(file_size, self._received_bytes))))

        def update(self, n=1):
            self._received_bytes += n
            result = super().update(n)
            if current_bar is self:
                report_bytes(int(max(0, min(file_size, self._received_bytes))))
            return result

    return ModelFileProgress


def prepare_model_files(
    model_size: str,
    on_progress: Callable[[dict], None] | None = None,
) -> Path:
    """Return an absolute local directory without loading Whisper.

    Callback fields are phase (resolving/downloading/downloaded/loading), filename,
    downloaded_bytes, total_bytes and progress (0..100, or None before metadata).
    Only metadata-backed, validated transfers report downloaded at 100%.
    Local caches have no trusted byte denominator; native loading validates binaries.
    SDK metadata/HEAD timeouts bound individual operations, not the whole download.
    """
    repo_id = _MODEL_REPOSITORIES.get(model_size)
    if repo_id is None:
        raise ValueError(f"不支持的 Whisper 模型：{model_size}")

    def report(phase, downloaded_bytes=None, total_bytes=None, filename=None):
        if on_progress is None:
            return
        progress = None
        if total_bytes is not None:
            progress = 100.0 if phase == "downloaded" else min(99.9, 100.0 * downloaded_bytes / total_bytes)
        on_progress({
            "phase": phase,
            "filename": filename,
            "downloaded_bytes": downloaded_bytes,
            "total_bytes": total_bytes,
            "progress": progress,
        })

    report("resolving")
    bundled = _bundled_model_path(model_size)
    if bundled is not None:
        _require_bundled_model_files(bundled)
        report("loading")
        return bundled.resolve()

    cache_dir = _hf_cache_root()
    cached = _cached_directory(repo_id, cache_dir)
    if cached is not None:
        # Legacy caches have no trusted byte manifest. Native loading, not local
        # file sizes, decides model readiness; this path performs no transfer.
        report("loading")
        return cached

    from huggingface_hub import HfApi, hf_hub_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    info = HfApi().model_info(repo_id, files_metadata=True, timeout=_METADATA_TIMEOUT)
    if not isinstance(info.sha, str) or re.fullmatch(r"[0-9a-fA-F]{40}", info.sha) is None:
        raise RuntimeError("Whisper 模型元数据缺少可靠的 commit 版本，无法固定下载版本。")
    sizes = {file.rfilename: file.size for file in (info.siblings or []) if _allowed_file(file.rfilename)}
    missing = [name for name in _REQUIRED_FILES if name not in sizes]
    if not any(name.startswith("vocabulary.") for name in sizes):
        missing.append("vocabulary.*")
    if missing:
        raise RuntimeError(f"Whisper 模型元数据缺少必要文件：{', '.join(missing)}")
    for name, size in sizes.items():
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise RuntimeError(f"Whisper 模型元数据缺少可靠的文件大小：{name}，无法计算下载进度。")
    sizes = {name: sizes[name] for name in (*_ALLOWED_FILES[:-1], *sorted(name for name in sizes if name.startswith("vocabulary."))) if name in sizes}
    total = sum(sizes.values())
    completed_bytes = 0
    paths = {}
    invalid_files = set()
    for name, size in sizes.items():
        try:
            path = Path(hf_hub_download(repo_id, name, revision=info.sha, cache_dir=cache_dir, local_files_only=True))
        except LocalEntryNotFoundError:
            continue
        try:
            _verify_file(path, name, size)
        except (RuntimeError, OSError):
            invalid_files.add(name)
            continue
        paths[name] = path
        completed_bytes += size

    report("downloading", completed_bytes, total)
    for name, size in sizes.items():
        if name in paths:
            continue
        report("downloading", completed_bytes, total, name)
        base_bytes = completed_bytes
        tqdm_class = _download_tqdm_class(
            lambda received, filename=name, base=base_bytes: report("downloading", base + received, total, filename),
            size,
        )
        path = Path(hf_hub_download(
            repo_id, name, revision=info.sha, cache_dir=cache_dir,
            tqdm_class=tqdm_class, etag_timeout=_ETAG_TIMEOUT,
            force_download=name in invalid_files,
        ))
        _verify_file(path, name, size)
        paths[name] = path
        completed_bytes += size

    directories = {path.parent.resolve() for path in paths.values()}
    if len(directories) != 1:
        raise RuntimeError("Whisper 模型文件不在同一版本目录，无法安全加载。")
    directory = directories.pop()
    _verify_directory(directory, sizes)
    report("downloaded", total, total)
    return directory
