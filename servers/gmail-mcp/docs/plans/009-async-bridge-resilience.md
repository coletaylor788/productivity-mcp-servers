# Plan 009 — Async Bridge Resilience + Diagnostic Logging

**Status:** Implemented 2026-04-27 (pending deploy)
**Server:** `servers/gmail-mcp`
**Related incidents:** Two silent gateway wedges on Mac mini (Apr 26 evening, Apr 27 morning), both triggered by `list_emails` from Daily Email Triage cron. See `docs/plans/016-openclaw-mac-mini-setup.md` §6.1.4.

## Problem

`gmail_mcp` calls Google's `googleapiclient` synchronously inside `async def` handlers:

```python
async def _list_emails(...) -> ...:
    service = get_gmail_service()
    results = service.users().messages().list(**kwargs).execute()  # BLOCKING
```

Three compounding problems:

1. **Blocking call inside event loop** — when `.execute()` runs, the asyncio event loop is frozen. The MCP stdio reader can't read the next JSON-RPC request, the writer can't flush responses, signals are deferred. The bridge appears wedged from the gateway's perspective.
2. **No socket timeout** — `httplib2` (transport under `googleapiclient`) defaults to **no timeout**. A hung Google API call blocks forever.
3. **No per-call timeout in our code** — even with sync→thread offload, a stuck thread never resolves.

Result: rare-but-real Google API hangs (network blip, OAuth refresh edge case, throttling) silently freeze the bridge. The OpenClaw secure-gmail wrap waits forever for a response, no audit row is written, the gateway accepts subsequent requests but can't dispatch through the dead bridge.

**Compounding observability gap:** zero logging in `server.py`. When it hangs we can't tell whether it was DNS, OAuth, the actual API call, response parsing, etc.

## Goals

1. Bridge **never silently wedges** on a hung Google API call.
2. When something goes wrong, **logs identify exactly which phase failed** and how long it took.
3. No behavior change for happy path.

## Approach

### 1. Async-safe blocking offload

Wrap every `.execute()` call site in `asyncio.to_thread(...)` so the event loop stays responsive. Define one helper to keep call sites tidy:

```python
async def _run_blocking(call, *, timeout: float = 60.0, op: str = ""):
    """Run a blocking google-api call in a thread with a timeout + slow-call warning."""
    start = time.monotonic()
    task = asyncio.create_task(asyncio.to_thread(call))
    try:
        return await asyncio.wait_for(_with_slow_warnings(task, op, start), timeout=timeout)
    except asyncio.TimeoutError:
        elapsed = time.monotonic() - start
        log.error("api_timeout", op=op, elapsed_ms=int(elapsed * 1000), timeout_s=timeout)
        raise
```

Call sites:
```python
results = await _run_blocking(
    lambda: service.users().messages().list(**kwargs).execute(),
    op="messages.list",
    timeout=60,
)
```

### 2. Socket-level timeout in `auth.py`

```python
import httplib2
from google_auth_httplib2 import AuthorizedHttp

def _build_service(creds):
    http = AuthorizedHttp(creds, http=httplib2.Http(timeout=30))
    return build("gmail", "v1", http=http, cache_discovery=False)
```

Update all four `build(...)` call sites in `auth.py` to use `_build_service`. Don't pass `credentials=` when using `AuthorizedHttp`.

### 3. Structured stderr logging

Stderr from MCP bridges is captured by OpenClaw into bridge logs (verify path during implementation). Add a tiny logging shim:

```python
# logging_setup.py
import json, sys, time
def log(level: str, event: str, **fields):
    record = {"ts": time.time(), "level": level, "event": event, **fields}
    print(json.dumps(record), file=sys.stderr, flush=True)
```

Per-tool telemetry (every tool handler):
- `tool_start` — `tool=<name> args=<sanitized>` (sanitize: drop body content, log lengths)
- `auth_check` — `has_creds=bool expired=bool expires_in_s=int`
- `auth_refresh` — `ok=bool ms=int err=...` (only when refresh actually runs)
- `api_call` — `op=<method> params=<sanitized>` (right before `.execute()`)
- `api_done` — `op=<method> ms=int result_size=int`
- `slow_call` — `op=<method> ms=int phase=in_flight` (emitted at 10s and 30s while a call is still running)
- `api_timeout` — `op=<method> elapsed_ms=int timeout_s=int`
- `api_error` — `op=<method> ms=int exc_type=... msg=...`
- `tool_done` — `tool=<name> ms=int ok=bool`

Sanitization rules: never log email body content, attachment bytes, OAuth tokens, or contact PII beyond what's needed (sender address is OK, body snippet is OK if already in the result, full body is not).

### 4. Slow-call warning task

Background task spawned alongside the wrapped `.execute()`:
```python
async def _with_slow_warnings(task, op, start):
    for threshold in (10, 30):
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=threshold - (time.monotonic() - start))
        except asyncio.TimeoutError:
            log("warn", "slow_call", op=op, elapsed_ms=int((time.monotonic() - start) * 1000))
    return await task
```

(Final implementation may differ slightly — the goal is "log at 10s and 30s thresholds without canceling the call".)

## Out of scope

- Retries on transient Google API errors (separate concern; current behavior bubbles errors to OpenClaw which handles its own retry).
- Rewriting bridge to fully async with `aiohttp` + Google's `aiogoogle` (too big; `to_thread` solves the wedge problem with minimal churn).
- Filing OpenClaw issues for secure-gmail per-call timeouts (separate, tracked in plan 016 §6.1.4 follow-ups).
- Watchdog from plan 016 §6.1.4 — still useful as defense-in-depth but no longer urgent.

## Testing

Unit tests in `tests/`:
- `test_run_blocking_returns_value` — happy path
- `test_run_blocking_propagates_exception` — Google API exception bubbles
- `test_run_blocking_times_out` — fake call that sleeps > timeout raises `TimeoutError`
- `test_run_blocking_does_not_block_event_loop` — assert event loop processes other tasks while a blocking call is pending
- `test_slow_call_logs_at_thresholds` — capture stderr, assert `slow_call` events at 10s + 30s
- `test_log_sanitizes_secrets` — token values + body content not in log output

Existing tool tests should continue to pass with no modification (the wrapper is transparent).

Run `pytest tests/` and `ruff check src/ tests/` per repo conventions.

## Deployment

After merge to `main`:
1. SSH to mini, `cd /Users/puddles/git/puddles/servers/gmail-mcp`, `git pull`, `.venv/bin/pip install -e .` (httplib2 already transitively installed via `google-auth-httplib2`).
2. `launchctl kickstart -k gui/$(id -u puddles)/ai.openclaw.gateway` to restart gateway (which respawns the bridge).
3. Trigger Daily Email Triage cron manually, verify it completes and an audit row appears in `~/.openclaw/logs/secure-gmail-audit.jsonl`.
4. Monitor `gateway.err.log` for `slow_call` warnings over the next few days — these tell us whether real-world Google API latency is anywhere near our 60s threshold.

---

## Checklist

### Implementation
- [x] Add `logging_setup.py` with `log()` shim
- [x] Add `_run_blocking()` + `_with_slow_warnings()` helpers (location: new `_async.py` or top of `server.py`)
- [x] Wrap every `.execute()` call in `server.py` (5 tools: `list_emails`, `get_email`, `get_attachments`, `archive_email`, `add_label`, plus `labels().list()` lookup)
- [x] Refactor `auth.py` `build()` calls (4 sites) to use `AuthorizedHttp` with 30s socket timeout
- [x] Add tool entry/exit + auth + api logging in `server.py`
- [ ] Verify stderr output is captured by OpenClaw bridge logger (check `~/.openclaw/logs/` after deploy)

### Testing
- [x] Unit tests for `_run_blocking` (4 tests above)
- [x] Unit test for slow-call logging
- [x] Unit test for log sanitization
- [x] Existing tool tests still pass
- [x] `ruff check src/ tests/` clean

### Cleanup
- [x] No unused imports
- [x] No dead code
- [x] Comments on the helpers explaining the "why" (event loop wedge prevention)

### Documentation
- [x] Update `servers/gmail-mcp/README.md` with logging notes (where to find logs, what `slow_call` means)
- [x] Update `docs/plans/016-openclaw-mac-mini-setup.md` §6.1.4 — note that gmail-mcp wedge root cause is fixed; watchdog is now defense-in-depth
- [x] Mark this plan complete with date

### Commit & push
- [ ] One commit covering server changes + tests + README
- [ ] Separate commit for plan 016 §6.1.4 update
- [ ] Push to remote

### Deploy (separate phase, post-merge)
- [ ] Pull + reinstall on mini
- [ ] Kickstart gateway
- [ ] Smoke test via manual cron trigger
- [ ] Watch logs for 24-48h
