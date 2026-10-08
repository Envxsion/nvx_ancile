"""
Evidence for fact-checking: per-claim passages with the right quote and
its exact span, relevance and coverage, and notebook scoping.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from ancile_knowledge.main import create_app
from ancile_knowledge.search.evidence import best_quote, coverage, overlap, terms
from tests.conftest import AUTH, add_text_source, drain

PUMP = (
    "# Pump manual\n\nThe ZX-4410 pump must be primed before first use. Open valve V2, fill the housing, "
    "then close V2.\n\n## Faults\n\nError code E-17 means the impeller is blocked; switch off and clear it."
)
OWLS = "# Owls\n\nOwls are nocturnal birds of prey. Their soft feathers let them fly silently."


def test_terms_keep_numbers_and_drop_stopwords() -> None:
    assert terms("The pump is rated at 4410 rpm, and it is quiet.") == [
        "pump",
        "rated",
        "4410",
        "rpm",
        "quiet",
    ]


def test_overlap_matches_simple_inflections() -> None:
    assert overlap(terms("pumps are primed"), "Prime the pump first.") == 1.0
    assert overlap([], "anything") == 0.0


def test_best_quote_picks_the_matching_sentence_with_exact_offsets() -> None:
    text = PUMP.split("\n\n", 1)[1]
    quote, start, end = best_quote(text, "Error E-17 means a blocked impeller")
    assert quote.startswith("Error code E-17")
    assert text[start:end] == quote


def test_best_quote_skips_headings() -> None:
    quote, _, _ = best_quote("# Owls\n\nOwls hunt at night.", "owls")
    assert quote == "Owls hunt at night."


def test_coverage_is_share_of_claim_words_found() -> None:
    assert coverage("owls hunt mice", ["Owls hunt at night."]) == pytest.approx(2 / 3)


@pytest.mark.usefixtures("kdb")
def test_evidence_endpoint_returns_quotes_with_source_spans() -> None:
    pump = add_text_source("ws", "Pump manual", PUMP, notebooks={"nb1": "full"})
    add_text_source("ws", "Owls", OWLS, notebooks={"nb2": "full"})
    drain()
    client = TestClient(create_app())
    r = client.post(
        "/kn/v1/evidence",
        json={
            "workspace_id": "ws",
            "notebook_id": "nb1",
            "claims": ["Error code E-17 means the impeller is blocked.", "Owls are nocturnal."],
            "k_per_claim": 3,
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"results", "mode", "embedder", "ms"}
    first, second = body["results"]
    hit = first["hits"][0]
    assert hit["source_id"] == pump
    assert "E-17" in hit["quote"]
    assert 0 < hit["relevance"] <= 1 and first["coverage"] > 0.8
    # The quote's span points into the source's own text.
    assert PUMP[hit["quote_start"] : hit["quote_end"]] == hit["quote"]
    # Scoped to nb1: the owls source lives in another notebook.
    assert all(h["source_id"] == pump for h in second["hits"])


def test_evidence_rejects_blank_claims() -> None:
    client = TestClient(create_app(), raise_server_exceptions=False)
    r = client.post("/kn/v1/evidence", json={"workspace_id": "ws", "claims": ["  "]}, headers=AUTH)
    assert r.status_code == 422
