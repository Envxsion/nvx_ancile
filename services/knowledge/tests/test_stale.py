from datetime import UTC, datetime, timedelta

from ancile_knowledge.sources.stale import Observed, Stored, due_for_check, evaluate

NOW = datetime(2026, 10, 7, tzinfo=UTC)


def stored(**kw):
    base = {
        "kind": "url",
        "fetched_at": NOW - timedelta(days=8),
        "stale_after": None,
        "etag": None,
        "last_modified": None,
        "content_hash": None,
    }
    base.update(kw)
    return Stored(**base)


def test_due_by_kind_interval():
    assert due_for_check(stored(), NOW)
    assert not due_for_check(stored(fetched_at=NOW - timedelta(days=1)), NOW)
    assert not due_for_check(stored(kind="file"), NOW)
    assert due_for_check(stored(fetched_at=None), NOW)


def test_explicit_stale_after_wins():
    assert not due_for_check(stored(stale_after=NOW + timedelta(hours=1)), NOW)
    assert due_for_check(stored(kind="file", stale_after=NOW - timedelta(seconds=1)), NOW)


def test_304_is_fresh_and_gone_is_gone():
    assert evaluate(stored(etag='"a"'), Observed(304)).verdict == "fresh"
    assert evaluate(stored(), Observed(410)).verdict == "gone"
    assert evaluate(stored(), Observed(500)).verdict == "unknown"


def test_etag_including_weak():
    assert evaluate(stored(etag='W/"a"'), Observed(200, etag='"a"')).verdict == "fresh"
    d = evaluate(stored(etag='"a"'), Observed(200, etag='"b"'))
    assert d.verdict == "stale" and d.suggest_refetch


def test_hash_then_last_modified_then_unknown():
    assert evaluate(stored(content_hash="h1"), Observed(200, content_hash="h2")).verdict == "stale"
    assert evaluate(stored(content_hash="h1"), Observed(200, content_hash="h1")).verdict == "fresh"
    assert evaluate(stored(last_modified="Mon"), Observed(200, last_modified="Tue")).verdict == "stale"
    assert evaluate(stored(), Observed(200)).verdict == "unknown"
