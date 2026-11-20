from __future__ import annotations

import copy
import io
import logging
import logging.config
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import logger as app_logger
from core.redact import redact_text

# Synthetic values generated for this suite; none correspond to real credentials.
BEARER = "test-2454ad61c2acc04f"
BASIC = "test-fbb7b5bf4ca348ee"
API_KEY = "test-6c793695171e793d"
ACCESS_KEY = "test-7ad702bdafa630cc"
QUERY_TOKEN = "test-c3b5ad4e8deb948c"
URL_TOKEN = "test-3b281e0e1bff9765"
JSON_KEY = "test-abb50aebb4823721"
REPR_KEY = "test-719fb0973fa5696b"
KV = "test-379f1b10a1c75084"
POSTGRES = "test-a942b37ccfaf5a81"
ARGUMENT = "test-b74f83c9353b55cd"
STACK = "test-6ee08e6eb3bc6f45"
EXCEPTION = "test-2104e56ef446302c"
HANDLER = "test-3128389bb1c21baf"
FAILED = "test-5d28a90f4498a814"
ACCESS_QUERY = "test-e8f0e9ed3f23360a"


@pytest.fixture
def isolated_logging(monkeypatch, tmp_path):
    """Route all log files into tmp_path and restore logger state afterwards."""
    managed = [logging.getLogger(), logging.getLogger("interview"), logging.getLogger("uvicorn"), logging.getLogger("uvicorn.error"), logging.getLogger("uvicorn.access")]
    saved = [
        (logger, list(logger.handlers), logger.level, list(logger.filters), logger.propagate, logger.disabled)
        for logger in managed
    ]
    handler_state = {
        id(handler): (handler, handler.formatter, handler.handleError)
        for _, handlers, *_ in saved
        for handler in handlers
    }

    monkeypatch.setattr(app_logger, "LOG_DIR", str(tmp_path))
    monkeypatch.setattr(app_logger, "_initialized", False)
    logging.getLogger().handlers = [logging.NullHandler()]
    for logger in managed[1:]:
        logger.handlers = []
        logger.filters = []

    yield tmp_path

    for logger, handlers, level, filters, propagate, disabled in saved:
        for handler in list(logger.handlers):
            if handler not in handlers:
                handler.close()
        logger.handlers = handlers
        logger.setLevel(level)
        logger.filters = filters
        logger.propagate = propagate
        logger.disabled = disabled
    for handler, formatter, handle_error in handler_state.values():
        handler.formatter = formatter
        handler.handleError = handle_error


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (f"Authorization: Bearer {BEARER}", "Authorization: Bearer ***"),
        (f"authorization='Basic {BASIC}'", "authorization='Basic ***'"),
        (f"X-Api-Key: {API_KEY}", "X-Api-Key: ***"),
        (f"X-Api-Access-Key={ACCESS_KEY}", "X-Api-Access-Key=***"),
        (f"GET /path?token={QUERY_TOKEN} HTTP/1.1", "GET /path?token=*** HTTP/1.1"),
        (f"/path?access_token={URL_TOKEN}", "/path?access_token=***"),
        (f"/path?api_key={API_KEY}&x=1", "/path?api_key=***&x=1"),
        (f'{{"api_key": "{JSON_KEY}"}}', '{"api_key": "***"}'),
        (f'{{"api_key": "{JSON_KEY}", "x": 1}}', '{"api_key": "***", "x": 1}'),
        (f"{{'password': '{REPR_KEY}'}}", "{'password': '***'}"),
        (f"api_key={KV} user=sample", "api_key=*** user=sample"),
        (f"token: {URL_TOKEN}", "token: ***"),
        (
            f"postgres://test-user:{POSTGRES}@db.local:5432/app",
            "postgres://***@db.local:5432/app",
        ),
        ("max_tokens=1000 processed 3 tokens", "max_tokens=1000 processed 3 tokens"),
        ("max_tokens=4096 top_k=5", "max_tokens=4096 top_k=5"),
        ("tokens=3", "tokens=3"),
    ],
)
def test_redact_text_masks_supported_credentials(text, expected):
    assert redact_text(text) == expected
    assert redact_text(redact_text(text)) == expected


def test_wrapped_access_formatter_keeps_request_line_behavior():
    uvicorn_logging = pytest.importorskip("uvicorn.logging")
    formatter = app_logger.RedactingFormatter(
        uvicorn_logging.AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s')
    )
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1", "GET", f"/health?token={ACCESS_QUERY}", "1.1", 200),
        None,
    )

    assert formatter.format(record) == '127.0.0.1 - "GET /health?token=*** HTTP/1.1" 200 OK'
    assert record.args[2] == f"/health?token={ACCESS_QUERY}"


def test_original_record_and_arguments_are_not_mutated():
    record = logging.LogRecord(
        "test", logging.ERROR, __file__, 1, "token=%s", (ARGUMENT,), None
    )
    record.stack_info = f"GET /path?api_key={STACK}"
    snapshot = copy.deepcopy(record.__dict__)

    output = app_logger.RedactingFormatter(
        logging.Formatter("%(levelname)s %(message)s")
    ).format(record)

    assert ARGUMENT not in output and STACK not in output
    assert record.__dict__ == snapshot


def test_uvicorn_log_config_wraps_factories_and_survives_dict_config(isolated_logging):
    uvicorn = pytest.importorskip("uvicorn")
    first = app_logger.uvicorn_log_config()
    second = app_logger.uvicorn_log_config()

    assert first is not second
    first["handlers"]["default"]["stream"] = "ext://sys.stdout"
    assert second["handlers"]["default"]["stream"] == "ext://sys.stderr"

    default_logger = logging.getLogger("uvicorn")
    access_logger = logging.getLogger("uvicorn.access")
    logging.config.dictConfig(second)

    default_handler = default_logger.handlers[0]
    access_handler = access_logger.handlers[0]
    assert isinstance(default_handler, app_logger.RedactingStreamHandler)
    assert isinstance(default_handler.formatter, app_logger.RedactingFormatter)
    assert isinstance(default_handler.formatter.formatter, uvicorn.logging.DefaultFormatter)
    assert isinstance(access_handler, app_logger.RedactingStreamHandler)
    assert isinstance(access_handler.formatter.formatter, uvicorn.logging.AccessFormatter)


def test_uvicorn_log_config_survives_python311_dict_config(monkeypatch, isolated_logging):
    """Python 3.11 resolves handler "class" via str.split(); class objects need 3.12+."""
    original = logging.config.DictConfigurator.configure_handler

    def python311_configure_handler(self, config):
        cname = config.get("class")
        if cname is not None and not isinstance(cname, str):
            raise AttributeError(f"type object {cname!r} has no attribute 'split'")
        return original(self, config)

    monkeypatch.setattr(
        logging.config.DictConfigurator, "configure_handler", python311_configure_handler
    )
    logging.config.dictConfig(app_logger.uvicorn_log_config())

    assert isinstance(
        logging.getLogger("uvicorn.access").handlers[0], app_logger.RedactingStreamHandler
    )


def test_uvicorn_log_config_redacts_real_stdout_and_stderr(monkeypatch, isolated_logging):
    stdout, stderr = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    default_logger = logging.getLogger("uvicorn")
    access_logger = logging.getLogger("uvicorn.access")
    logging.config.dictConfig(app_logger.uvicorn_log_config())
    access_logger.info(
        '%s - "%s %s HTTP/%s" %d',
        "127.0.0.1",
        "GET",
        f"/api/x?token={ACCESS_QUERY}",
        "1.1",
        200,
    )
    default_logger.warning(f"upstream Authorization: Bearer {BEARER}")
    default_logger.warning('127.0.0.1:1 - "WebSocket /ws?token=%s" [accepted]', ACCESS_QUERY)

    assert ACCESS_QUERY not in stdout.getvalue() + stderr.getvalue()
    assert BEARER not in stdout.getvalue() + stderr.getvalue()
    assert 'GET /api/x?token=*** HTTP/1.1' in stdout.getvalue()
    assert "Authorization: Bearer ***" in stderr.getvalue()


def test_multiple_handlers_render_same_redacted_exception():
    plain = logging.Formatter("%(levelname)s %(message)s")
    first, second = app_logger.RedactingFormatter(plain), app_logger.RedactingFormatter(plain)
    try:
        raise RuntimeError(f"Authorization: Bearer {EXCEPTION}")
    except RuntimeError:
        record = logging.LogRecord("test", logging.ERROR, __file__, 1, "token=%s", (ARGUMENT,), sys.exc_info())

    first_output = first.format(record)
    second_output = second.format(record)

    assert first_output == second_output
    assert ARGUMENT not in first_output and EXCEPTION not in first_output
    assert "Traceback (most recent call last)" in first_output
    assert record.exc_text is None


def test_setup_logging_wraps_cli_created_uvicorn_handlers_and_keeps_filters(isolated_logging):
    uvicorn = pytest.importorskip("uvicorn")
    access = logging.getLogger("uvicorn.access")
    handler = app_logger.RedactingStreamHandler(io.StringIO())
    handler.setFormatter(uvicorn.logging.AccessFormatter("%(message)s"))
    sentinel_filter = logging.Filter("uvicorn.access")
    access.addFilter(sentinel_filter)
    access.addHandler(handler)

    app_logger.setup_logging()

    assert handler.formatter.formatter.__class__ is uvicorn.logging.AccessFormatter
    assert handler.filters == []
    assert access.filters == [sentinel_filter]

    access.info(
        '%s - "%s %s HTTP/%s" %d',
        "127.0.0.1",
        "GET",
        f"/log?token={ACCESS_QUERY}",
        "1.1",
        200,
    )
    assert ACCESS_QUERY not in handler.stream.getvalue()
    assert "token=***" in handler.stream.getvalue()


def test_setup_logging_wraps_a_second_time_without_double_wrapping(isolated_logging):
    app_logger.setup_logging()
    access = logging.getLogger("uvicorn.access")
    handler = logging.StreamHandler(io.StringIO())
    access.addHandler(handler)
    app_logger.setup_logging()
    wrapped = handler.formatter

    app_logger.setup_logging()

    assert handler.formatter is wrapped
    assert isinstance(wrapped, app_logger.RedactingFormatter)


def test_application_file_and_console_outputs_are_redacted(isolated_logging, monkeypatch):
    console = io.StringIO()
    monkeypatch.setattr(sys, "stderr", console)
    # pytest's log-capture handler is itself a StreamHandler and is attached
    # after fixture setup; drop it so setup_logging takes the same
    # console-handler path as a real process.
    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not isinstance(h, logging.StreamHandler)]
    app_logger.setup_logging()
    logging.getLogger("redaction.output.test").error(f"Authorization: Bearer {HANDLER}")
    logging.getLogger("interview").info(f"api_key={KV}")
    logging.getLogger("interview").error(f"X-Api-Key: {API_KEY}")

    interviews = [h for h in logging.getLogger("interview").handlers if isinstance(h, logging.FileHandler)]
    root_files = [h for h in logging.getLogger().handlers if isinstance(h, logging.FileHandler)]
    for handler in interviews + root_files:
        handler.flush()

    assert all("Authorization: Bearer ***" in _read(h.baseFilename) for h in root_files)
    interview_output = _read(interviews[0].baseFilename)
    assert f"api_key={KV}" not in interview_output
    assert API_KEY not in interview_output
    assert "api_key=***" in interview_output
    assert HANDLER not in console.getvalue()
    assert "Authorization: Bearer ***" in console.getvalue()


def test_long_records_are_fully_redacted():
    long_line = "A" * 100_000 + f" Authorization: Bearer {FAILED} " + "B" * 100_000
    output = app_logger.RedactingFormatter(logging.Formatter("%(message)s")).format(
        logging.LogRecord("test", logging.INFO, __file__, 1, long_line, (), None)
    )

    assert FAILED not in output
    assert len(output) < len(long_line)


@pytest.mark.parametrize("failure", ["format", "write"])
def test_logging_failures_never_reach_output_with_secret(capsys, failure):
    class BrokenFormatter(logging.Formatter):
        def format(self, record):
            raise RuntimeError("format failed")

    class FailingStream:
        def write(self, value):
            raise OSError("sink unavailable")

        def flush(self):
            raise OSError("sink unavailable")

    stream = FailingStream() if failure == "write" else io.StringIO()
    handler = app_logger.RedactingStreamHandler(stream)
    inner = BrokenFormatter() if failure == "format" else logging.Formatter("%(message)s")
    handler.setFormatter(app_logger.RedactingFormatter(inner))
    log = logging.getLogger("redaction.failure.test")
    log.propagate = False
    log.handlers = [handler]
    try:
        log.error("Authorization: Bearer %s", FAILED)
    finally:
        log.handlers = []
        log.propagate = True
        handler.close()

    captured = capsys.readouterr()
    assert FAILED not in captured.out + captured.err
    assert "[log redaction failed]" in captured.err + getattr(stream, "getvalue", lambda: "")()
    if isinstance(stream, io.StringIO):
        assert FAILED not in stream.getvalue()
