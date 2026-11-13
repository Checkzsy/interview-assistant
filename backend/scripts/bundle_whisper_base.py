"""Stage the faster-whisper ``base`` model into the packaged backend.

Product decision: only the ``base`` model ships inside the installer (~145MB);
every other size is still fetched on demand from Hugging Face.  The desktop
build runs ``stage`` before PyInstaller (the existing ``--add-data
backend/assets;assets`` then packages the files) and ``verify-packaged`` after
it, so a model-less installer cannot be emitted silently.

The repository never holds the weights: ``backend/assets/whisper-base/`` is
gitignored and materialised at build time.

Usage::

    python backend/scripts/bundle_whisper_base.py stage --dest backend/assets/whisper-base
    python backend/scripts/bundle_whisper_base.py verify-packaged --name backend --root build
    python backend/scripts/bundle_whisper_base.py smoke --dest backend/assets/whisper-base
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Callable, Iterable

BACKEND_DIR = Path(__file__).resolve().parents[1]

MODEL_REPO = "Systran/faster-whisper-base"
# Immutable commit; never point this at a branch.
MODEL_REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"

# vocabulary.txt / tokenizer.json must be present or faster-whisper falls back
# to fetching the tokenizer at first transcription, which breaks offline use.
REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")

# Floors that catch truncated or replaced-with-a-placeholder downloads.  Content
# integrity for real downloads is enforced by huggingface_hub's etag check.
MIN_FILE_BYTES = {
    "config.json": 128,
    "model.bin": 1_000_000,
    "tokenizer.json": 1024,
    "vocabulary.txt": 1024,
}

MANIFEST_NAME = "manifest.json"

Downloader = Callable[[Path], None]


class BundleError(RuntimeError):
    """Raised when the bundled model is missing, incomplete, or unverifiable."""


def default_dest() -> Path:
    return BACKEND_DIR / "assets" / "whisper-base"


def validate_model_dir(directory: Path) -> None:
    """Raise :class:`BundleError` unless *directory* holds a complete model."""
    directory = Path(directory)
    if not directory.is_dir():
        raise BundleError(f"内置 Whisper 模型目录不存在: {directory}")

    problems: list[str] = []
    for name in REQUIRED_FILES:
        path = directory / name
        if path.is_symlink():
            # PyInstaller copies file contents, but a symlink into the HF cache
            # would silently produce an empty package entry.
            problems.append(f"{name} 是符号链接，必须实体化")
            continue
        if not path.is_file():
            problems.append(f"{name} 缺失")
            continue
        size = path.stat().st_size
        floor = MIN_FILE_BYTES.get(name, 1)
        if size < floor:
            problems.append(f"{name} 不完整（{size} 字节 < {floor} 字节）")

    if problems:
        raise BundleError(f"内置 Whisper 模型不完整 ({directory}): " + "; ".join(problems))


def download_with_hf_hub(dest: Path, hf_hub_download: Callable | None = None) -> None:
    """Download the pinned revision into *dest*, preferring the local cache."""
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)

    if hf_hub_download is None:
        try:
            from huggingface_hub import hf_hub_download  # noqa: PLC0415 - lazy on purpose
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise BundleError(
                "需要 huggingface_hub 或 faster-whisper 才能下载内置模型；"
                "请先安装 backend/requirements.txt"
            ) from exc

    for name in REQUIRED_FILES:
        last_error: Exception | None = None
        for local_files_only in (True, False):
            try:
                hf_hub_download(
                    MODEL_REPO,
                    name,
                    revision=MODEL_REVISION,
                    local_dir=str(dest),
                    local_files_only=local_files_only,
                )
                break
            except Exception as exc:  # noqa: BLE001 - surfaced below
                last_error = exc
        else:
            raise BundleError(
                f"下载内置 Whisper 模型失败: {MODEL_REPO}@{MODEL_REVISION}/{name} — {last_error}"
            ) from last_error


def _is_current(dest: Path) -> bool:
    """True when *dest* already holds a complete model at the pinned revision."""
    manifest_path = dest / MANIFEST_NAME
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("revision") != MODEL_REVISION:
            return False
        validate_model_dir(dest)
    except (OSError, ValueError, BundleError):
        return False

    for name in REQUIRED_FILES:
        entry = manifest.get("files", {}).get(name, {})
        path = dest / name
        if entry.get("bytes") != path.stat().st_size:
            return False
    return True


def build_manifest(directory: Path) -> dict:
    directory = Path(directory)
    files = {}
    for name in REQUIRED_FILES:
        path = directory / name
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        files[name] = {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}
    return {"repo": MODEL_REPO, "revision": MODEL_REVISION, "files": files}


def stage_model(dest: Path, downloader: Downloader | None = None) -> Path:
    """Materialise the model into *dest*, replacing any stale copy."""
    dest = Path(dest)
    if _is_current(dest):
        return dest

    downloader = downloader or download_with_hf_hub
    staging = dest.with_name(dest.name + ".staging")

    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        downloader(staging)
        # hf_hub_download(local_dir=...) nests download metadata under
        # .cache/huggingface; it has no place inside the installer.
        shutil.rmtree(staging / ".cache", ignore_errors=True)
        validate_model_dir(staging)
        manifest = build_manifest(staging)
        (staging / MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    shutil.rmtree(dest, ignore_errors=True)
    staging.replace(dest)
    return dest


def verify_packaged(name: str, root: str | Path = "build") -> Path:
    """Confirm PyInstaller emitted the model (one-dir and one-file layouts)."""
    base = Path(root) / name
    for assets in (base / "_internal" / "assets", base / "assets"):
        model_dir = assets / "whisper-base"
        if model_dir.is_dir():
            validate_model_dir(model_dir)
            return model_dir
    raise BundleError(
        f"打包产物 {base} 中缺少 assets/whisper-base；"
        "内置模型没有被打进安装包，拒绝继续构建"
    )


def smoke_transcribe(model_dir: Path) -> str:
    """Offline CPU transcription of the bundled preflight phrase."""
    import os  # noqa: PLC0415

    from faster_whisper import WhisperModel  # noqa: PLC0415

    validate_model_dir(model_dir)
    audio = BACKEND_DIR / "assets" / "preflight_phrase.wav"
    if not audio.is_file():
        raise BundleError(f"缺少自检音频: {audio}")

    previous = {key: os.environ.get(key) for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")}
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        model = WhisperModel(str(Path(model_dir).resolve()), device="cpu", compute_type="int8")
        segments, _info = model.transcribe(str(audio), language="zh", vad_filter=False)
        return "".join(segment.text for segment in segments).strip()
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main(argv: Iterable[str] | None = None, downloader: Downloader | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stage/verify the bundled whisper base model")
    sub = parser.add_subparsers(dest="command", required=True)

    stage = sub.add_parser("stage", help="download and verify the model into the source tree")
    stage.add_argument("--dest", help="destination directory inside backend/assets")

    verify = sub.add_parser("verify-packaged", help="check a PyInstaller output for the model")
    verify.add_argument("--name", default="backend", help="PyInstaller executable name")
    verify.add_argument("--root", default="build", help="PyInstaller distpath")

    smoke = sub.add_parser("smoke", help="offline CPU transcription using the staged model")
    smoke.add_argument("--dest")

    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        if args.command == "stage":
            if not args.dest:
                print("错误: stage 需要 --dest <目录>", file=sys.stderr)
                return 2
            dest = stage_model(Path(args.dest), downloader=downloader)
            manifest = json.loads((dest / MANIFEST_NAME).read_text(encoding="utf-8"))
            print(f"内置 Whisper 模型已就绪: {dest} (revision {manifest['revision']})")
            return 0
        if args.command == "verify-packaged":
            model_dir = verify_packaged(args.name, args.root)
            print(f"打包产物已包含 Whisper 模型: {model_dir}")
            return 0
        if args.command == "smoke":
            text = smoke_transcribe(Path(args.dest) if args.dest else default_dest())
            print(f"离线转写结果: {text}")
            return 0 if text else 1
    except BundleError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
