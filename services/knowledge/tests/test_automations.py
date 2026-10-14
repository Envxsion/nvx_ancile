"""
The built-in automations' switches and options (ancile_knowledge/automations.py):
the contract mirror, strict validation, PUT/GET /kn/v1/maintenance/automations
and persistence, and what each setting does: automatic tags, duplicate
suggestions on ingest, the worker's stale sweep and the URL interval.
"""

from __future__ import annotations

import asyncio
import random
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from ancile_knowledge import automations, jobs
from ancile_knowledge.automations import DEFAULTS, KnowledgeAutomations
from ancile_knowledge.db import sessions
from ancile_knowledge.errors import AncileError
from ancile_knowledge.ingest import fetch
from ancile_knowledge.main import create_app
from ancile_knowledge.sources import dedupe, repo, stale, tags
from tests.conftest import AUTH, add_text_source, drain

CONTRACT = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src" / "ops.ts"
DEFAULT_BODY: dict[str, Any] = {
    "auto_tag_sources": {"enabled": True, "max_tags": 5},
    "duplicate_sources": {"enabled": True, "near_duplicate_percent": 90},
    "stale_sources": {"enabled": True, "url_stale_after_days": 7},
}
ROUTE = "/kn/v1/maintenance/automations"


def body(**changes: dict[str, Any]) -> dict[str, Any]:
    """The default set with some automations' options changed."""
    return {k: {**v, **changes.get(k, {})} for k, v in DEFAULT_BODY.items()}


def settings(**changes: dict[str, Any]) -> KnowledgeAutomations:
    return KnowledgeAutomations.model_validate(body(**changes))


# --- the contract mirror ------------------------------------------------------------------


def test_defaults_are_todays_behaviour() -> None:
    assert DEFAULTS.model_dump() == DEFAULT_BODY
    assert DEFAULTS.auto_tag_sources.max_tags == tags.MAX_TAGS
    assert DEFAULTS.duplicate_sources.near_threshold == dedupe.NEAR_DUPLICATE
    url = stale.DEFAULT_INTERVAL["url"]
    assert url is not None and DEFAULTS.stale_sources.url_stale_after_days == url.days


def test_mirrors_the_contract_defaults_and_bounds() -> None:
    if not CONTRACT.exists():
        pytest.skip("packages/contracts is not next to this service")
    ts = CONTRACT.read_text(encoding="utf-8")
    block = ts[ts.index("export const KnowledgeAutomations") : ts.index("export type KnowledgeAutomations")]
    bounds = {
        (name, opt): (int(lo), int(hi))
        for name, opt, lo, hi in re.findall(
            r"(\w+): z\s*\.object\(\{ enabled: z\.boolean\(\), (\w+): "
            r"z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\) \}\)",
            block,
        )
    }
    schema = KnowledgeAutomations.model_json_schema()
    mine = {}
    for name in DEFAULT_BODY:
        ref = schema["properties"][name]["$ref"].split("/")[-1]
        props = schema["$defs"][ref]["properties"]
        assert set(props) == set(DEFAULT_BODY[name]), name
        opt = next(k for k in props if k != "enabled")
        mine[(name, opt)] = (props[opt]["minimum"], props[opt]["maximum"])
    assert bounds == mine
    defaults = ts[ts.index("export const DEFAULT_KNOWLEDGE_AUTOMATIONS") :].split("};")[0]
    parsed = {
        name: {"enabled": enabled == "true", opt: int(value)}
        for name, enabled, opt, value in re.findall(
            r"(\w+): \{ enabled: (true|false), (\w+): (\d+) \}", defaults
        )
    }
    assert parsed == DEFAULT_BODY


# --- strict validation ----------------------------------------------------------------------


def test_parse_accepts_the_whole_set_and_bounds() -> None:
    assert automations.parse(DEFAULT_BODY) == DEFAULTS
    low = body(
        auto_tag_sources={"max_tags": 1},
        duplicate_sources={"near_duplicate_percent": 50},
        stale_sources={"url_stale_after_days": 1, "enabled": False},
    )
    high = body(
        auto_tag_sources={"max_tags": 20},
        duplicate_sources={"near_duplicate_percent": 100},
        stale_sources={"url_stale_after_days": 365},
    )
    assert automations.parse(low).model_dump() == low
    assert automations.parse(high).model_dump() == high
    # A JSON number with no fraction is a whole number (as zod's .int() reads it).
    assert automations.parse(body(auto_tag_sources={"max_tags": 3.0})).auto_tag_sources.max_tags == 3


@pytest.mark.parametrize(
    ("data", "field"),
    [
        (body(auto_tag_sources={"max_tags": 0}), "auto_tag_sources.max_tags"),
        (body(auto_tag_sources={"max_tags": 21}), "auto_tag_sources.max_tags"),
        (body(duplicate_sources={"near_duplicate_percent": 49}), "duplicate_sources.near_duplicate_percent"),
        (body(duplicate_sources={"near_duplicate_percent": 101}), "duplicate_sources.near_duplicate_percent"),
        (body(stale_sources={"url_stale_after_days": 0}), "stale_sources.url_stale_after_days"),
        (body(stale_sources={"url_stale_after_days": 366}), "stale_sources.url_stale_after_days"),
        (body(auto_tag_sources={"max_tags": 2.5}), "auto_tag_sources.max_tags"),
        (body(auto_tag_sources={"max_tags": "5"}), "auto_tag_sources.max_tags"),
        (body(auto_tag_sources={"max_tags": True}), "auto_tag_sources.max_tags"),
        (body(stale_sources={"enabled": 1}), "stale_sources.enabled"),
        (body(stale_sources={"enabled": "true"}), "stale_sources.enabled"),
        (body(stale_sources={"enabled": None}), "stale_sources.enabled"),
        ({**DEFAULT_BODY, "memory_backup": {"enabled": True}}, "memory_backup"),
        (body(auto_tag_sources={"min_tags": 1}), "auto_tag_sources.min_tags"),
        ({k: v for k, v in DEFAULT_BODY.items() if k != "stale_sources"}, "stale_sources"),
        (
            body(duplicate_sources={}) | {"duplicate_sources": {"enabled": True}},
            "duplicate_sources.near_duplicate_percent",
        ),
        ([DEFAULT_BODY], "body"),
        (None, "body"),
    ],
)
def test_parse_rejects_with_400_naming_the_field(data: object, field: str) -> None:
    with pytest.raises(AncileError) as info:
        automations.parse(data)
    err = info.value
    assert err.status == 400 and err.code == "request.invalid" and err.error_class == "permanent"
    assert field in err.hint


def test_stored_sets_fill_from_defaults() -> None:
    assert automations.from_stored(None) == DEFAULTS
    assert automations.from_stored("not a set") == DEFAULTS
    # An option missing (stored before it existed) comes from the default; unknown keys are dropped.
    partial = {
        "auto_tag_sources": {"enabled": False},
        "duplicate_sources": {"enabled": False, "near_duplicate_percent": 70, "gone": 1},
        "retired_job": {"enabled": True},
    }
    got = automations.from_stored(partial)
    assert got.auto_tag_sources.model_dump() == {"enabled": False, "max_tags": 5}
    assert got.duplicate_sources.model_dump() == {"enabled": False, "near_duplicate_percent": 70}
    assert got.stale_sources == DEFAULTS.stale_sources
    # A value that no longer validates: that automation falls back to its default, the rest stay.
    bad = body(auto_tag_sources={"max_tags": 99}, stale_sources={"enabled": False})
    got = automations.from_stored(bad)
    assert got.auto_tag_sources == DEFAULTS.auto_tag_sources and got.stale_sources.enabled is False


def test_current_caches_and_keeps_the_last_set_when_a_reload_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    automations.forget()
    off = settings(stale_sources={"enabled": False})
    calls = {"n": 0}

    def load_ok() -> KnowledgeAutomations:
        calls["n"] += 1
        return off

    monkeypatch.setattr(automations, "load", load_ok)
    assert automations.current() == off and automations.current() == off
    assert calls["n"] == 1  # cached

    def load_down() -> KnowledgeAutomations:
        raise OSError("database down")

    monkeypatch.setattr(automations, "load", load_down)
    monkeypatch.setattr(automations, "CACHE_TTL_S", 0.0)
    assert automations.current() == off  # expired, reload failed: the last set stays
    automations.forget()
    with pytest.raises(OSError):
        automations.current()  # nothing to fall back on: the caller sees the failure
    automations.forget()


# --- pure helpers -----------------------------------------------------------------------------


def test_url_interval_from_the_setting() -> None:
    from datetime import UTC, datetime, timedelta

    now = datetime(2026, 10, 14, tzinfo=UTC)
    fetched = stale.Stored("url", now - timedelta(days=3), None, None, None, None)
    assert not stale.due_for_check(fetched, now)  # default: 7 days
    assert stale.due_for_check(fetched, now, stale.intervals(2))
    assert not stale.due_for_check(fetched, now, stale.intervals(4))
    # Other kinds keep their own intervals.
    by_kind = stale.intervals(1)
    assert by_kind["youtube"] == timedelta(days=30) and by_kind["file"] is None
    assert not stale.due_for_check(
        stale.Stored("file", now - timedelta(days=99), None, None, None, None), now, by_kind
    )
    with pytest.raises(ValueError):
        stale.intervals(0)


RNG = random.Random(11)
VOCAB = [f"w{i}" for i in range(3000)]
BASE = " ".join(RNG.choice(VOCAB) for _ in range(800))


def test_near_duplicate_threshold_is_a_parameter() -> None:
    words = BASE.split()
    edited = " ".join(words[:640] + [RNG.choice(VOCAB) for _ in range(160)])
    a = dedupe.Candidate("a", dedupe.content_hash(BASE), dedupe.signature(BASE))
    b = dedupe.Candidate("b", dedupe.content_hash(edited), dedupe.signature(edited))
    score = dedupe.similarity(a.sig, b.sig)
    assert 0.5 <= score < 0.9
    assert dedupe.classify(b, a) is None  # default 0.90
    m = dedupe.classify(b, a, near=0.5)
    assert m is not None and m.kind == "near_duplicate"
    assert dedupe.find_matches(b, [a], near=int(score * 100) / 100)[0].kind == "near_duplicate"
    assert dedupe.find_matches(b, [a], near=(int(score * 100) + 1) / 100) == []
    # Exact copies are duplicates at any threshold.
    same = dedupe.Candidate("c", a.hash, a.sig)
    assert dedupe.find_matches(same, [a], near=1.0)[0].kind == "duplicate"
    for bad in (0.49, 1.01):
        with pytest.raises(ValueError):
            dedupe.find_matches(b, [a], near=bad)


# --- the route ------------------------------------------------------------------------------------


@pytest.fixture
def client(kdb) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    with TestClient(create_app(), raise_server_exceptions=False) as c:
        yield c


def _stored_row() -> Any:
    with sessions().begin() as db:
        return db.execute(text("SELECT settings FROM knowledge.automation_settings WHERE id = 1")).scalar()


def test_get_before_any_put_is_the_defaults(client: TestClient) -> None:
    r = client.get(ROUTE, headers=AUTH)
    assert r.status_code == 200 and r.json() == DEFAULT_BODY
    assert _stored_row() is None  # reading never writes


def test_put_stores_returns_and_survives_a_restart(client: TestClient) -> None:
    new = body(
        auto_tag_sources={"enabled": False, "max_tags": 3},
        duplicate_sources={"near_duplicate_percent": 75},
        stale_sources={"enabled": False, "url_stale_after_days": 30},
    )
    r = client.put(ROUTE, json=new, headers=AUTH)
    assert r.status_code == 200 and r.json() == new
    assert client.get(ROUTE, headers=AUTH).json() == new
    assert _stored_row() == new
    assert automations.current().model_dump() == new
    # A restart: the copy in memory is gone, the database still has the set.
    automations.forget()
    with TestClient(create_app()) as fresh:
        assert fresh.get(ROUTE, headers=AUTH).json() == new
    # The whole set is replaced each time.
    assert client.put(ROUTE, json=DEFAULT_BODY, headers=AUTH).json() == DEFAULT_BODY
    automations.forget()
    assert client.get(ROUTE, headers=AUTH).json() == DEFAULT_BODY


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        (body(auto_tag_sources={"max_tags": 21}), "auto_tag_sources.max_tags"),
        (body(stale_sources={"url_stale_after_days": 0}), "stale_sources.url_stale_after_days"),
        ({**DEFAULT_BODY, "extra": {}}, "extra"),
        (body(duplicate_sources={"extra": 1}), "duplicate_sources.extra"),
        ({"auto_tag_sources": DEFAULT_BODY["auto_tag_sources"]}, "duplicate_sources"),
    ],
)
def test_put_rejects_an_invalid_set_with_400_and_keeps_the_last(
    client: TestClient, payload: dict[str, Any], field: str
) -> None:
    kept = body(auto_tag_sources={"max_tags": 2})
    assert client.put(ROUTE, json=kept, headers=AUTH).status_code == 200
    r = client.put(ROUTE, json=payload, headers=AUTH)
    assert r.status_code == 400, r.text
    err = r.json()["error"]
    assert err["code"] == "request.invalid" and field in err["hint"] and err["trace_id"]
    assert err["context"]["service"] == "knowledge" and err["context"]["errors"]
    assert client.get(ROUTE, headers=AUTH).json() == kept and _stored_row() == kept


def test_put_rejects_a_body_that_is_not_json(client: TestClient) -> None:
    for raw in (b"", b"{not json", b"\xff\xfe"):
        r = client.put(ROUTE, content=raw, headers={**AUTH, "content-type": "application/json"})
        assert r.status_code == 400 and r.json()["error"]["code"] == "request.invalid", raw
    assert _stored_row() is None


def test_the_route_needs_the_service_token(client: TestClient) -> None:
    assert client.get(ROUTE).status_code == 401
    r = client.put(ROUTE, json=DEFAULT_BODY)
    assert r.status_code == 401 and r.json()["error"]["code"] == "auth.service_token_invalid"
    assert _stored_row() is None


# --- auto_tag_sources -------------------------------------------------------------------------------

ARTICLE = (
    "# Tidal energy\n\nTidal power converts the energy of tides into electricity. Barrage schemes such as "
    "La Rance in France have run since 1966, while newer tidal stream turbines sit on the seabed. "
    "Turbines, barrages, lagoons and tides: tidal stream turbines and tidal lagoons both harvest tides.\n\n"
    "## Costs\n\nTidal stream projects remain expensive, but predictable output makes tidal energy "
    "attractive to grid operators who balance wind and solar. Grid operators value predictable tides.\n\n"
    "## Environment\n\nTurbines can affect fish and marine mammals; monitoring at MeyGen in Scotland "
    "studies collision risk for tidal turbines. Fish, mammals and turbines share the seabed."
)


def _row(sid: str) -> dict[str, Any]:
    with sessions().begin() as db:
        return dict(
            db.execute(
                text(
                    "SELECT status, tags, topics, content_hash, minhash FROM knowledge.sources WHERE id = :id"
                ),
                {"id": sid},
            )
            .mappings()
            .one()
        )


def _reingest(sid: str, new_text: str) -> None:
    """The source's text changed: read it again (a new version)."""
    repo.write_atomic(repo.input_path(sid), new_text)
    with sessions().begin() as db:
        db.execute(
            text("UPDATE knowledge.sources SET status = 'queued', pending_version = NULL WHERE id = :id"),
            {"id": sid},
        )
    drain()


@pytest.mark.usefixtures("kdb")
def test_tags_follow_the_switch_and_max_tags() -> None:
    on = add_text_source("ws", "Tidal energy", ARTICLE)
    drain()
    picked = _row(on)["tags"]
    assert 2 < len(picked) <= 5 and "tidal" in picked

    automations.store(settings(auto_tag_sources={"max_tags": 2}))
    two = add_text_source("ws", "Tidal energy again", ARTICLE + "\n\nMore on tidal turbines.")
    drain()
    assert len(_row(two)["tags"]) == 2

    automations.store(settings(auto_tag_sources={"enabled": False}))
    off = add_text_source("ws", "Tidal costs", ARTICLE + "\n\nCosts again.")
    drain()
    row = _row(off)
    assert row["status"] == "ready" and row["tags"] == []
    # Top terms are still kept: other sources' tags are weighed against them.
    assert row["topics"]["terms"] and row["topics"]["tags_auto"] is True

    # Switched off, a source read again keeps the tags it had: nothing added, nothing replaced.
    _reingest(on, ARTICLE.replace("Tidal power", "Wave and tidal power") + "\n\nWaves, waves, waves.")
    assert _row(on)["tags"] == picked

    # Switched back on, a machine-tagged source gets fresh tags, within max_tags.
    automations.store(settings(auto_tag_sources={"max_tags": 1}))
    _reingest(off, ARTICLE + "\n\nCosts again, and again.")
    assert len(_row(off)["tags"]) == 1


@pytest.mark.usefixtures("kdb")
def test_tags_a_person_set_are_never_replaced() -> None:
    sid = add_text_source("ws", "Tidal energy", ARTICLE)
    drain()
    with sessions().begin() as db:
        db.execute(
            text(
                "UPDATE knowledge.sources SET tags = '{mine}', "
                "topics = topics || jsonb_build_object('tags_auto', false) WHERE id = :id"
            ),
            {"id": sid},
        )
    for cfg in (settings(auto_tag_sources={"max_tags": 1}), settings(auto_tag_sources={"enabled": False})):
        automations.store(cfg)
        _reingest(sid, ARTICLE + f"\n\nRevision {cfg.auto_tag_sources.enabled}.")
        assert _row(sid)["tags"] == ["mine"]


# --- duplicate_sources -----------------------------------------------------------------------------


def _relations(ws: str) -> list[tuple[str, str, str]]:
    with sessions().begin() as db:
        return [
            (r[0], r[1], r[2])
            for r in db.execute(
                text(
                    "SELECT r.a_id, r.b_id, r.kind FROM knowledge.source_relations r "
                    "JOIN knowledge.sources s ON s.id = r.a_id WHERE s.workspace_id = :ws "
                    "AND r.status = 'suggested' ORDER BY r.a_id, r.b_id"
                ),
                {"ws": ws},
            ).all()
        ]


@pytest.mark.usefixtures("kdb")
def test_duplicates_off_records_no_suggestions_but_keeps_hashes() -> None:
    first = add_text_source("on", "Tidal energy", ARTICLE)
    drain()
    copy = add_text_source("on", "Tidal copy", ARTICLE)
    drain()
    assert _relations("on") == [(copy, first, "duplicate")]

    automations.store(settings(duplicate_sources={"enabled": False}))
    a = add_text_source("off", "Tidal energy", ARTICLE)
    drain()
    b = add_text_source("off", "Tidal copy", ARTICLE)
    drain()
    assert _relations("off") == []
    # The hash and signature are still stored: refetch, stale checks and merges use them,
    # and detection sees these sources again once it is switched back on.
    assert all(_row(s)["content_hash"] and _row(s)["minhash"] for s in (a, b))
    # Suggestions already made are left for a person to act on.
    assert _relations("on") == [(copy, first, "duplicate")]
    # A source read again while it is off drops its own suggestion: it was about the old text.
    _reingest(copy, ARTICLE + "\n\nAn added paragraph about tidal lagoons.")
    assert _relations("on") == []

    automations.store(DEFAULTS)
    c = add_text_source("off", "Tidal third copy", ARTICLE)
    drain()
    assert {(x, kind) for x, _, kind in _relations("off")} == {(c, "duplicate")}


@pytest.mark.usefixtures("kdb")
def test_near_duplicate_percent_is_the_threshold() -> None:
    words = BASE.split()
    edited = " ".join(words[:640] + [RNG.choice(VOCAB) for _ in range(160)])
    score = dedupe.similarity(dedupe.signature(BASE), dedupe.signature(edited))
    pct = int(score * 100)
    assert 50 <= pct < 90  # below today's 90 %: no suggestion by default

    for ws, percent, expected in (
        ("default", 90, []),
        ("above", pct + 1, []),
        ("at", pct, ["near_duplicate"]),
    ):
        automations.store(settings(duplicate_sources={"near_duplicate_percent": percent}))
        add_text_source(ws, f"Base {ws}", BASE)
        drain()
        add_text_source(ws, f"Edited {ws}", edited)
        drain()
        assert [kind for _, _, kind in _relations(ws)] == expected, (ws, percent, score)


# --- stale_sources ---------------------------------------------------------------------------------


def _url_source(fetched_days_ago: float, checked_days_ago: float | None = None, kind: str = "url") -> str:
    """A ready source, fetched (and maybe stale-checked) some days ago."""
    sid = repo.new_id()
    with sessions().begin() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources (id, workspace_id, kind, title, uri, status, progress, tags, "
                "topics, current_version, fetched_at, etag, stale_checked_at, stale_after) "
                "VALUES (:id, 'ws', :kind, 'Page', 'https://news.example/a', 'ready', '{}', '{}', '{}', 1, "
                "now() - make_interval(secs => :f), '\"v1\"', "
                "CASE WHEN CAST(:c AS float8) IS NULL THEN NULL ELSE now() - make_interval(secs => :c) END, "
                "CASE WHEN CAST(:c AS float8) IS NULL THEN NULL "
                "ELSE now() - make_interval(secs => :c) + interval '7 days' END)"
            ),
            {
                "id": sid,
                "kind": kind,
                "f": fetched_days_ago * 86400,
                "c": None if checked_days_ago is None else checked_days_ago * 86400,
            },
        )
    return sid


def _schedule(sid: str) -> dict[str, Any]:
    with sessions().begin() as db:
        return dict(
            db.execute(
                text(
                    "SELECT stale_after, stale_checked_at, stale_after <= now() AS due, "
                    "extract(epoch FROM stale_after - stale_checked_at) / 86400 AS days "
                    "FROM knowledge.sources WHERE id = :id"
                ),
                {"id": sid},
            )
            .mappings()
            .one()
        )


def _unchanged_upstream() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("if-none-match") == '"v1"'
        return httpx.Response(304, headers={"etag": '"v1"'})

    fetch.transport = httpx.MockTransport(handler)
    fetch.resolve_host = lambda h: ["93.184.216.34"]


@pytest.mark.usefixtures("kdb")
def test_sweep_uses_the_url_interval_from_the_setting() -> None:
    _unchanged_upstream()
    sid = _url_source(fetched_days_ago=3)
    assert asyncio.run(stale.sweep())["checked"] == 0  # 3 days < the default 7

    automations.store(settings(stale_sources={"url_stale_after_days": 2}))
    result = asyncio.run(stale.sweep())
    assert result["checked"] == 1 and result["fresh"] == 1
    sched = _schedule(sid)
    assert not sched["due"] and float(sched["days"]) == pytest.approx(2)
    assert asyncio.run(stale.sweep())["checked"] == 0  # next check in 2 days


@pytest.mark.usefixtures("kdb")
def test_changing_the_interval_reschedules_checked_url_sources() -> None:
    checked = _url_source(fetched_days_ago=10, checked_days_ago=3)  # next check in 4 days
    never = _url_source(fetched_days_ago=1)  # not checked since fetched: no stale_after
    other = _url_source(fetched_days_ago=10, checked_days_ago=3, kind="youtube")
    assert not _schedule(checked)["due"]

    automations.store(settings(stale_sources={"url_stale_after_days": 2}))
    sched = _schedule(checked)
    assert sched["due"] and float(sched["days"]) == pytest.approx(2)  # shorter: due now
    assert _schedule(never)["stale_after"] is None
    assert float(_schedule(other)["days"]) == pytest.approx(7)  # other kinds keep theirs

    automations.store(settings(stale_sources={"url_stale_after_days": 30}))
    sched = _schedule(checked)
    assert not sched["due"] and float(sched["days"]) == pytest.approx(30)

    # The same interval again (Core resends the set at start): nothing is moved.
    with sessions().begin() as db:
        db.execute(
            text("UPDATE knowledge.sources SET stale_after = now() + interval '1 hour' WHERE id = :id"),
            {"id": checked},
        )
    before = _schedule(checked)["stale_after"]
    automations.store(settings(stale_sources={"url_stale_after_days": 30, "enabled": False}))
    assert _schedule(checked)["stale_after"] == before


@pytest.mark.usefixtures("kdb")
def test_worker_sweep_runs_only_while_switched_on(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    async def fake_sweep(**_: Any) -> dict[str, int]:
        calls.append(1)
        return {"checked": 0}

    monkeypatch.setattr(stale, "sweep", fake_sweep)
    worker = jobs.Worker()  # not started: only its maintenance step runs here

    automations.store(settings(stale_sources={"enabled": False}))
    worker._next_maintenance = 0.0
    asyncio.run(worker._maintenance())
    assert calls == [] and worker._next_maintenance > 0  # skipped, and the next one still scheduled

    automations.store(DEFAULTS)
    asyncio.run(worker._maintenance())
    assert calls == [1]


def test_explicit_stale_check_runs_even_when_switched_off(client: TestClient) -> None:
    _unchanged_upstream()
    _url_source(fetched_days_ago=1)
    client.put(ROUTE, json=body(stale_sources={"enabled": False}), headers=AUTH)
    r = client.post("/kn/v1/maintenance/stale-check", json={"force": True}, headers=AUTH)
    assert r.status_code == 200 and r.json()["checked"] == 1 and r.json()["fresh"] == 1
