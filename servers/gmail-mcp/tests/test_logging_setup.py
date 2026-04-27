"""Tests for the structured stderr logging shim."""

import io
import json
import sys

from gmail_mcp.logging_setup import log, sanitize


def test_sanitize_redacts_secret_keys():
    out = sanitize({"token": "abc", "refresh_token": "xyz", "name": "ok"})
    assert out["token"] == "<redacted>"
    assert out["refresh_token"] == "<redacted>"
    assert out["name"] == "ok"


def test_sanitize_redacts_secrets_nested():
    out = sanitize({"creds": {"access_token": "secret", "scope": "gmail"}})
    assert out["creds"]["access_token"] == "<redacted>"
    assert out["creds"]["scope"] == "gmail"


def test_sanitize_replaces_bulk_content_with_length():
    body = "x" * 5000
    out = sanitize({"body_text": body, "html_body": body, "snippet": body})
    assert out["body_text"] == "<5000 chars>"
    assert out["html_body"] == "<5000 chars>"
    assert out["snippet"] == "<5000 chars>"


def test_sanitize_summarizes_long_lists():
    out = sanitize({"email_ids": list(range(50))})
    assert out["email_ids"] == "<50 items>"


def test_sanitize_keeps_short_lists():
    out = sanitize({"email_ids": ["a", "b", "c"]})
    assert out["email_ids"] == ["a", "b", "c"]


def test_sanitize_truncates_long_strings():
    val = "y" * 500
    out = sanitize({"query": val})
    assert out["query"].startswith("y" * 200)
    assert "...<+300 chars>" in out["query"]


def test_log_writes_json_with_required_fields(monkeypatch):
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stderr", captured)

    log("info", "tool_start", tool="list_emails", args={"max_results": 10})

    line = captured.getvalue().strip()
    record = json.loads(line)
    assert record["level"] == "info"
    assert record["event"] == "tool_start"
    assert record["tool"] == "list_emails"
    assert record["args"] == {"max_results": 10}
    assert "ts" in record


def test_log_sanitizes_secrets_in_fields(monkeypatch):
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stderr", captured)

    log("info", "auth_check", creds={"access_token": "supersecret", "expired": False})

    record = json.loads(captured.getvalue().strip())
    assert "supersecret" not in captured.getvalue()
    assert record["creds"]["access_token"] == "<redacted>"
    assert record["creds"]["expired"] is False
