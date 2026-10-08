"""
------------------------------------------------------------------
 Title    |  NVX Ancile knowledge service
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  FastAPI app: health, readiness, self-test and /kn/v1.
          |  The lifespan runs the ingestion worker in-process
          |  (jobs.py) unless KNOWLEDGE_WORKER=false.
 How      |  `uv run ancile-knowledge` or
          |  `uv run uvicorn ancile_knowledge.main:app --port 7710`.
          |  Settings are validated before the app is built, so a bad
          |  .env stops boot with a readable message, not a traceback.
------------------------------------------------------------------
"""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.requests import Request

from . import __version__, jobs
from .errors import AncileError, ancile_error_handler
from .health import router as health_router
from .obs import configure_logging, current_trace, trace_middleware
from .routes import router as kn_router
from .settings import SettingsError, get_settings


async def _validation_handler(_: Request, exc: Exception) -> JSONResponse:
    trace_id, _span = current_trace()
    details = exc.errors() if isinstance(exc, RequestValidationError) else []
    fields = ", ".join(".".join(str(p) for p in e["loc"][1:]) or "body" for e in details) or "request"
    err = AncileError(
        "request.invalid",
        "The request was not in the expected shape",
        f"Check these fields: {fields}.",
        status=422,
        error_class="permanent",
        context={"errors": [{"loc": e["loc"], "msg": e["msg"]} for e in details]},
    )
    return JSONResponse(err.to_body(trace_id), status_code=422)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    if get_settings().worker_enabled:
        jobs.start_worker()
    try:
        yield
    finally:
        jobs.stop_worker()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    app = FastAPI(
        title="NVX Ancile · Knowledge",
        version=__version__,
        docs_url="/kn/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.middleware("http")(trace_middleware)
    app.add_exception_handler(AncileError, ancile_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(Exception, ancile_error_handler)
    app.include_router(health_router)
    app.include_router(kn_router)
    return app


def _build() -> FastAPI:
    try:
        return create_app()
    except SettingsError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None


app = _build()


def run() -> None:
    import uvicorn

    uvicorn.run("ancile_knowledge.main:app", host="0.0.0.0", port=get_settings().port, log_config=None)
