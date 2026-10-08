import pytest

from ancile_knowledge.errors import AncileError
from ancile_knowledge.resilience import (
    CircuitBreaker,
    RetryableError,
    RetryPolicy,
    backoff_ms,
    classify_status,
    retry,
)


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_full_jitter_bounds():
    p = RetryPolicy(base_ms=100, factor=2, cap_ms=500)
    assert backoff_ms(1, p, lambda: 1.0) == 100
    assert backoff_ms(3, p, lambda: 1.0) == 400
    assert backoff_ms(10, p, lambda: 1.0) == 500
    assert backoff_ms(2, p, lambda: 0.0) == 0


async def test_retries_transient_then_succeeds():
    calls: list[int] = []
    sleeps: list[float] = []

    async def fn():
        calls.append(1)
        if len(calls) < 3:
            raise RetryableError("boom")
        return "ok"

    async def sleep(s):
        sleeps.append(s)

    assert await retry(fn, target="t", sleep=sleep, rand=lambda: 0.5) == "ok"
    assert len(calls) == 3 and len(sleeps) == 2


async def test_honours_retry_after_and_stops_on_permanent():
    sleeps: list[float] = []
    n = {"i": 0}

    async def sleep(s):
        sleeps.append(s)

    async def fn():
        n["i"] += 1
        if n["i"] == 1:
            raise RetryableError("slow down", "capacity", retry_after_s=7)
        raise RetryableError("bad key", "permanent")

    with pytest.raises(AncileError) as exc:
        await retry(fn, target="t", sleep=sleep)
    assert sleeps == [7]
    assert [a["class"] for a in exc.value.attempts] == ["capacity", "permanent"]
    assert exc.value.error_class == "permanent"


async def test_deadline_stops_retrying():
    clock = Clock()

    async def fn():
        raise RetryableError("x", retry_after_s=5)

    async def sleep(s):
        clock.t += s

    with pytest.raises(AncileError) as exc:
        await retry(fn, target="t", clock=clock, sleep=sleep, deadline=3)
    assert len(exc.value.attempts) == 1
    assert "deadline" in str(exc.value.attempts[0]["note"])


def test_breaker_opens_half_opens_and_doubles():
    clock = Clock()
    b = CircuitBreaker("t", consecutive=3, half_open_s=30, clock=clock)
    for _ in range(3):
        assert b.allow()
        b.record(False)
    assert b.state == "open" and not b.allow()
    clock.t = 30
    assert b.allow() and b.state == "half_open"
    assert not b.allow(), "one probe at a time"
    b.record(False)
    assert b.state == "open"
    clock.t = 30 + 59
    assert not b.allow(), "cooldown doubled to 60s"
    clock.t = 30 + 60
    assert b.allow()
    b.record(True)
    assert b.state == "closed"


def test_breaker_failure_rate_window():
    clock = Clock()
    b = CircuitBreaker("t", min_calls=4, failure_rate=0.5, consecutive=100, clock=clock)
    for ok in (True, False, True, False):
        b.record(ok)
    assert b.state == "open"


def test_breaker_window_forgets_old_failures():
    clock = Clock()
    b = CircuitBreaker("t", min_calls=4, failure_rate=0.5, consecutive=100, window_s=60, clock=clock)
    b.record(False)
    b.record(False)
    clock.t = 120
    b.record(True)
    b.record(True)
    assert b.state == "closed"


def test_classify_status():
    assert classify_status(503) == "capacity"
    assert classify_status(429) == "capacity"
    assert classify_status(500) == "transient"
    assert classify_status(401) == "permanent"
    assert classify_status(402) == "policy"
