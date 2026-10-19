"""SR1 end to end: a scan fails with a way forward, Read with OCR reads it, the setting reads new ones."""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ancile_knowledge.ingest import ocr
from ancile_knowledge.main import create_app
from ancile_knowledge.settings import get_settings
from tests.conftest import AUTH, blank_pdf

SETTINGS = "/kn/v1/maintenance/ocr"


class Fake:
    name = "fake"

    def read(self, image: Any) -> str:
        return "Scanned words about otters."


@pytest.fixture
def client(kdb, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(get_settings(), "worker_enabled", True)
    monkeypatch.setattr(ocr, "pick_reader", lambda _language: Fake())
    with TestClient(create_app()) as c:
        c.put(SETTINGS, json={"enabled": False, "language": "en"}, headers=AUTH)
        yield c
        c.put(SETTINGS, json={"enabled": False, "language": "en"}, headers=AUTH)


def wait_for(client: TestClient, sid: str, status: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30
    body: dict[str, Any] = {}
    while time.monotonic() < deadline:
        body = client.get(f"/kn/v1/sources/{sid}", headers=AUTH).json()
        if body.get("status") == status:
            return body
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {status}: {body}")


def upload(client: TestClient, name: str, data: bytes, mime: str = "application/pdf") -> str:
    r = client.post(
        "/kn/v1/sources/upload",
        files={"file": (name, data, mime)},
        data={"workspace_id": "ws"},
        headers=AUTH,
    )
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def test_settings_round_trip_and_are_checked(client: TestClient) -> None:
    got = client.get(SETTINGS, headers=AUTH).json()
    assert (
        got["enabled"] is False
        and got["language"] == "en"
        and set(got["installed"]) == {"rapidocr", "tesseract"}
    )
    put = client.put(SETTINGS, json={"enabled": True, "language": "de"}, headers=AUTH)
    assert put.status_code == 200 and put.json()["enabled"] is True and put.json()["language"] == "de"
    bad = client.put(SETTINGS, json={"enabled": "yes", "language": "de"}, headers=AUTH)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "request.invalid"


def test_a_scan_fails_then_read_with_ocr_makes_it_searchable_page_by_page(client: TestClient) -> None:
    sid = upload(client, "scan.pdf", blank_pdf(2))
    failed = wait_for(client, sid, "failed")
    assert failed["error"]["code"] == "extract.scanned_pdf"
    assert "Read with OCR" in failed["error"]["hint"]

    r = client.post(f"/kn/v1/sources/{sid}/ocr", headers=AUTH)
    assert r.status_code == 200 and r.json()["error"] is None
    ready = wait_for(client, sid, "ready")
    assert ready["pages"] == 2 and ready["chunks"] > 0
    content = client.get(f"/kn/v1/sources/{sid}/content", headers=AUTH).json()
    for span in content["pages"]:
        assert content["markdown"][span["char_start"] : span["char_end"]] == "Scanned words about otters."


def test_with_the_setting_on_a_scan_is_read_when_it_is_added(client: TestClient) -> None:
    client.put(SETTINGS, json={"enabled": True, "language": "en"}, headers=AUTH)
    sid = upload(client, "scan2.pdf", blank_pdf(1))
    assert wait_for(client, sid, "ready")["chunks"] > 0


def test_only_pdf_files_can_be_read_with_ocr(client: TestClient) -> None:
    sid = upload(client, "notes.md", b"# Notes\n\nRemember the otters.", "text/markdown")
    wait_for(client, sid, "ready")
    r = client.post(f"/kn/v1/sources/{sid}/ocr", headers=AUTH)
    assert r.status_code == 409 and r.json()["error"]["code"] == "source.ocr_unsupported"
