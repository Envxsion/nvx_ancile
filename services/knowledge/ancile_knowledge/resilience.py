"""
------------------------------------------------------------------
 Title    |  Resilience primitives (Python mirror)
 Ref      |  packages/resilience (TS), DESIGN.md §7.1
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  The only sanctioned way for Knowledge to call anything
          |  external: retry with backoff and full jitter, honouring
          |  Retry-After and a deadline; a circuit breaker per target.
 How      |  Same defaults and semantics as @nvx/resilience so both
          |  services behave identically under failure. Clock and
          |  sleep are injectable so tests run instantly.
 Note     |  TODO(phase-5): share breaker state through Postgres so
          |  Core and Knowledge agree on an open circuit.
------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import random
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, TypeVar

from .errors import AncileError, ErrorClass

T = TypeVar("T")

RETRYABLE: frozenset[ErrorClass] = frozenset({"transient", "capacity"})


@dataclass(frozen=True)
class RetryPolicy:
    base_ms: float = 250
    factor: float = 2.0
    cap_ms: float = 8000
    max_attempts: int = 4


def backoff_ms(attempt: int, policy: RetryPolicy, rand: Callable[[], float] = random.random) -> float:
    """Full jitter: uniform in [0, min(cap, base * factor^(attempt-1))]. attempt is 1-based."""
    ceiling = min(policy.cap_ms, policy.base_ms * policy.factor ** (attempt - 1))
    return rand() * ceiling


class RetryableError(Exception):
    def __init__(
        self, message: str, error_class: ErrorClass = "transient", retry_after_s: float | None = None
    ):
        super().__init__(message)
        self.error_class = error_class
        self.retry_after_s = retry_after_s


def classify_status(status: int) -> ErrorClass:
    if status == 429 or status >= 500:
        return "capacity" if status in (429, 503) else "transient"
    if status in (401, 403, 400, 404, 422):
        return "permanent"
    if status == 402:
        return "policy"
    return "permanent"


async def retry(
    fn: Callable[[], Awaitable[T]],
    *,
    target: str,
    policy: RetryPolicy | None = None,
    deadline: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    rand: Callable[[], float] = random.random,
) -> T:
    policy = policy or RetryPolicy()
    attempts: list[dict[str, object]] = []
    for attempt in range(1, policy.max_attempts + 1):
        started = clock()
        try:
            return await fn()
        except RetryableError as exc:
            attempts.append({"target": target, "class": exc.error_class, "ms": (clock() - started) * 1000})
            if exc.error_class not in RETRYABLE or attempt == policy.max_attempts:
                break
            wait_s = (
                exc.retry_after_s
                if exc.retry_after_s is not None
                else backoff_ms(attempt, policy, rand) / 1000
            )
            if deadline is not None and clock() + wait_s >= deadline:
                attempts[-1]["note"] = "deadline would pass before the next attempt"
                break
            await sleep(wait_s)
    last = attempts[-1] if attempts else {}
    raise AncileError(
        "dependency.unavailable",
        f"{target} did not respond successfully",
        "Ancile retried and gave up. Check Admin → Health for this service.",
        status=503,
        retryable=True,
        error_class=last.get("class", "transient"),  # type: ignore[arg-type]
        attempts=attempts,
    )


State = Literal["closed", "open", "half_open"]


@dataclass
class CircuitBreaker:
    target: str
    window_s: float = 60
    failure_rate: float = 0.5
    min_calls: int = 8
    consecutive: int = 5
    half_open_s: float = 30
    max_half_open_s: float = 600
    clock: Callable[[], float] = time.monotonic
    state: State = "closed"
    _events: deque[tuple[float, bool]] = field(default_factory=deque)
    _consecutive_failures: int = 0
    _opened_at: float = 0.0
    _cooldown: float = 0.0
    _probe_in_flight: bool = False

    def _prune(self, now: float) -> None:
        while self._events and now - self._events[0][0] > self.window_s:
            self._events.popleft()

    def allow(self) -> bool:
        now = self.clock()
        if self.state == "open":
            if now - self._opened_at >= self._cooldown:
                self.state = "half_open"
                self._probe_in_flight = False
            else:
                return False
        if self.state == "half_open":
            if self._probe_in_flight:
                return False
            self._probe_in_flight = True
        return True

    def record(self, ok: bool) -> None:
        now = self.clock()
        if self.state == "half_open":
            self._probe_in_flight = False
            if ok:
                self.state = "closed"
                self._events.clear()
                self._consecutive_failures = 0
                self._cooldown = 0
            else:
                self._open(now, double=True)
            return
        self._events.append((now, ok))
        self._prune(now)
        self._consecutive_failures = 0 if ok else self._consecutive_failures + 1
        failures = sum(1 for _, good in self._events if not good)
        rate_trip = len(self._events) >= self.min_calls and failures / len(self._events) >= self.failure_rate
        if self._consecutive_failures >= self.consecutive or rate_trip:
            self._open(now, double=False)

    def _open(self, now: float, *, double: bool) -> None:
        self.state = "open"
        self._opened_at = now
        self._cooldown = (
            min(self.max_half_open_s, self._cooldown * 2) if double and self._cooldown else self.half_open_s
        )
        self._events.clear()
        self._consecutive_failures = 0
