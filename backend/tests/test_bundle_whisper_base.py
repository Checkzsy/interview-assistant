"""Unit tests for the whisper-base model staging build script.

These tests never touch the network: every downloader is injected.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts import bundle_whisper_base as bundle  # noqa: E402


REQUIRED = bundle.REQUIRED_FILES


def _write_model(directory: Path, *, sizes=None, omit=()):
    directory.mkdir(parents=True, exist_ok=True)
    sizes = sizes or {}
    for name in REQUIRED:
        if name in omit:
            continue
        payload = b"x" * sizes.get(name, bundle.MIN_FILE_BYTES.get(name, 16))
        (directory / name).write_bytes(payload)


def test_revision_is_pinned_to_an_immutable_commit():
    assert bundle.MODEL_REPO == "Systran/faster-whisper-base"
    assert len(bundle.MODEL_REVISION) == 40
    assert all(char in "0123456789abcdef" for char in bundle.MODEL_REVISION)


def test_required_files_cover_tokenizer_offline_fallback():
    # Without tokenizer.json/vocabulary.txt faster-whisper falls back to a
    # network tokenizer fetch at first transcription.
    assert set(REQUIRED) == {"config.json", "model.bin", "tokenizer.json", "vocabulary.txt"}


def test_validate_model_dir_accepts_a_complete_model(tmp_path):
    _write_model(tmp_path)
    bundle.validate_model_dir(tmp_path)


@pytest.mark.parametrize("missing", REQUIRED)
def test_validate_model_dir_rejects_missing_files(tmp_path, missing):
    _write_model(tmp_path, omit={missing})
    with pytest.raises(bundle.BundleError, match=missing):
        bundle.validate_model_dir(tmp_path)


def test_validate_model_dir_rejects_empty_files(tmp_path):
    _write_model(tmp_path, sizes={"model.bin": 0})
    with pytest.raises(bundle.BundleError, match="model.bin"):
        bundle.validate_model_dir(tmp_path)


def test_validate_model_dir_rejects_symlinks(tmp_path):
    _write_model(tmp_path, omit={"config.json"})
    real = tmp_path.parent / "config-target.json"
    real.write_bytes(b"{}")
    try:
        (tmp_path / "config.json").symlink_to(real)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")
    with pytest.raises(bundle.BundleError, match="符号链接"):
        bundle.validate_model_dir(tmp_path)


def test_stage_materializes_files_into_destination(tmp_path):
    source = tmp_path / "cache-model"
    _write_model(source)
    dest = tmp_path / "assets" / "whisper-base"

    bundle.stage_model(dest, downloader=lambda target: _copy_model(source, target))

    for name in REQUIRED:
        assert (dest / name).is_file()
        assert not (dest / name).is_symlink()


def test_stage_replaces_a_stale_partial_destination(tmp_path):
    source = tmp_path / "cache-model"
    _write_model(source)
    dest = tmp_path / "whisper-base"
    dest.mkdir()
    (dest / "model.bin").write_bytes(b"stale")

    bundle.stage_model(dest, downloader=lambda target: _copy_model(source, target))

    assert (dest / "model.bin").stat().st_size == bundle.MIN_FILE_BYTES["model.bin"]


def test_stage_fails_when_the_download_produces_an_incomplete_model(tmp_path):
    dest = tmp_path / "whisper-base"

    def broken(target):
        target.mkdir(parents=True, exist_ok=True)
        (target / "config.json").write_bytes(b"{}")

    with pytest.raises(bundle.BundleError):
        bundle.stage_model(dest, downloader=broken)


def test_stage_drops_huggingface_bookkeeping_files(tmp_path):
    # hf_hub_download(local_dir=...) leaves a nested .cache/huggingface with
    # download metadata; those must not end up inside the installer.
    source = tmp_path / "cache-model"
    _write_model(source)
    dest = tmp_path / "whisper-base"

    def downloader(target):
        _copy_model(source, target)
        (target / ".cache" / "huggingface" / "download").mkdir(parents=True)
        (target / ".cache" / "huggingface" / "download" / "model.bin.metadata").write_text("{}")

    bundle.stage_model(dest, downloader=downloader)

    assert not (dest / ".cache").exists()
    assert sorted(path.name for path in dest.iterdir()) == sorted(REQUIRED + (bundle.MANIFEST_NAME,))


def test_stage_reuses_an_already_valid_model(tmp_path):
    source = tmp_path / "cache-model"
    _write_model(source)
    dest = tmp_path / "whisper-base"

    bundle.stage_model(dest, downloader=lambda target: _copy_model(source, target))
    calls = []

    def should_not_run(target):
        calls.append(target)

    bundle.stage_model(dest, downloader=should_not_run)
    assert calls == []


def test_stage_restages_when_the_manifest_revision_changes(tmp_path):
    source = tmp_path / "cache-model"
    _write_model(source)
    dest = tmp_path / "whisper-base"
    bundle.stage_model(dest, downloader=lambda target: _copy_model(source, target))

    manifest = json.loads((dest / bundle.MANIFEST_NAME).read_text(encoding="utf-8"))
    manifest["revision"] = "0" * 40
    (dest / bundle.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")

    calls = []
    bundle.stage_model(dest, downloader=lambda target: calls.append(target) or _copy_model(source, target))
    assert calls


def test_staged_destination_is_idempotent(tmp_path):
    source = tmp_path / "cache-model"
    _write_model(source)
    dest = tmp_path / "whisper-base"

    bundle.stage_model(dest, downloader=lambda target: _copy_model(source, target))
    bundle.stage_model(dest, downloader=lambda target: _copy_model(source, target))

    for name in REQUIRED:
        assert (dest / name).is_file()


def test_verify_packaged_dir_detects_a_model_less_build(tmp_path):
    packaged = tmp_path / "backend"
    (packaged / "_internal" / "assets").mkdir(parents=True)
    with pytest.raises(bundle.BundleError):
        bundle.verify_packaged("backend", root=tmp_path)


def test_verify_packaged_dir_accepts_both_onedir_and_onefile_layouts(tmp_path):
    for layout in ("_internal/assets", "assets"):
        root = tmp_path / layout.replace("/", "_")
        packaged = root / "backend"
        _write_model(packaged / layout / "whisper-base")
        bundle.verify_packaged("backend", root=root)


def test_default_destination_points_at_backend_assets():
    dest = bundle.default_dest()
    assert dest == BACKEND_DIR / "assets" / "whisper-base"


def test_hf_downloader_uses_pinned_revision_and_materializes(tmp_path):
    calls = []

    def fake_hf(repo_id, filename, **kwargs):
        calls.append((repo_id, filename, kwargs))

    dest = tmp_path / "whisper-base"
    bundle.download_with_hf_hub(dest, hf_hub_download=fake_hf)

    assert {call[1] for call in calls} == set(REQUIRED)
    for repo_id, _filename, kwargs in calls:
        assert repo_id == bundle.MODEL_REPO
        assert kwargs["revision"] == bundle.MODEL_REVISION
        assert kwargs["local_dir"] == str(dest)


def test_hf_downloader_prefers_an_existing_local_cache(tmp_path):
    seen = []

    def offline_hf(repo_id, filename, **kwargs):
        seen.append(kwargs["local_files_only"])

    bundle.download_with_hf_hub(tmp_path / "whisper-base", hf_hub_download=offline_hf)
    assert seen and all(seen), "the local cache must be consulted before the network"


def test_hf_downloader_falls_back_to_the_network_when_the_cache_misses(tmp_path):
    attempts = []

    def cold_cache(repo_id, filename, **kwargs):
        attempts.append(kwargs["local_files_only"])
        if kwargs["local_files_only"]:
            raise RuntimeError("not in cache")

    bundle.download_with_hf_hub(tmp_path / "whisper-base", hf_hub_download=cold_cache)
    assert attempts == [True, False] * len(REQUIRED)


def test_hf_downloader_reports_download_failures_as_bundle_errors(tmp_path):
    def always_fails(repo_id, filename, **kwargs):
        raise ConnectionError("Failed to resolve huggingface.co")

    with pytest.raises(bundle.BundleError, match="huggingface.co"):
        bundle.download_with_hf_hub(tmp_path / "whisper-base", hf_hub_download=always_fails)


def test_hf_downloader_error_mentions_the_pinned_revision(tmp_path):
    def always_fails(repo_id, filename, **kwargs):
        raise ConnectionError("offline")

    with pytest.raises(bundle.BundleError, match=bundle.MODEL_REVISION):
        bundle.download_with_hf_hub(tmp_path / "whisper-base", hf_hub_download=always_fails)


def test_missing_huggingface_hub_is_reported_with_install_hint(tmp_path, monkeypatch):
    import builtins

    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if name == "huggingface_hub":
            raise ImportError("not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)
    with pytest.raises(bundle.BundleError, match="requirements"):
        bundle.download_with_hf_hub(tmp_path / "whisper-base")


def _copy_model(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for name in REQUIRED:
        (target / name).write_bytes((source / name).read_bytes())


def test_manifest_records_revision_and_checksums(tmp_path):
    dest = tmp_path / "whisper-base"
    _write_model(dest)

    manifest = bundle.build_manifest(dest)

    assert manifest["repo"] == bundle.MODEL_REPO
    assert manifest["revision"] == bundle.MODEL_REVISION
    assert set(manifest["files"]) == set(REQUIRED)
    for entry in manifest["files"].values():
        assert len(entry["sha256"]) == 64
        assert entry["bytes"] > 0


def test_main_stage_requires_an_explicit_destination(tmp_path, monkeypatch, capsys):
    rc = bundle.main(["stage"])
    assert rc != 0
    assert "dest" in capsys.readouterr().err.lower()


def test_main_stage_writes_a_manifest(tmp_path):
    source = tmp_path / "cache-model"
    _write_model(source)
    dest = tmp_path / "whisper-base"

    rc = bundle.main(
        ["stage", "--dest", str(dest)],
        downloader=lambda target: _copy_model(source, target),
    )

    assert rc == 0
    manifest = json.loads((dest / bundle.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert manifest["revision"] == bundle.MODEL_REVISION
