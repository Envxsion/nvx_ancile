"""
------------------------------------------------------------------
 Title    |  Observability: JSON logs and trace context
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Every log line is JSON with service, component, trace_id
          |  and span_id, so one request can be followed across Core,
          |  Knowledge and the Controller (DESIGN.md §11.1).
 How      |  structlog with contextvars. The middleware reads the W3C
          |  traceparent header (or starts a trace), binds it for the
          |  request, and echoes x-trace-id on the response. Outbound
          |  calls use outbound_headers() to propagate it.
 Note     |  TODO(phase-1): wire the OTel SDK exporter when
          |  OTEL_EXPORTER_OTLP_ENDPOINT is set, and batch spans into
          |  core.spans for the in-app views.
------------------------------------------------------------------
"""

from __future__ import annotations

import logging
import re
import secrets
import sys
import time
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

import structlog
from starlette.requests import Request
from starlette.responses import Response

SERVICE = "knowledge"
_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")
_SECRET_KEYS = re.compile(r"(authorization|api[_-]?key|token|secret|password)", re.I)


# Key shapes, for secrets inside free text: messages, exceptions, provider
# errors that echo a key back. Mirrors services/core/src/obs/redact.ts.
_TEXT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}"), "sk-ant-…"),
    (re.compile(r"\bsk-(proj-)?[A-Za-z0-9_-]{16,}"), "sk-…"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}"), "AIza…"),
    (re.compile(r"\brpa_[A-Za-z0-9]{16,}"), "rpa_…"),
    (re.compile(r"\bhf_[A-Za-z0-9]{20,}"), "hf_…"),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), "gh…"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.I), "Bearer …"),
    (re.compile(r"\b(postgres(?:ql)?(?:\+psycopg)?://[^:\s]+:)[^@\s]+@"), r"\1…@"),
]


def redact_text(text: str) -> str:
    for pattern, repl in _TEXT_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def _scrub(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return value
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {
            k: "[redacted]" if isinstance(k, str) and _SECRET_KEYS.search(k) else _scrub(v, depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_scrub(v, depth + 1) for v in value]
    return value


def _redact(_: Any, __: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    for k in list(event):
        if _SECRET_KEYS.search(k):
            event[k] = "[redacted]"
        else:
            event[k] = _scrub(event[k])
    return event


def configure_logging(level: str = "info") -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level.upper())
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", key="ts"),
            structlog.processors.EventRenamer("msg"),
            structlog.processors.format_exc_info,
            # Last before rendering, so exception text is scrubbed too.
            _redact,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level.upper())),
        cache_logger_on_first_use=True,
    )
    structlog.contextvars.bind_contextvars(service=SERVICE)


def get_logger(component: str) -> structlog.stdlib.BoundLogger:
    # Initial values keep the proxy lazy: a module-level logger created at import
    # time still picks up configure_logging() (JSON, level) when it first logs.
    # .bind() here would freeze structlog's default console config instead.
    return structlog.get_logger(component=component)  # type: ignore[no-any-return]


def parse_traceparent(header: str | None) -> tuple[str, str] | None:
    if not header:
        return None
    m = _TRACEPARENT.match(header.strip().lower())
    return (m.group(1), m.group(2)) if m else None


def new_trace_id() -> str:
    return secrets.token_hex(16)


def new_span_id() -> str:
    return secrets.token_hex(8)


def current_trace() -> tuple[str, str]:
    ctx = structlog.contextvars.get_contextvars()
    return ctx.get("trace_id") or new_trace_id(), ctx.get("span_id") or new_span_id()


def outbound_headers() -> dict[str, str]:
    trace_id, _ = current_trace()
    return {"traceparent": f"00-{trace_id}-{new_span_id()}-01"}


async def trace_middleware(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    parsed = parse_traceparent(request.headers.get("traceparent"))
    trace_id = parsed[0] if parsed else new_trace_id()
    span_id = new_span_id()
    structlog.contextvars.bind_contextvars(trace_id=trace_id, span_id=span_id)
    started = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
    finally:
        # One access line per request with the caller's trace id. The
        # supervisor's periodic probes mark themselves as background and stay
        # at debug, so the log is not drowned; a "Check now" stays visible.
        background = request.headers.get("x-ancile-probe") == "background"
        log = structlog.get_logger("http")
        line = {
            "method": request.method,
            "path": request.url.path,
            "status": status,
            "ms": round((time.perf_counter() - started) * 1000),
        }
        if background:
            log.debug("request", **line)
        else:
            log.info("request", **line)
        structlog.contextvars.unbind_contextvars("trace_id", "span_id")
    response.headers["x-trace-id"] = trace_id
    return response
