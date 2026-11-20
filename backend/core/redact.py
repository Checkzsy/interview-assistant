"""Redact labeled credentials from fully formatted log output."""

import re

_CREDENTIAL_KEY = (
    r"(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|"
    r"api[_-]?key|apikey|password|secret|token)"
)
_BACKSLASH = re.escape("\\")
_PATTERNS = (
    (r"\b([a-z][a-z0-9+.-]*://)[^\s/@?#]+@", r"\1***@"),
    (r"\b(authorization[\"']?\s*[:=]\s*[\"']?\s*(?:bearer|basic)\s+)[^\s\"',;}\]&]+", r"\1***"),
    (r"\b(x-api(?:-access)?-key[\"']?\s*[:=]\s*[\"']?)[^\s\"',;}\]&]+", r"\1***"),
    (r"([?&](?:access_token|refresh_token|api_key|apikey|token)=)[^&\s\"'#<>]+", r"\1***"),
    (
        r"(?<![\w-])(" + _CREDENTIAL_KEY + r")(" + _BACKSLASH + r"?[\"']?\s*[:=]\s*)"
        r"(" + _BACKSLASH + r"?[\"'])((?:" + _BACKSLASH + r".|(?!\3).)*?)\3",
        r"\1\2\3***\3",
    ),
    (r"(?<![\w-])(" + _CREDENTIAL_KEY + r")([\"']?\s*[:=]\s*)[^\s\"',;}\]&]+", r"\1\2***"),
)
_REDACTION_PATTERNS = tuple(
    (re.compile(pattern, re.IGNORECASE), replacement) for pattern, replacement in _PATTERNS
)


def redact_text(value: str) -> str:
    """Mask known credential fields; arbitrary unlabeled strings are unchanged."""
    for pattern, replacement in _REDACTION_PATTERNS:
        value = pattern.sub(replacement, value)
    return value
