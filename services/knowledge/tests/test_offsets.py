"""
Offsets leave Knowledge in UTF-16 code units, the way the Cockpit and Core
slice strings, so a highlight stays on its words after an emoji.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from ancile_knowledge.main import create_app
from ancile_knowledge.offsets import U16Map, u16_len
from tests.conftest import AUTH, add_text_source, drain

# Astral characters (emoji, maths letters) before the passage we cite.
SOURCE = (
    "# Field notes 🛠️\n\nThe 𝑥-axis pump 🚰 shows rotor wear 🔩 after a season.\n\n"
    "## Faults\n\nError code E-17 means the impeller is blocked; switch off and clear it."
)


def js_slice(s: str, start: int, end: int) -> str:
    """What JavaScript's s.slice(start, end) returns."""
    return s.encode("utf-16-le")[2 * start : 2 * end].decode("utf-16-le")


def test_u16_map_is_identity_without_astral_characters() -> None:
    m = U16Map("plain ascii and é ü ñ")
    assert [m(i) for i in (0, 5, 21)] == [0, 5, 21]


def test_u16_map_counts_each_astral_character_once() -> None:
    text = "a😀b😀c"
    m = U16Map(text)
    assert m(text.index("b")) == 3 and m(text.index("c")) == 6
    assert u16_len(text) == 7


@pytest.mark.usefixtures("kdb")
def test_evidence_and_content_offsets_slice_correctly_in_javascript() -> None:
    sid = add_text_source("ws", "Notes", SOURCE, notebooks={"nb": "full"})
    drain()
    client = TestClient(create_app())
    r = client.post(
        "/kn/v1/evidence",
        json={
            "workspace_id": "ws",
            "notebook_id": "nb",
            "claims": ["Error code E-17 means the impeller is blocked."],
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    hit = r.json()["results"][0]["hits"][0]
    assert hit["source_id"] == sid
    assert js_slice(SOURCE, hit["quote_start"], hit["quote_end"]) == hit["quote"]

    s = client.post(
        "/kn/v1/search",
        json={"workspace_id": "ws", "notebook_id": "nb", "query": "impeller blocked E-17", "k": 3},
        headers=AUTH,
    )
    assert s.status_code == 200, s.text
    top = s.json()["hits"][0]
    assert js_slice(SOURCE, top["char_start"], top["char_end"]) == top["text"]

    c = client.get(f"/kn/v1/sources/{sid}/content", params={"workspace_id": "ws"}, headers=AUTH)
    assert c.status_code == 200, c.text
    faults = next(h for h in c.json()["outline"] if h["title"] == "Faults")
    assert js_slice(SOURCE, faults["char_start"], faults["char_start"] + 9) == "## Faults"
