"""CH6: reading a PDF for one message. No database; nothing is stored or indexed."""

from fastapi.testclient import TestClient

from ancile_knowledge.main import create_app
from tests.conftest import blank_pdf, make_pdf

client = TestClient(create_app(), raise_server_exceptions=False)
AUTH = {"authorization": "Bearer test-service-token"}
PAGES = [
    [f"{w} pump valve flange gasket bearing shaft seal casing impeller"]
    for w in ("Alpha", "Bravo", "Charlie")
]


def _upload(data: bytes, name: str = "manual.pdf"):
    return client.post(
        "/kn/v1/attachments/extract",
        files={"file": (name, data, "application/pdf")},
        headers=AUTH,
    )


def test_reads_each_page_and_counts_them() -> None:
    r = _upload(make_pdf(PAGES))
    assert r.status_code == 200
    body = r.json()
    assert body["pages"] == 3
    assert "Bravo" in body["markdown"]


def test_needs_the_service_token() -> None:
    r = client.post(
        "/kn/v1/attachments/extract", files={"file": ("a.pdf", make_pdf(PAGES), "application/pdf")}
    )
    assert r.status_code == 401


def test_a_scanned_pdf_is_refused_in_words_that_fit_an_attachment() -> None:
    r = _upload(blank_pdf(2))
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "attachment.scanned_pdf"
    assert "source" in err["hint"]


def test_an_empty_file_is_refused() -> None:
    r = _upload(b"")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "attachment.empty"
