"""Structured stderr logging for the Gmail MCP bridge.

Emits one JSON object per line on stderr. OpenClaw's bridge runner
captures stderr into its bridge log, giving us a per-call diagnostic
trail (tool entry/exit, auth state, API call timings, slow warnings,
timeouts, errors).

Sanitization keeps secrets and message bodies out of the log:
- Token/credential values are never logged.
- Email body content (text/html) is replaced with a length marker.
- Long opaque strings are truncated.
- List arguments are summarized as counts.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any

# Keys that must never appear in log output, regardless of nesting depth.
_SECRET_KEYS = {
    "token",
    "access_token",
    "refresh_token",
    "client_secret",
    "authorization",
    "data",  # base64 attachment payload from Gmail API
}

# Keys whose values are bulky email content; replace with a length marker.
_BULK_KEYS = {
    "body_text",
    "body_html",
    "text_body",
    "html_body",
    "snippet",
    "content",
    "attachment_data",
}

_MAX_STR_LEN = 200


def sanitize(value: Any) -> Any:
    """Return a log-safe copy of value, scrubbing secrets and bulk content."""
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for k, v in value.items():
            key_l = str(k).lower()
            if key_l in _SECRET_KEYS:
                result[k] = "<redacted>"
            elif key_l in _BULK_KEYS:
                if isinstance(v, str):
                    result[k] = f"<{len(v)} chars>"
                else:
                    result[k] = "<redacted>"
            else:
                result[k] = sanitize(v)
        return result
    if isinstance(value, list):
        if len(value) > 10:
            return f"<{len(value)} items>"
        return [sanitize(v) for v in value]
    if isinstance(value, str) and len(value) > _MAX_STR_LEN:
        return value[:_MAX_STR_LEN] + f"...<+{len(value) - _MAX_STR_LEN} chars>"
    return value


def log(level: str, event: str, **fields: Any) -> None:
    """Emit a single JSON log record to stderr.

    Args:
        level: One of "debug", "info", "warn", "error".
        event: Short event name (e.g. "tool_start", "api_call", "slow_call").
        **fields: Arbitrary structured data (sanitized before serialization).
    """
    record = {
        "ts": round(time.time(), 3),
        "level": level,
        "event": event,
    }
    for k, v in fields.items():
        record[k] = sanitize(v)
    try:
        sys.stderr.write(json.dumps(record, default=str) + "\n")
        sys.stderr.flush()
    except Exception:
        # Never let logging crash the bridge.
        pass
