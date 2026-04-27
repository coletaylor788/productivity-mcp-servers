"""Async-safe wrapper around blocking google-api-python-client calls.

The Gmail API client (`googleapiclient`) is synchronous and uses
`httplib2` underneath. Calling `.execute()` directly inside an
`async def` handler blocks the asyncio event loop, which means the
MCP stdio reader/writer freezes for the duration of the HTTP call.
A single hung Google API request can therefore wedge the entire bridge.

`run_blocking()` solves this in three layers:

1. The blocking call is offloaded to a worker thread via
   `asyncio.to_thread`, so the event loop keeps servicing stdio while
   the HTTP call is in flight.
2. `asyncio.wait_for(timeout=...)` enforces a hard ceiling per call.
   When it fires we log `api_timeout` and raise; the caller turns it
   into a normal error response so the gateway is never left hanging.
3. A background warner emits `slow_call` log records at 10s and 30s so
   real-world latency is observable before it ever hits the timeout.

Defense in depth: the Gmail service object should also be built with a
socket-level timeout on httplib2 (see `auth._build_service`), so the
underlying thread itself won't hang forever even if our asyncio timeout
is bypassed.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, TypeVar

from .logging_setup import log

T = TypeVar("T")

# Timeout defaults
DEFAULT_TIMEOUT_S = 60.0
SLOW_CALL_THRESHOLDS_S = (10.0, 30.0)


async def _emit_slow_warnings(op: str, start: float) -> None:
    """Emit slow_call log events at each threshold while the call is running."""
    last = 0.0
    for threshold in SLOW_CALL_THRESHOLDS_S:
        sleep_for = threshold - last
        if sleep_for > 0:
            await asyncio.sleep(sleep_for)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        log("warn", "slow_call", op=op, elapsed_ms=elapsed_ms, threshold_s=threshold)
        last = threshold


async def run_blocking(
    call: Callable[[], T],
    *,
    op: str,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> T:
    """Run a blocking callable in a worker thread with a timeout + slow warnings.

    Args:
        call: Zero-arg callable performing the blocking work
            (typically a lambda wrapping `service.x.y().execute()`).
        op: Short operation name for log records (e.g. "messages.list").
        timeout: Hard timeout in seconds. Raises asyncio.TimeoutError on hit.

    Returns:
        Whatever the callable returns.

    Raises:
        asyncio.TimeoutError: If the call exceeds `timeout`. Note that the
            underlying thread cannot be cancelled — it will continue until
            the socket-level timeout in httplib2 fires.
        Exception: Any exception raised by `call`, propagated unchanged.
    """
    start = time.monotonic()
    log("info", "api_call", op=op)

    work = asyncio.create_task(asyncio.to_thread(call))
    warner = asyncio.create_task(_emit_slow_warnings(op, start))

    try:
        result = await asyncio.wait_for(asyncio.shield(work), timeout=timeout)
    except asyncio.TimeoutError:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        log(
            "error",
            "api_timeout",
            op=op,
            elapsed_ms=elapsed_ms,
            timeout_s=timeout,
        )
        raise
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        log(
            "error",
            "api_error",
            op=op,
            elapsed_ms=elapsed_ms,
            exc_type=type(exc).__name__,
            msg=str(exc),
        )
        raise
    finally:
        warner.cancel()
        # Swallow the cancellation so it doesn't surface as an unhandled
        # exception from the background task.
        try:
            await warner
        except (asyncio.CancelledError, Exception):
            pass

    elapsed_ms = int((time.monotonic() - start) * 1000)
    size = _result_size(result)
    log("info", "api_done", op=op, elapsed_ms=elapsed_ms, result_size=size)
    return result


def _result_size(result: Any) -> int | None:
    """Best-effort size hint for log records (not a strict measurement)."""
    if result is None:
        return 0
    if isinstance(result, dict):
        # Gmail list responses put items under "messages" / "labels".
        for k in ("messages", "labels", "threads", "drafts"):
            v = result.get(k)
            if isinstance(v, list):
                return len(v)
        return len(result)
    if isinstance(result, (list, tuple, str, bytes)):
        return len(result)
    return None
