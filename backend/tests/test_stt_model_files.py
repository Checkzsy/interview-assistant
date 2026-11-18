from __future__ import annotations

import contextlib
import importlib
import sys
import types
from pathlib import Path

import httpx
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.stt import model_files  # noqa: E402

SHA = "a" * 40
FILES = {
    "config.json": b'{"model_type":"Whisper"}',
    "preprocessor_config.json": b'{"sampling_rate":16000}',
    "model.bin": b"0123456789",
    "tokenizer.json": b'{"version":"1.0"}',
    "vocabulary.txt": b"token\n",
}
REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}


def _write_files(directory: Path, files: dict[str, bytes] | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in (FILES if files is None else files).items():
        (directory / name).write_bytes(data)
    return directory


def _snapshot(cache: Path, repo: str, *, files=None, ref=True, sha=SHA) -> Path:
    repo_path = cache / ("models--" + repo.replace("/", "--"))
    directory = _write_files(repo_path / "snapshots" / sha, files)
    if ref:
        (repo_path / "refs").mkdir(exist_ok=True)
        (repo_path / "refs" / "main").write_text(sha, encoding="utf-8")
    return directory


class _HubBoundary:
    def __init__(self, cache: Path):
        import huggingface_hub

        self.cache = cache
        self.real_download = huggingface_hub.hf_hub_download
        self.info_calls: list[dict] = []
        self.download_calls: list[dict] = []
        self.files = dict(FILES)
        self.sizes = {name: len(data) for name, data in self.files.items()}
        self.sha = SHA
        self.runners: dict = {}

    def model_info(self, repo_id, **kwargs):
        self.info_calls.append({"repo_id": repo_id, **kwargs})
        siblings = [types.SimpleNamespace(rfilename=name, size=self.sizes[name]) for name in self.files]
        siblings.extend([
            types.SimpleNamespace(rfilename="README.md", size=None),
            types.SimpleNamespace(rfilename="weights/model.bin", size=None),
            types.SimpleNamespace(rfilename="subdir/vocabulary.txt", size=None),
        ])
        return types.SimpleNamespace(sha=self.sha, siblings=siblings)

    def download(self, repo_id, filename, **kwargs):
        self.download_calls.append({"repo_id": repo_id, "filename": filename, **kwargs})
        if kwargs.get("local_files_only"):
            return self.real_download(repo_id, filename, **kwargs)
        directory = self.cache / ("models--" + repo_id.replace("/", "--")) / "snapshots" / self.sha
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / filename
        runner = self.runners.get(filename)
        if runner is None:
            with kwargs["tqdm_class"](total=self.sizes[filename], initial=0, disable=True) as bar:
                bar.update(len(self.files[filename]))
            destination.write_bytes(self.files[filename])
        else:
            runner(destination, kwargs["tqdm_class"], self)
        return str(destination)

    @property
    def online_calls(self):
        return [call for call in self.download_calls if not call.get("local_files_only")]

    def install(self, monkeypatch):
        import huggingface_hub

        monkeypatch.setattr(huggingface_hub.HfApi, "model_info", lambda _self, *args, **kwargs: self.model_info(*args, **kwargs))
        monkeypatch.setattr(huggingface_hub, "hf_hub_download", self.download)
        return self


@pytest.fixture(autouse=True)
def isolated_hub(tmp_path, monkeypatch):
    import huggingface_hub

    cache = tmp_path / "hf-cache"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_CACHE", raising=False)
    monkeypatch.setattr(model_files, "_bundled_whisper_model_dir", lambda: tmp_path / "assets" / "whisper-base")
    monkeypatch.setattr(model_files.sys, "frozen", False, raising=False)

    def unexpected_metadata(*_args, **_kwargs):
        raise AssertionError("unexpected Hub metadata/network access")

    monkeypatch.setattr(huggingface_hub.HfApi, "model_info", unexpected_metadata)
    return cache


def test_packaged_model_path_contract(monkeypatch):
    monkeypatch.undo()
    assert model_files._bundled_whisper_model_dir() == BACKEND_DIR / "assets" / "whisper-base"


def test_bundled_base_is_verified_without_hub_import(tmp_path, monkeypatch):
    bundle = _write_files(tmp_path / "assets" / "whisper-base")
    monkeypatch.setitem(sys.modules, "huggingface_hub", None)
    events = []

    assert model_files.prepare_model_files("base", events.append) == bundle.resolve()
    assert events[-1]["phase"] == "loading"
    assert all(event["downloaded_bytes"] is None for event in events)
    assert all(event["total_bytes"] is None and event["progress"] is None for event in events)


@pytest.mark.parametrize("missing", REQUIRED_FILES)
def test_incomplete_bundle_never_falls_back_to_hub(tmp_path, missing):
    bundle = _write_files(tmp_path / "assets" / "whisper-base", {k: v for k, v in FILES.items() if k != missing})
    with pytest.raises(RuntimeError) as excinfo:
        model_files.prepare_model_files("base")
    assert missing in str(excinfo.value)
    assert str(bundle) in str(excinfo.value)
    assert "重新安装" in str(excinfo.value)


@pytest.mark.parametrize("bad_file,data", [("model.bin", b""), ("config.json", b"not-json"), ("tokenizer.json", b"not-json")])
def test_corrupt_bundle_never_falls_back_to_hub(tmp_path, bad_file, data):
    bundle = _write_files(tmp_path / "assets" / "whisper-base")
    (bundle / bad_file).write_bytes(data)
    with pytest.raises(RuntimeError) as excinfo:
        model_files.prepare_model_files("base")
    assert bad_file in str(excinfo.value)
    assert "重新安装" in str(excinfo.value)


def test_frozen_missing_base_bundle_never_uses_cache_or_network(isolated_hub, monkeypatch):
    _snapshot(isolated_hub, REPOS["base"])
    monkeypatch.setattr(model_files.sys, "frozen", True, raising=False)
    with pytest.raises(RuntimeError, match="重新安装"):
        model_files.prepare_model_files("base")


@pytest.mark.parametrize("model_size,repo_id", REPOS.items())
def test_explicit_repo_mapping_and_dev_base_download(isolated_hub, monkeypatch, model_size, repo_id):
    hub = _HubBoundary(isolated_hub).install(monkeypatch)
    events = []
    directory = model_files.prepare_model_files(model_size, events.append)

    assert directory.is_absolute()
    assert directory == isolated_hub / ("models--" + repo_id.replace("/", "--")) / "snapshots" / SHA
    assert hub.info_calls == [{"repo_id": repo_id, "files_metadata": True, "timeout": 10.0}]
    assert {call["filename"] for call in hub.online_calls} == set(FILES)
    assert all(call["revision"] == SHA and call["etag_timeout"] == 10.0 for call in hub.online_calls)
    assert all(call["repo_id"] == repo_id for call in hub.download_calls)
    assert events[0]["phase"] == "resolving"
    assert events[0]["total_bytes"] is None
    assert events[-1]["phase"] == "downloaded"
    assert events[-1]["downloaded_bytes"] == events[-1]["total_bytes"] == sum(map(len, FILES.values()))
    assert events[-1]["progress"] == 100
    assert all(event["progress"] != 100 for event in events[:-1])
    assert {event["total_bytes"] for event in events if event["total_bytes"] is not None} == {sum(map(len, FILES.values()))}


def test_unsupported_model_does_not_touch_hub():
    with pytest.raises(ValueError, match="unsupported|不支持"):
        model_files.prepare_model_files("large")


@pytest.mark.parametrize("ref", [True, False])
@pytest.mark.parametrize("preprocessor", [True, False])
def test_complete_final_cache_is_network_free_even_without_main_ref(isolated_hub, ref, preprocessor):
    files = FILES if preprocessor else {name: data for name, data in FILES.items() if name != "preprocessor_config.json"}
    directory = _snapshot(isolated_hub, REPOS["medium"], files=files, ref=ref)
    events = []

    assert model_files.prepare_model_files("medium", events.append) == directory
    assert events[-1]["phase"] == "loading"
    assert all(event["downloaded_bytes"] is None for event in events)
    assert all(event["total_bytes"] is None and event["progress"] is None for event in events)


def test_corrupt_cached_binary_does_not_report_transfer_success(isolated_hub, monkeypatch):
    from services.stt import engines

    directory = _snapshot(isolated_hub, REPOS["medium"], files={**FILES, "model.bin": b"x"})
    calls = []
    events = []

    def construct(path, **kwargs):
        calls.append(path)
        assert Path(path) == directory
        assert (Path(path) / "model.bin").read_bytes() == b"x"
        raise RuntimeError("invalid model.bin")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=construct))
    engine = engines.STTEngine("medium", "en")
    with pytest.raises(RuntimeError, match="invalid model.bin"):
        engine.load_model(progress=events.append)

    assert calls == [str(directory)]
    assert engine.is_loaded is False
    assert engine.prepare_snapshot()["phase"] == "error"
    assert any(event["phase"] == "loading" for event in events)
    assert all(event["phase"] != "downloaded" and event.get("progress") != 100 for event in events)
    assert all(event.get("total_bytes") is None and event.get("downloaded_bytes") is None for event in events)
    assert (directory / "model.bin").read_bytes() == b"x"


@pytest.mark.parametrize("bad_file,data", [
    ("config.json", b"not-json"),
    ("tokenizer.json", b"not-json"),
    ("model.bin", b"x"),
])
def test_online_metadata_selectively_repairs_invalid_cached_files(isolated_hub, monkeypatch, bad_file, data):
    files = {name: value for name, value in FILES.items() if name != "vocabulary.txt"}
    files[bad_file] = data
    directory = _snapshot(isolated_hub, REPOS["small"], files=files)
    hub = _HubBoundary(isolated_hub).install(monkeypatch)
    events = []

    assert model_files.prepare_model_files("small", events.append) == directory

    assert {call["filename"] for call in hub.online_calls} == {bad_file, "vocabulary.txt"}
    forced = [call["filename"] for call in hub.online_calls if call.get("force_download")]
    assert forced == [bad_file]
    assert all(call["revision"] == SHA for call in hub.download_calls)
    assert {event["total_bytes"] for event in events if event["total_bytes"] is not None} == {sum(map(len, FILES.values()))}
    assert events[-1]["phase"] == "downloaded" and events[-1]["progress"] == 100
    assert all(event["progress"] != 100 for event in events[:-1])
    assert {name: (directory / name).read_bytes() for name in FILES} == FILES


def test_invalid_file_returned_by_forced_repair_never_reports_success(isolated_hub, monkeypatch):
    directory = _snapshot(isolated_hub, REPOS["small"], files={**FILES, "tokenizer.json": b"not-json"})
    hub = _HubBoundary(isolated_hub)

    def corrupt_after_transfer(destination, tqdm_class, boundary):
        with tqdm_class(total=boundary.sizes["tokenizer.json"], initial=0, disable=True) as bar:
            bar.update(boundary.sizes["tokenizer.json"])
        destination.write_bytes(b"x" * boundary.sizes["tokenizer.json"])

    hub.runners["tokenizer.json"] = corrupt_after_transfer
    hub.install(monkeypatch)
    events = []
    with pytest.raises(RuntimeError, match="tokenizer.json"):
        model_files.prepare_model_files("small", events.append)

    assert [call["filename"] for call in hub.online_calls] == ["tokenizer.json"]
    assert hub.online_calls[0]["force_download"] is True
    assert all(event["phase"] != "downloaded" and event["progress"] != 100 for event in events)
    assert (directory / "model.bin").read_bytes() == FILES["model.bin"]


def test_cache_without_tokenizer_is_not_considered_complete(isolated_hub, monkeypatch):
    cached = {k: v for k, v in FILES.items() if k != "tokenizer.json"}
    directory = _snapshot(isolated_hub, REPOS["small"], files=cached)
    hub = _HubBoundary(isolated_hub).install(monkeypatch)
    events = []

    assert model_files.prepare_model_files("small", events.append) == directory
    assert len(hub.info_calls) == 1
    assert [call["filename"] for call in hub.online_calls] == ["tokenizer.json"]
    first_download = next(event for event in events if event["phase"] == "downloading")
    assert first_download["downloaded_bytes"] == sum(map(len, cached.values()))
    assert first_download["total_bytes"] == sum(map(len, FILES.values()))


def test_missing_optional_preprocessor_and_vocabulary_json_are_supported(isolated_hub, monkeypatch):
    hub = _HubBoundary(isolated_hub)
    hub.files.pop("preprocessor_config.json")
    hub.files.pop("vocabulary.txt")
    hub.files["vocabulary.json"] = b'["token"]'
    hub.sizes = {name: len(data) for name, data in hub.files.items()}
    hub.install(monkeypatch)
    directory = model_files.prepare_model_files("large-v3")

    assert (directory / "vocabulary.json").is_file()
    assert not (directory / "preprocessor_config.json").exists()
    assert {call["filename"] for call in hub.online_calls} == set(hub.files)


@pytest.mark.parametrize("missing", REQUIRED_FILES)
def test_metadata_missing_required_files_fails_before_download(isolated_hub, monkeypatch, missing):
    hub = _HubBoundary(isolated_hub)
    hub.files.pop(missing)
    hub.install(monkeypatch)
    with pytest.raises(RuntimeError) as excinfo:
        model_files.prepare_model_files("medium")
    assert (missing if missing != "vocabulary.txt" else "vocabulary") in str(excinfo.value)
    assert not hub.download_calls


@pytest.mark.parametrize("size", [None, 0, -1, True, 1.5])
def test_unreliable_metadata_size_fails_instead_of_guessing(isolated_hub, monkeypatch, size):
    hub = _HubBoundary(isolated_hub)
    hub.sizes["model.bin"] = size
    hub.install(monkeypatch)
    events = []
    with pytest.raises(RuntimeError, match="model.bin"):
        model_files.prepare_model_files("medium", events.append)
    assert not hub.download_calls
    assert all(event["progress"] is None for event in events)


@pytest.mark.parametrize("sha", [None, "main", "", "g" * 40])
def test_metadata_must_pin_a_real_commit(isolated_hub, monkeypatch, sha):
    hub = _HubBoundary(isolated_hub)
    hub.sha = sha
    hub.install(monkeypatch)
    with pytest.raises(RuntimeError, match="commit|版本"):
        model_files.prepare_model_files("small")
    assert not hub.download_calls


@pytest.mark.parametrize("bad_file", ["model.bin", "tokenizer.json"])
def test_all_bytes_transferred_does_not_mean_validation_succeeded(isolated_hub, monkeypatch, bad_file):
    hub = _HubBoundary(isolated_hub)
    cached = {k: v for k, v in FILES.items() if k != bad_file}
    _snapshot(isolated_hub, REPOS["small"], files=cached)

    def corrupt_after_transfer(destination, tqdm_class, boundary):
        with tqdm_class(total=boundary.sizes[bad_file], initial=0, disable=True) as bar:
            bar.update(boundary.sizes[bad_file])
        if bad_file == "model.bin":
            destination.write_bytes(b"short")
        else:
            destination.write_bytes(b"x" * boundary.sizes[bad_file])

    hub.runners[bad_file] = corrupt_after_transfer
    hub.install(monkeypatch)
    events = []
    with pytest.raises(RuntimeError, match=bad_file):
        model_files.prepare_model_files("small", events.append)
    assert events[-1]["downloaded_bytes"] == events[-1]["total_bytes"]
    assert all(event["phase"] != "downloaded" and event["progress"] != 100 for event in events)


def test_recreated_progress_bars_initial_and_negative_deltas_do_not_double_count(isolated_hub, monkeypatch):
    hub = _HubBoundary(isolated_hub)
    _snapshot(isolated_hub, REPOS["medium"], files={k: v for k, v in FILES.items() if k != "model.bin"})

    def retrying_download(destination, tqdm_class, boundary):
        first = tqdm_class(total=10, initial=0, disable=True)
        first.update(4)
        second = tqdm_class(total=10, initial=4, disable=True)
        first.update(2)  # A superseded bar must not overwrite the current file's counter.
        second.update(3)
        second.update(-5)
        second.update(8)
        first.close()
        second.close()
        destination.write_bytes(boundary.files["model.bin"])

    hub.runners["model.bin"] = retrying_download
    hub.install(monkeypatch)
    events = []
    model_files.prepare_model_files("medium", events.append)
    completed = sum(len(data) for name, data in FILES.items() if name != "model.bin")
    current = [event["downloaded_bytes"] - completed for event in events if event["filename"] == "model.bin"]
    assert current == [0, 0, 4, 4, 7, 2, 10]
    assert all(event["downloaded_bytes"] <= sum(map(len, FILES.values())) for event in events if event["downloaded_bytes"] is not None)
    assert events[-1]["progress"] == 100


def test_failure_close_is_not_completion_and_next_attempt_uses_only_final_cache(isolated_hub, monkeypatch):
    hub = _HubBoundary(isolated_hub)
    repo_path = isolated_hub / ("models--" + REPOS["small"].replace("/", "--"))
    _snapshot(isolated_hub, REPOS["small"], files={"config.json": FILES["config.json"]})
    (repo_path / "blobs").mkdir()
    old_incomplete = repo_path / "blobs" / "old.incomplete"
    old_incomplete.write_bytes(b"x" * 1000)
    original_open = Path.open
    original_stat = Path.stat

    def guarded_open(path, *args, **kwargs):
        if path.suffix == ".incomplete":
            raise AssertionError("model preparation must not read historical incomplete files")
        return original_open(path, *args, **kwargs)

    def guarded_stat(path, *args, **kwargs):
        if path.suffix == ".incomplete":
            raise AssertionError("model preparation must not count historical incomplete files")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded_open)
    monkeypatch.setattr(Path, "stat", guarded_stat)

    def fail_after_bytes(_destination, tqdm_class, _boundary):
        with tqdm_class(total=10, initial=0, disable=True) as bar:
            bar.update(7)
            raise OSError("fixture transfer failed")

    hub.runners["model.bin"] = fail_after_bytes
    hub.install(monkeypatch)
    first_events = []
    with pytest.raises(OSError, match="fixture transfer failed"):
        model_files.prepare_model_files("small", first_events.append)
    assert all(event["phase"] != "downloaded" and event["progress"] != 100 for event in first_events)

    hub.runners.clear()
    second_events = []
    model_files.prepare_model_files("small", second_events.append)
    first = next(event for event in second_events if event["phase"] == "downloading")
    completed_final = len(FILES["config.json"]) + len(FILES["preprocessor_config.json"])
    assert first["downloaded_bytes"] == completed_final
    with original_open(old_incomplete, "rb") as file:
        assert file.read() == b"x" * 1000
    assert second_events[-1]["progress"] == 100


class _ScriptedStream(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    def __iter__(self):
        for chunk in self.chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


@pytest.mark.parametrize("ignore_range", [False, True])
def test_hub_118_http_retry_contract_and_disabled_terminal_callbacks(isolated_hub, monkeypatch, ignore_range):
    import huggingface_hub
    from huggingface_hub import file_download

    assert huggingface_hub.__version__ == "1.18.0"
    hub = _HubBoundary(isolated_hub)
    _snapshot(isolated_hub, REPOS["small"], files={k: v for k, v in FILES.items() if k != "model.bin"})
    headers_seen = []
    streams = [
        (200, {"Content-Length": "10"}, [b"0123", httpx.ReadTimeout("fixture interrupted")]),
        (200 if ignore_range else 206,
         {"Content-Length": "10"} if ignore_range else {"Content-Length": "6", "Content-Range": "bytes 4-9/10"},
         [b"0123456789"] if ignore_range else [b"456789"]),
    ]

    @contextlib.contextmanager
    def stream_backoff(*_args, **kwargs):
        headers_seen.append(kwargs["headers"])
        status, headers, chunks = streams.pop(0)
        response = httpx.Response(status, headers=headers, stream=_ScriptedStream(chunks), request=httpx.Request("GET", "https://fixture.invalid/model.bin"))
        try:
            yield response
        finally:
            response.close()

    monkeypatch.setattr(file_download, "http_stream_backoff", stream_backoff)
    monkeypatch.setattr(file_download.constants, "DOWNLOAD_CHUNK_SIZE", 4)
    monkeypatch.setattr(file_download.time, "sleep", lambda _seconds: None)
    tqdm_module = importlib.import_module("huggingface_hub.utils.tqdm")
    monkeypatch.setattr(tqdm_module, "HF_HUB_DISABLE_PROGRESS_BARS", True)

    def http_download(destination, tqdm_class, _boundary):
        with destination.open("wb") as temp_file:
            file_download.http_get("https://fixture.invalid/model.bin", temp_file, expected_size=10, tqdm_class=tqdm_class)

    hub.runners["model.bin"] = http_download
    hub.install(monkeypatch)
    events = []
    model_files.prepare_model_files("small", events.append)
    completed = sum(len(data) for name, data in FILES.items() if name != "model.bin")
    current = [event["downloaded_bytes"] - completed for event in events if event["filename"] == "model.bin"]
    expected = [0, 0, 4, 0, 4, 8, 10] if ignore_range else [0, 0, 4, 8, 10]
    assert current == expected
    assert headers_seen == [{}, {"Range": "bytes=4-"}]
    assert not streams
    assert events[-1]["progress"] == 100


@pytest.mark.parametrize("disable_terminal", [False, True])
def test_hub_118_xet_reports_byte_deltas_including_rollbacks(isolated_hub, monkeypatch, disable_terminal):
    import huggingface_hub
    from huggingface_hub import file_download

    assert huggingface_hub.__version__ == "1.18.0"
    hub = _HubBoundary(isolated_hub)
    _snapshot(isolated_hub, REPOS["medium"], files={k: v for k, v in FILES.items() if k != "model.bin"})
    connection = types.SimpleNamespace(endpoint="https://fixture.invalid", access_token="fixture-token", expiration_unix_epoch=12345)
    monkeypatch.setattr(file_download, "refresh_xet_connection_info", lambda **_kwargs: connection)
    fake_xet = types.ModuleType("hf_xet")
    fake_xet.PyXetDownloadInfo = lambda destination_path, **kwargs: types.SimpleNamespace(destination_path=destination_path, **kwargs)
    seen_deltas = []

    def download_files(download_info, **kwargs):
        for delta in (4.0, 3.0, -2.0, 5.0):
            seen_deltas.append(delta)
            kwargs["progress_updater"][0](delta)
        Path(download_info[0].destination_path).write_bytes(FILES["model.bin"])

    fake_xet.download_files = download_files
    monkeypatch.setitem(sys.modules, "hf_xet", fake_xet)
    tqdm_module = importlib.import_module("huggingface_hub.utils.tqdm")
    monkeypatch.setattr(tqdm_module, "HF_HUB_DISABLE_PROGRESS_BARS", disable_terminal)

    def xet_download(destination, tqdm_class, _boundary):
        file_download.xet_get(
            incomplete_path=destination,
            xet_file_data=types.SimpleNamespace(file_hash="fixture-hash"),
            headers={},
            expected_size=10,
            tqdm_class=tqdm_class,
        )

    hub.runners["model.bin"] = xet_download
    hub.install(monkeypatch)
    events = []
    model_files.prepare_model_files("medium", events.append)
    completed = sum(len(data) for name, data in FILES.items() if name != "model.bin")
    current = [event["downloaded_bytes"] - completed for event in events if event["filename"] == "model.bin"]
    assert seen_deltas == [4.0, 3.0, -2.0, 5.0]
    assert current == [0, 0, 4, 7, 5, 10]
    assert events[-1]["progress"] == 100


def test_hf_home_overrides_default_cache(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_HUB_CACHE")
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf-home"))
    directory = _snapshot(tmp_path / "hf-home" / "hub", REPOS["tiny"])
    assert model_files.prepare_model_files("tiny") == directory
