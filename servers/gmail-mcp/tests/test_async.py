"""Tests for the async wrapper around blocking google-api calls."""

import asyncio
import io
import json
import sys
import time

import pytest

from gmail_mcp import _async


@pytest.mark.asyncio
async def test_run_blocking_returns_value():
    result = await _async.run_blocking(lambda: 42, op="unit.echo")
    assert result == 42


@pytest.mark.asyncio
async def test_run_blocking_propagates_exception():
    class Boom(RuntimeError):
        pass

    def boom():
        raise Boom("nope")

    with pytest.raises(Boom):
        await _async.run_blocking(boom, op="unit.boom")


@pytest.mark.asyncio
async def test_run_blocking_times_out(monkeypatch):
    """A call that exceeds timeout raises asyncio.TimeoutError and logs api_timeout."""
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stderr", captured)

    def slow():
        time.sleep(0.5)
        return "late"

    with pytest.raises(asyncio.TimeoutError):
        await _async.run_blocking(slow, op="unit.slow", timeout=0.05)

    events = [json.loads(line) for line in captured.getvalue().splitlines() if line.strip()]
    timeout_events = [e for e in events if e["event"] == "api_timeout"]
    assert len(timeout_events) == 1
    assert timeout_events[0]["op"] == "unit.slow"
    assert timeout_events[0]["timeout_s"] == 0.05


@pytest.mark.asyncio
async def test_run_blocking_does_not_block_event_loop():
    """While a blocking call sleeps in a worker thread, the event loop must stay responsive."""
    counter = {"n": 0}

    async def ticker():
        for _ in range(20):
            await asyncio.sleep(0.005)
            counter["n"] += 1

    def blocking():
        time.sleep(0.2)
        return "done"

    ticker_task = asyncio.create_task(ticker())
    result = await _async.run_blocking(blocking, op="unit.block", timeout=5.0)
    await ticker_task

    assert result == "done"
    # The event loop processed the ticker concurrently while the worker thread slept.
    # If run_blocking had blocked the loop we'd see ~0 ticks; we expect ~20.
    assert counter["n"] >= 10


@pytest.mark.asyncio
async def test_slow_call_warning_emitted(monkeypatch):
    """slow_call warning fires at the configured threshold while a call is in flight."""
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stderr", captured)
    monkeypatch.setattr(_async, "SLOW_CALL_THRESHOLDS_S", (0.05,))

    def slow():
        time.sleep(0.15)
        return "ok"

    result = await _async.run_blocking(slow, op="unit.slowwarn", timeout=2.0)
    assert result == "ok"

    events = [json.loads(line) for line in captured.getvalue().splitlines() if line.strip()]
    slow_events = [e for e in events if e["event"] == "slow_call"]
    assert len(slow_events) == 1
    assert slow_events[0]["op"] == "unit.slowwarn"
    assert slow_events[0]["threshold_s"] == 0.05


@pytest.mark.asyncio
async def test_logs_api_call_and_done_on_success(monkeypatch):
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stderr", captured)

    await _async.run_blocking(
        lambda: {"messages": [{"id": "a"}, {"id": "b"}, {"id": "c"}]},
        op="messages.list",
    )

    events = [json.loads(line) for line in captured.getvalue().splitlines() if line.strip()]
    kinds = [e["event"] for e in events]
    assert "api_call" in kinds
    assert "api_done" in kinds
    done = next(e for e in events if e["event"] == "api_done")
    assert done["op"] == "messages.list"
    assert done["result_size"] == 3
