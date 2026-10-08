"""Extraction: exact PDF page offsets, scanned-PDF detection, the URL SSRF guard."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from ancile_knowledge.errors import AncileError
from ancile_knowledge.ingest import extract as ex
from ancile_knowledge.ingest import fetch
from ancile_knowledge.ingest.chunk import ChunkConfig, chunk_markdown, outline
from tests.conftest import blank_pdf, make_pdf

PAGES = [
    ["Quarterly report", "Revenue rose in the third quarter.", "Costs were flat."],
    ["Second page talks about hiring.", "We hired twelve engineers."],
    ["Final page: outlook for next year (cautious)."],
]


def _write(tmp_path: Path, name: str, data: bytes) -> Path:
    p = tmp_path / name
    p.write_bytes(data)
    return p


def test_pdf_page_offsets_are_exact(tmp_path: Path) -> None:
    path = _write(tmp_path, "report.pdf", make_pdf(PAGES))
    seen: list[str] = []
    doc = ex.extract_pdf(path, lambda d, t, m: seen.append(m))
    assert doc.engine == "pdfium" and len(doc.pages) == 3
    md = doc.markdown
    for span, lines in zip(doc.pages, PAGES, strict=True):
        assert md[span.char_start : span.char_end] == "\n".join(lines)
    # Pages tile the markdown with a blank-line separator and nothing else.
    assert doc.pages[0].char_start == 0 and doc.pages[-1].char_end == len(md)
    for a, b in zip(doc.pages, doc.pages[1:], strict=False):
        assert md[a.char_end : b.char_start] == "\n\n"
    assert "Extracting page 2 of 3" in seen


def test_pdf_chunks_map_to_pages(tmp_path: Path) -> None:
    from ancile_knowledge.ingest.pipeline import _page_for

    path = _write(tmp_path, "report.pdf", make_pdf(PAGES))
    doc = ex.extract_pdf(path)
    pages = [p.as_dict() for p in doc.pages]
    result = chunk_markdown(doc.markdown, ChunkConfig(max_tokens=16, overlap_tokens=0, parent_max_tokens=64))
    for c in result.children:
        assert doc.markdown[c.char_start : c.char_end] == c.text
        page = _page_for(pages, c.char_start)
        span = pages[page - 1]
        assert span["char_start"] <= c.char_start <= span["char_end"]
    hiring = next(c for c in result.children if "hired" in c.text)
    assert _page_for(pages, hiring.char_start) == 2


def test_scanned_pdf_is_detected(tmp_path: Path) -> None:
    path = _write(tmp_path, "scan.pdf", blank_pdf(4))
    with pytest.raises(AncileError) as err:
        ex.extract_pdf(path)
    assert err.value.code == "extract.scanned_pdf"
    assert "OCR" in err.value.hint


def test_damaged_pdf_fails_readably(tmp_path: Path) -> None:
    path = _write(tmp_path, "broken.pdf", b"%PDF-1.4\nnot really a pdf")
    with pytest.raises(AncileError) as err:
        ex.extract_pdf(path)
    assert err.value.code == "extract.pdf_unreadable"


def test_choose_engine() -> None:
    assert ex.choose_engine(ex.ExtractInput(kind="text", text="x")) == "plain"
    assert ex.choose_engine(ex.ExtractInput(kind="url", url="https://a.b")) == "web"
    assert ex.choose_engine(ex.ExtractInput(kind="file", filename="a.pdf")) == "pdfium"
    assert ex.choose_engine(ex.ExtractInput(kind="file", filename="a.docx")) == "markitdown"
    assert ex.choose_engine(ex.ExtractInput(kind="file", filename="main.py")) == "plain"
    assert ex.choose_engine(ex.ExtractInput(kind="file", filename="data.csv")) == "plain"
    with pytest.raises(AncileError) as err:
        ex.choose_engine(ex.ExtractInput(kind="file", filename="photo.heic", mime="image/heic"))
    assert err.value.code == "extract.unsupported"


def test_plain_code_is_fenced_and_newlines_normalised(tmp_path: Path) -> None:
    path = _write(tmp_path, "tool.py", b"def f():\r\n    return 1\r\n")
    doc = ex.extract_plain(ex.ExtractInput(kind="file", path=path, filename="tool.py"))
    assert doc.markdown.startswith("```python\n") and "\r" not in doc.markdown


def test_html_file_via_markitdown(tmp_path: Path) -> None:
    html = b"<html><head><title>Notes</title></head><body><h1>Plan</h1><p>Ship the thing.</p></body></html>"
    path = _write(tmp_path, "notes.html", html)
    doc = ex.extract_office(path, "notes.html", "text/html")
    assert "# Plan" in doc.markdown and "Ship the thing." in doc.markdown
    assert outline(doc.markdown)[0]["title"] == "Plan"


# --- SSRF guard ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/admin",
        "http://localhost.test/",  # resolves to loopback below
        "http://10.0.0.8/",
        "http://192.168.1.1/router",
        "http://172.16.5.4/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[fd00:ec2::254]/",
        "http://[::ffff:127.0.0.1]/",
        "http://0.0.0.0/",
        "file:///etc/passwd",
        "ftp://example.com/file",
        "gopher://example.com/",
    ],
)
def test_guard_rejects_unsafe_urls(url: str) -> None:
    def resolver(host: str) -> list[str]:
        return {"localhost.test": ["127.0.0.1"]}.get(host, ["93.184.216.34"])

    with pytest.raises(AncileError) as err:
        fetch.guard_url(url, resolver=resolver)
    assert err.value.code == "extract.url_blocked"


def test_guard_rejects_hosts_resolving_to_private_addresses() -> None:
    with pytest.raises(AncileError) as err:
        fetch.guard_url("https://intranet.example/", resolver=lambda h: ["93.184.216.34", "10.1.2.3"])
    assert "private" in err.value.hint


def test_guard_pins_public_hosts() -> None:
    t = fetch.guard_url("https://example.com:8443/a?b=1", resolver=lambda h: ["93.184.216.34"])
    assert t.url == "https://93.184.216.34:8443/a?b=1"
    assert t.host_header == "example.com:8443" and t.sni == "example.com"


def test_private_hosts_allowed_when_configured() -> None:
    t = fetch.guard_url("http://10.0.0.8/wiki", allow_private=True)
    assert t.url == "http://10.0.0.8/wiki"
    with pytest.raises(AncileError):  # metadata endpoints stay blocked regardless
        fetch.guard_url("http://169.254.169.254/", allow_private=True)


def test_redirect_to_private_host_is_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://internal.example/secret"})

    monkeypatch.setattr(fetch, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(
        fetch, "resolve_host", lambda h: {"internal.example": ["10.9.9.9"]}.get(h, ["93.184.216.34"])
    )
    with pytest.raises(AncileError) as err:
        asyncio.run(fetch.fetch_url("https://public.example/start"))
    assert err.value.code == "extract.url_blocked"


def test_fetch_sends_host_header_and_conditionals(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update({"host": request.headers["host"], "url": str(request.url)})
        seen["inm"] = request.headers.get("if-none-match", "")
        return httpx.Response(304, headers={"etag": '"v1"'})

    monkeypatch.setattr(fetch, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(fetch, "resolve_host", lambda h: ["93.184.216.34"])
    res = asyncio.run(fetch.fetch_url("https://news.example/post", etag='"v1"'))
    assert res.status == 304
    assert seen["host"] == "news.example" and seen["url"].startswith("https://93.184.216.34/")
    assert seen["inm"] == '"v1"'


def test_fetch_4xx_is_a_readable_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fetch, "transport", httpx.MockTransport(lambda r: httpx.Response(404)))
    monkeypatch.setattr(fetch, "resolve_host", lambda h: ["93.184.216.34"])
    with pytest.raises(AncileError) as err:
        asyncio.run(fetch.fetch_url("https://gone.example/x"))
    assert err.value.code == "extract.fetch_failed" and "404" in (err.value.detail or "")


def test_url_html_becomes_markdown(monkeypatch: pytest.MonkeyPatch) -> None:
    body = (
        "<html><head><title>Field guide to owls</title></head><body><nav>menu</nav>"
        "<article><h1>Owls</h1><p>"
        + "Owls hunt at night and fly silently. " * 12
        + "</p></article></body></html>"
    )
    monkeypatch.setattr(
        fetch,
        "transport",
        httpx.MockTransport(
            lambda r: httpx.Response(200, text=body, headers={"content-type": "text/html", "etag": '"a"'})
        ),
    )
    monkeypatch.setattr(fetch, "resolve_host", lambda h: ["93.184.216.34"])
    doc = asyncio.run(ex.extract(ex.ExtractInput(kind="url", url="https://birds.example/owls")))
    assert doc.engine == "web" and doc.etag == '"a"'
    assert "fly silently" in doc.markdown and doc.title and "owls" in doc.title.lower()
