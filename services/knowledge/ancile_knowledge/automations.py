"""
------------------------------------------------------------------
 Title    |  Built-in automations: their switches and options
 Ref      |  packages/contracts/src/ops.ts (KnowledgeAutomations,
          |  DEFAULT_KNOWLEDGE_AUTOMATIONS) · alembic 0005
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  The jobs that run inside this service read their switch
          |  and options here:
          |    auto_tag_sources   tags picked on ingest (pipeline,
          |                       enriching), at most max_tags
          |    duplicate_sources  duplicate suggestions on ingest
          |                       (pipeline, extracting), near-copies
          |                       from near_duplicate_percent
          |    stale_sources      the worker's background stale-URL
          |                       sweep, and url_stale_after_days as
          |                       the URL revalidation interval
 How      |  Core owns the settings (core.automations, Admin →
          |  Automations) and sends the whole set with
          |    PUT /kn/v1/maintenance/automations
          |  at start and after every change; GET reads it back. PUT
          |  validates strictly (the contract's bounds, no unknown
          |  keys, a 400 request.invalid otherwise), stores the set in
          |  knowledge.automation_settings (one row) and replaces the
          |  copy in memory. Before Core has sent anything, DEFAULTS
          |  apply: what the service did before these settings existed.
          |  current() is what the jobs call: the copy in memory,
          |  reloaded from the database after CACHE_TTL_S so a second
          |  process converges; if a reload fails, the last copy stays.
 Note     |  POST /maintenance/stale-check is not switched: it is an
          |  explicit request (Core's schedule, or Run now).
------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Annotated, Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, ValidationError
from sqlalchemy import text

from .db import sessions
from .errors import AncileError
from .obs import get_logger

log = get_logger("automations")

S = "knowledge"
CACHE_TTL_S = 30.0


def _whole_number(v: object) -> object:
    """zod's z.number().int(): a JSON number with no fraction; never a string or a boolean."""
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise ValueError("must be a whole number")
    if isinstance(v, float):
        if not v.is_integer():
            raise ValueError("must be a whole number")
        return int(v)
    return v


class _Options(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AutoTagSources(_Options):
    enabled: StrictBool
    max_tags: Annotated[int, Field(ge=1, le=20), BeforeValidator(_whole_number)]


class DuplicateSources(_Options):
    enabled: StrictBool
    near_duplicate_percent: Annotated[int, Field(ge=50, le=100), BeforeValidator(_whole_number)]

    @property
    def near_threshold(self) -> float:
        return self.near_duplicate_percent / 100


class StaleSources(_Options):
    enabled: StrictBool
    url_stale_after_days: Annotated[int, Field(ge=1, le=365), BeforeValidator(_whole_number)]


class KnowledgeAutomations(_Options):
    auto_tag_sources: AutoTagSources
    duplicate_sources: DuplicateSources
    stale_sources: StaleSources


DEFAULTS = KnowledgeAutomations(
    auto_tag_sources=AutoTagSources(enabled=True, max_tags=5),
    duplicate_sources=DuplicateSources(enabled=True, near_duplicate_percent=90),
    stale_sources=StaleSources(enabled=True, url_stale_after_days=7),
)


# --- reading and storing ----------------------------------------------------------------

_lock = threading.Lock()
_cached: tuple[float, KnowledgeAutomations] | None = None
_generation = 0  # bumped by store() and forget(), so a reload that raced one is not cached


def from_stored(raw: object) -> KnowledgeAutomations:
    """
    The stored set, each automation filled in from DEFAULTS where the row
    lacks an option (a set stored before that option existed) and replaced
    by its default if what is stored no longer validates. None: DEFAULTS.
    """
    if not isinstance(raw, dict):
        return DEFAULTS
    out: dict[str, Any] = {}
    for name in KnowledgeAutomations.model_fields:
        default = getattr(DEFAULTS, name)
        stored = raw.get(name)
        merged = default.model_dump()
        if isinstance(stored, dict):
            merged.update({k: v for k, v in stored.items() if k in merged})
        try:
            out[name] = type(default).model_validate(merged)
        except ValidationError:
            log.warning("stored automation settings invalid; using the default", automation=name)
            out[name] = default
    return KnowledgeAutomations(**out)


def load() -> KnowledgeAutomations:
    """The stored set from the database (DEFAULTS when Core has sent none)."""
    with sessions().begin() as db:
        raw = db.execute(text(f"SELECT settings FROM {S}.automation_settings WHERE id = 1")).scalar()
    return from_stored(raw)


def current() -> KnowledgeAutomations:
    """The settings the jobs act on now."""
    global _cached
    with _lock:
        if _cached is not None and time.monotonic() - _cached[0] < CACHE_TTL_S:
            return _cached[1]
        previous = _cached[1] if _cached is not None else None
        generation = _generation
    try:
        value = load()
    except Exception as exc:
        if previous is None:
            raise
        log.warning("automation settings not reloaded; keeping the last ones", error=type(exc).__name__)
        value = previous
    with _lock:
        if generation == _generation:
            _cached = (time.monotonic(), value)
        elif _cached is not None:
            return _cached[1]  # store() ran meanwhile: its set is newer than what was read
    return value


def store(new: KnowledgeAutomations) -> KnowledgeAutomations:
    """Persist the whole set, apply what changed, and make it current. Returns what is stored."""
    global _cached, _generation
    from .sources import stale

    with sessions().begin() as db:
        # One writer at a time, including the very first (no row to lock yet).
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext('knowledge.automation_settings'))"))
        old = from_stored(
            db.execute(text(f"SELECT settings FROM {S}.automation_settings WHERE id = 1")).scalar()
        )
        db.execute(
            text(
                f"INSERT INTO {S}.automation_settings (id, settings, updated_at) "
                f"VALUES (1, CAST(:s AS jsonb), now()) "
                f"ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()"
            ),
            {"s": json.dumps(new.model_dump())},
        )
        days = new.stale_sources.url_stale_after_days
        moved = 0
        if days != old.stale_sources.url_stale_after_days:
            moved = stale.rebase_url_checks(db, days)
    with _lock:
        _generation += 1
        _cached = (time.monotonic(), new)
    log.info(
        "automation settings stored",
        auto_tags=new.auto_tag_sources.enabled,
        max_tags=new.auto_tag_sources.max_tags,
        duplicates=new.duplicate_sources.enabled,
        near_duplicate_percent=new.duplicate_sources.near_duplicate_percent,
        stale=new.stale_sources.enabled,
        url_stale_after_days=days,
        rescheduled=moved,
    )
    return new


def forget() -> None:
    """Drop the copy in memory; the next current() reads the database (tests, a restart)."""
    global _cached, _generation
    with _lock:
        _cached = None
        _generation += 1


# --- /kn/v1/maintenance/automations -------------------------------------------------------


def parse(data: object) -> KnowledgeAutomations:
    """A whole KnowledgeAutomations set, exactly as the contract has it, or a 400 request.invalid."""
    try:
        return KnowledgeAutomations.model_validate(data)
    except ValidationError as exc:
        errors = [{"loc": ["body", *e["loc"]], "msg": e["msg"]} for e in exc.errors()]
        raise _invalid(errors) from None


def _invalid(errors: list[dict[str, Any]]) -> AncileError:
    fields = ", ".join(dict.fromkeys(".".join(str(p) for p in e["loc"][1:]) or "body" for e in errors))
    return AncileError(
        "request.invalid",
        "The automation settings were not in the expected shape",
        f"Send all three automations with every option, in range. Check these fields: {fields}.",
        status=400,
        error_class="permanent",
        context={"errors": errors},
    )


router = APIRouter()


@router.get("/maintenance/automations")
async def get_automations() -> dict[str, Any]:
    """The set in force: the last one Core sent, or the defaults before it sent any."""
    return (await asyncio.to_thread(current)).model_dump()


@router.put("/maintenance/automations")
async def put_automations(request: Request) -> dict[str, Any]:
    """Replace the whole set (Core, at start and after every change). Returns what is stored."""
    raw = await request.body()
    try:
        data: object = json.loads(raw)
    except ValueError:  # not JSON, or not UTF-8
        raise _invalid([{"loc": ["body"], "msg": "The body is not valid JSON"}]) from None
    new = parse(data)
    return (await asyncio.to_thread(store, new)).model_dump()
