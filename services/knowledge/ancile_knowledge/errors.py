"""
------------------------------------------------------------------
 Title    |  Errors
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  The one error shape (DESIGN.md §11.3), mirrored from
          |  packages/contracts/src/errors.ts. Never a stack trace on
          |  the wire: stacks go to the log under the same trace id.
------------------------------------------------------------------
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import Request
from fastapi.responses import JSONResponse

from .obs import current_trace, get_logger

ErrorClass = Literal["transient", "capacity", "refusal", "context_overflow", "policy", "permanent", "bug"]

log = get_logger("errors")


class AncileError(Exception):
    def __init__(
        self,
        code: str,
        title: str,
        hint: str,
        *,
        status: int = 500,
        retryable: bool = False,
        error_class: ErrorClass = "bug",
        detail: str | None = None,
        attempts: list[dict[str, Any]] | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(title)
        self.code = code
        self.title = title
        self.hint = hint
        self.status = status
        self.retryable = retryable
        self.error_class = error_class
        self.detail = detail
        self.attempts = attempts or []
        self.context = context or {}

    def to_body(self, trace_id: str) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "title": self.title,
                "detail": self.detail,
                "hint": self.hint,
                "retryable": self.retryable,
                "trace_id": trace_id,
                "attempts": self.attempts,
                "context": {"service": "knowledge", **self.context},
            }
        }


async def ancile_error_handler(_: Request, exc: Exception) -> JSONResponse:
    trace_id, _span = current_trace()
    if isinstance(exc, AncileError):
        log.warning("request failed", code=exc.code, detail=exc.detail)
        return JSONResponse(exc.to_body(trace_id), status_code=exc.status)
    log.exception("unhandled error")
    err = AncileError(
        "knowledge.internal",
        "The knowledge service hit an unexpected error",
        "Retry. If it keeps happening, open Admin → Logs and filter by this trace id.",
    )
    return JSONResponse(err.to_body(trace_id), status_code=500)
