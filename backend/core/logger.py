"""Centralized logging configuration.

Log files are written to <project_root>/log/ with daily rotation.
- interview.log  — transcription, answer, pipeline events
- error.log      — ERROR+ from all modules
- app.log        — general application log (INFO+)

Every formatter installed here is wrapped so the complete formatted output
(including tracebacks and stack info) is redacted before it reaches a sink.

Usage in any module:
    from core.logger import get_logger
    logger = get_logger(__name__)
"""

import copy
import logging
import os
import sys
import types
from logging.handlers import TimedRotatingFileHandler

import uvicorn.config
import uvicorn.logging

from core.redact import redact_text

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)
LOG_DIR = os.path.join(_PROJECT_ROOT, "log")

_LOG_FORMAT = "%(asctime)s | %(levelname)-5s | %(name)s | %(message)s"
_LOG_DATE_FMT = "%Y-%m-%d %H:%M:%S"
_REDACTION_FAILURE = "[log redaction failed]"

_initialized = False


class RedactingFormatter(logging.Formatter):
    """Wrap another formatter and redact its complete output.

    Formatting happens on a copy of the record so the original record, its
    arguments and any business objects stay untouched. The copy's exception
    text cache is cleared first so tracebacks are rendered, then redacted.
    """

    def __init__(self, formatter: logging.Formatter):
        super().__init__()
        self.formatter = formatter

    def format(self, record: logging.LogRecord) -> str:
        record_copy = copy.copy(record)
        record_copy.exc_text = None
        try:
            return redact_text(self.formatter.format(record_copy))
        except Exception:
            return _REDACTION_FAILURE


def _report_failure(handler: logging.Handler, record: logging.LogRecord) -> None:
    """Emit fixed text instead of the stdlib record/argument dump on failure."""
    for stream in (getattr(handler, "stream", None), sys.stderr):
        if stream is None:
            continue
        try:
            stream.write(_REDACTION_FAILURE + "\n")
            stream.flush()
            return
        except Exception:
            continue


class RedactingStreamHandler(logging.StreamHandler):
    """StreamHandler whose error reporting never prints the raw record."""

    def handleError(self, record: logging.LogRecord) -> None:
        _report_failure(self, record)


def _redacting_default_formatter(**kwargs) -> RedactingFormatter:
    return RedactingFormatter(uvicorn.logging.DefaultFormatter(**kwargs))


def _redacting_access_formatter(**kwargs) -> RedactingFormatter:
    return RedactingFormatter(uvicorn.logging.AccessFormatter(**kwargs))


def uvicorn_log_config() -> dict:
    """Uvicorn's default logging config with redacting formatters and handlers."""
    config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    config["formatters"]["default"]["()"] = _redacting_default_formatter
    config["formatters"]["access"]["()"] = _redacting_access_formatter
    for name in ("default", "access"):
        handler = config["handlers"][name]
        handler.pop("class", None)
        # dictConfig 只在 3.12+ 接受 "class" 为类对象；"()" 工厂从 3.2 起可用。
        handler["()"] = RedactingStreamHandler
    return config


def _wrap_handler(handler: logging.Handler) -> None:
    if not isinstance(handler.formatter, RedactingFormatter):
        handler.setFormatter(RedactingFormatter(handler.formatter or logging.Formatter()))
    handler.handleError = types.MethodType(_report_failure, handler)


def _wrap_handler_formatters() -> None:
    """Wrap handlers Uvicorn created before setup_logging ran (CLI mode)."""
    for name in ("", "interview", "uvicorn", "uvicorn.error", "uvicorn.access"):
        for handler in logging.getLogger(name).handlers:
            _wrap_handler(handler)


def _ensure_log_dir():
    os.makedirs(LOG_DIR, exist_ok=True)


def _make_file_handler(
    filename: str,
    level: int = logging.DEBUG,
    when: str = "midnight",
    backup_count: int = 30,
) -> TimedRotatingFileHandler:
    path = os.path.join(LOG_DIR, filename)
    handler = TimedRotatingFileHandler(
        path, when=when, backupCount=backup_count, encoding="utf-8"
    )
    handler.setLevel(level)
    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATE_FMT)
    handler.setFormatter(RedactingFormatter(formatter))
    handler.suffix = "%Y-%m-%d"
    return handler


def setup_logging():
    """Call once at application startup (idempotent)."""
    global _initialized
    if _initialized:
        _wrap_handler_formatters()
        return
    _initialized = True

    _ensure_log_dir()

    root = logging.getLogger()
    root.setLevel(logging.DEBUG)

    # --- interview.log: transcription / answer / pipeline ---
    interview_handler = _make_file_handler("interview.log", logging.DEBUG)
    logging.getLogger("interview").addHandler(interview_handler)
    logging.getLogger("interview").setLevel(logging.DEBUG)
    logging.getLogger("interview").propagate = False

    # --- error.log: ERROR+ from all modules ---
    error_handler = _make_file_handler("error.log", logging.ERROR)
    root.addHandler(error_handler)

    # --- app.log: general INFO+ ---
    app_handler = _make_file_handler("app.log", logging.INFO)
    root.addHandler(app_handler)

    # --- console: keep existing uvicorn style, WARNING+ for our code ---
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers if not isinstance(h, TimedRotatingFileHandler)):
        console = logging.StreamHandler(sys.stderr)
        console.setLevel(logging.WARNING)
        formatter = logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATE_FMT)
        console.setFormatter(RedactingFormatter(formatter))
        root.addHandler(console)

    _wrap_handler_formatters()


def get_logger(name: str) -> logging.Logger:
    """Return a module-level logger. Call setup_logging() once before using."""
    return logging.getLogger(name)


def get_interview_logger() -> logging.Logger:
    """Dedicated logger for interview events (transcription, answer, pipeline)."""
    return logging.getLogger("interview")
