"""
------------------------------------------------------------------
 Title    |  Stale source detection
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Notice when a URL source has changed upstream and suggest
          |  a refetch, without refetching everything on a timer.
 How      |  Two pure steps:
          |    due_for_check()  has this source's stale_after passed
          |                     (or its kind's default interval)?
          |    evaluate()       given what a conditional HEAD/GET saw,
          |                     is it stale, fresh, or gone?
          |  Strong validators win: ETag, then Last-Modified, then a
          |  content hash of a fresh fetch. A 304 is always fresh.
          |  sweep() is the side-effecting part: a conditional GET for
          |  each due URL source (through fetch.py, so SSRF-guarded and
          |  retried) and sources.stale set when the page changed. It
          |  runs in the worker every KNOWLEDGE_STALE_CHECK_HOURS and on
          |  POST /kn/v1/maintenance/stale-check. Refetch clears it.
------------------------------------------------------------------
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

# Default revalidation interval by kind. Files and pasted text never go stale
# on their own; a thread source is refreshed when the thread changes.
DEFAULT_INTERVAL: dict[str, timedelta | None] = {
    "url": timedelta(days=7),
    "youtube": timedelta(days=30),
    "file": None,
    "folder": timedelta(days=1),
    "text": None,
    "audio": None,
    "thread": None,
}

Verdict = Literal["fresh", "stale", "gone", "unknown"]


@dataclass(frozen=True)
class Stored:
    kind: str
    fetched_at: datetime | None
    stale_after: datetime | None
    etag: str | None
    last_modified: str | None
    content_hash: str | None


@dataclass(frozen=True)
class Observed:
    status: int
    etag: str | None = None
    last_modified: str | None = None
    content_hash: str | None = None  # only when the body was fetched


@dataclass(frozen=True)
class Decision:
    verdict: Verdict
    reason: str
    suggest_refetch: bool


def due_for_check(s: Stored, now: datetime) -> bool:
    if s.stale_after is not None:
        return now >= s.stale_after
    interval = DEFAULT_INTERVAL.get(s.kind)
    if interval is None:
        return False
    if s.fetched_at is None:
        return True
    return now - s.fetched_at >= interval


def _weak(tag: str) -> str:
    return tag[2:] if tag.startswith("W/") else tag


def evaluate(s: Stored, o: Observed) -> Decision:
    if o.status == 304:
        return Decision("fresh", "The server confirmed the page has not changed.", False)
    if o.status in (404, 410):
        return Decision(
            "gone", f"The page now returns {o.status}. Keep the saved copy or remove the source.", False
        )
    if o.status >= 400:
        return Decision("unknown", f"The check failed with {o.status}; will try again next cycle.", False)
    if s.etag and o.etag:
        if _weak(s.etag) == _weak(o.etag):
            return Decision("fresh", "ETag unchanged.", False)
        return Decision("stale", "The page's ETag changed since it was fetched.", True)
    if s.content_hash and o.content_hash:
        if s.content_hash == o.content_hash:
            return Decision("fresh", "Content unchanged.", False)
        return Decision("stale", "The page's content changed since it was fetched.", True)
    if s.last_modified and o.last_modified:
        if s.last_modified == o.last_modified:
            return Decision("fresh", "Last-Modified unchanged.", False)
        return Decision("stale", "The page reports a newer modification date.", True)
    return Decision("unknown", "The server gives no validators; fetch the content to compare.", False)


# --- the sweep (database + network) ---------------------------------------------------


async def sweep(
    *, force: bool = False, source_ids: list[str] | None = None, limit: int = 200
) -> dict[str, Any]:
    """Re-validate due URL sources. Returns counts by verdict."""
    from sqlalchemy import text

    from ..db import sessions
    from ..errors import AncileError
    from ..ingest import fetch
    from ..ingest.extract import html_to_markdown
    from ..settings import get_settings
    from .dedupe import content_hash

    settings = get_settings()
    now = datetime.now(UTC)
    params: dict[str, Any] = {"n": limit}
    where = "kind = 'url' AND deleted_at IS NULL AND status = 'ready' AND current_version > 0"
    if source_ids is not None:
        where += " AND id = ANY(:ids)"
        params["ids"] = source_ids
    with sessions().begin() as db:
        rows = (
            db.execute(
                text(
                    "SELECT id, uri, kind, fetched_at, stale_after, etag, last_modified, content_hash "
                    f"FROM knowledge.sources WHERE {where} ORDER BY stale_checked_at NULLS FIRST LIMIT :n"
                ),
                params,
            )
            .mappings()
            .all()
        )
    counts = {"checked": 0, "stale": 0, "fresh": 0, "gone": 0, "unknown": 0}
    for r in rows:
        stored = Stored(
            r["kind"], r["fetched_at"], r["stale_after"], r["etag"], r["last_modified"], r["content_hash"]
        )
        if not force and not due_for_check(stored, now):
            continue
        counts["checked"] += 1
        try:
            res = await fetch.fetch_url(
                r["uri"],
                allow_private=settings.allow_private_urls,
                max_bytes=settings.max_fetch_mb * 1024 * 1024,
                etag=r["etag"],
                last_modified=r["last_modified"],
            )
            digest = None
            if res.status == 200 and not (r["etag"] and res.etag) and res.body:
                ctype = (res.content_type or "").split(";")[0].strip().lower()
                # Hash the same text extraction produced, so unchanged pages compare equal.
                if ctype in ("text/html", "application/xhtml+xml"):
                    digest = content_hash(html_to_markdown(res.body, res.url)[0])
                elif ctype.startswith("text/"):
                    body = res.body.decode("utf-8", errors="replace")
                    digest = content_hash(body.replace("\r\n", "\n").strip())
            observed = Observed(res.status, res.etag, res.last_modified, digest)
        except AncileError as exc:
            status = (
                404 if "HTTP 404" in (exc.detail or "") else 410 if "HTTP 410" in (exc.detail or "") else 599
            )
            observed = Observed(status)
        decision = evaluate(stored, observed)
        counts[decision.verdict] += 1
        interval = DEFAULT_INTERVAL.get("url") or timedelta(days=7)
        with sessions().begin() as db:
            db.execute(
                text(
                    "UPDATE knowledge.sources SET stale_checked_at = now(), stale_after = :next, "
                    "stale = CASE WHEN :stale THEN true ELSE stale END WHERE id = :id"
                ),
                {"id": r["id"], "next": now + interval, "stale": decision.suggest_refetch},
            )
    return counts
