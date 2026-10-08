"""
------------------------------------------------------------------
 Title    |  Extraction: anything → markdown
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  One interface over several engines, chosen per input:
          |    pdfium (pypdfium2): PDFs, page by page, with exact page
          |      spans into the markdown
          |    MarkItDown (MIT): DOCX, PPTX, XLSX, EPUB, HTML
          |    web: fetch.py (SSRF-guarded) + readability + MarkItDown
          |    plain: text, markdown, CSV, JSON and code as-is
          |    Docling (MIT): layout-heavy PDFs, when installed
 How      |  choose_engine() is pure and tested. Every engine returns
          |  an ExtractedDocument whose markdown has "\n" line endings:
          |  that exact string is stored, chunked and served by
          |  /content, so offsets agree everywhere. A PDF whose pages
          |  carry no text fails with extract.scanned_pdf.
 Note     |  TODO(phase-4): Docling adapter with bounding boxes, OCR
          |  for scanned PDFs, YouTube and audio transcripts.
------------------------------------------------------------------
"""

from __future__ import annotations

import contextlib
import io
import json
import mimetypes
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from ..errors import AncileError

Engine = Literal["plain", "markitdown", "docling", "pdfium", "web"]


@dataclass
class PageSpan:
    page: int
    char_start: int
    char_end: int

    def as_dict(self) -> dict[str, int]:
        return {"page": self.page, "char_start": self.char_start, "char_end": self.char_end}


@dataclass
class ExtractedDocument:
    markdown: str
    title: str | None
    engine: Engine
    mime: str | None = None
    pages: list[PageSpan] = field(default_factory=list)
    metadata: dict[str, str] = field(default_factory=dict)
    etag: str | None = None
    last_modified: str | None = None
    not_modified: bool = False  # a conditional refetch answered 304


@dataclass
class ExtractInput:
    kind: str  # file | url | text | thread
    path: Path | None = None
    url: str | None = None
    text: str | None = None
    mime: str | None = None
    filename: str | None = None
    etag: str | None = None
    last_modified: str | None = None


# Progress callback: (done, total, message).
OnProgressT = Callable[[int | None, int | None, str], None]

_PLAIN_MIME = {
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "text/csv",
    "application/json",
    "application/x-ndjson",
    "application/xml",
    "text/xml",
    "application/x-yaml",
    "text/yaml",
}
_PLAIN_EXT = {
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".xml",
    ".log",
    ".rst",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".sh",
    ".ps1",
    ".sql",
    ".swift",
    ".scala",
    ".lua",
    ".r",
    ".css",
    ".scss",
    ".vue",
    ".svelte",
}
_CODE_LANG = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".mjs": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".sh": "bash",
    ".ps1": "powershell",
    ".sql": "sql",
    ".swift": "swift",
    ".scala": "scala",
    ".lua": "lua",
    ".r": "r",
    ".css": "css",
    ".scss": "scss",
    ".vue": "vue",
    ".svelte": "svelte",
}
_OFFICE_MIME = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/epub+zip",
    "text/html",
    "application/xhtml+xml",
}
_OFFICE_EXT = {".docx", ".pptx", ".xlsx", ".xls", ".epub", ".html", ".htm", ".xhtml"}

# A page with fewer visible characters than this counts as empty.
_EMPTY_PAGE_CHARS = 8
# Share of empty pages at which a PDF is treated as scanned.
_SCANNED_SHARE = 0.8


def guess_mime(filename: str | None, declared: str | None = None) -> str | None:
    declared = (declared or "").split(";")[0].strip().lower() or None
    if declared and declared != "application/octet-stream":
        return declared
    if filename:
        guessed, _ = mimetypes.guess_type(filename)
        if guessed:
            return guessed
        if Path(filename).suffix.lower() in _PLAIN_EXT:
            return "text/plain"
    return declared


def choose_engine(
    item: ExtractInput, *, docling_available: bool = False, use_docling: bool = False
) -> Engine:
    if item.kind in ("text", "thread"):
        return "plain"
    if item.kind == "url":
        return "web"
    ext = Path(item.filename or (item.path.name if item.path else "")).suffix.lower()
    mime = (item.mime or "").split(";")[0].lower()
    if mime == "application/pdf" or ext == ".pdf":
        return "docling" if (use_docling and docling_available) else "pdfium"
    if mime in _OFFICE_MIME or ext in _OFFICE_EXT:
        return "markitdown"
    if mime in _PLAIN_MIME or ext in _PLAIN_EXT or mime.startswith("text/"):
        return "plain"
    raise unsupported(item.filename or mime or "this file")


def unsupported(what: str) -> AncileError:
    return AncileError(
        "extract.unsupported",
        "This file type cannot be read yet",
        f"Ancile cannot extract text from {what}. Convert it to PDF, DOCX or text and add it again.",
        status=422,
        error_class="permanent",
    )


def missing_extra(engine: str, extra: str) -> AncileError:
    return AncileError(
        "extract.engine_missing",
        f"The {engine} extractor is not installed",
        f"Install it with: uv sync --extra {extra} (the Docker image includes it).",
        status=501,
        error_class="permanent",
    )


def extract_failed(detail: str) -> AncileError:
    return AncileError(
        "extract.failed",
        "The text could not be read from this source",
        "Check the file opens normally. If it does, convert it to PDF or text and add it again.",
        status=422,
        error_class="permanent",
        detail=detail,
    )


def normalise_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16") if data[:2] in (b"\xff\xfe", b"\xfe\xff") else ("utf-8-sig",):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


# --- plain ---------------------------------------------------------------------


def extract_plain(item: ExtractInput) -> ExtractedDocument:
    if item.text is not None:
        return ExtractedDocument(normalise_newlines(item.text), None, "plain", "text/markdown")
    if item.path is None:
        raise AncileError("extract.no_input", "Nothing to extract", "Send text, a file or a URL.", status=400)
    name = item.filename or item.path.name
    ext = Path(name).suffix.lower()
    text = normalise_newlines(_decode(item.path.read_bytes()))
    if ext == ".json":
        with contextlib.suppress(ValueError):
            text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
    if ext in _CODE_LANG:
        fence = "````" if "```" in text else "```"
        text = f"{fence}{_CODE_LANG[ext]}\n{text.rstrip()}\n{fence}\n"
    return ExtractedDocument(text, Path(name).stem, "plain", item.mime)


# --- PDF (pypdfium2) ---------------------------------------------------------------


def _clean_pdf_text(raw: str) -> str:
    text = normalise_newlines(raw)
    # pdfium emits soft hyphen and form feed noise; drop them, keep layout breaks.
    text = text.replace("￾", "").replace("\x0c", "").replace("­", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def extract_pdf(path: Path, on_page: OnProgressT | None = None) -> ExtractedDocument:
    """
    Page by page. Pages are joined with a blank line; PageSpan records each
    page's [char_start, char_end) in the final markdown, so a chunk's page is
    the span containing its char_start.
    """
    try:
        import pypdfium2 as pdfium
    except ImportError as exc:
        raise missing_extra("PDF", "extract") from exc
    try:
        pdf = pdfium.PdfDocument(str(path))
    except Exception as exc:  # pdfium raises PdfiumError for broken or encrypted files
        raise AncileError(
            "extract.pdf_unreadable",
            "This PDF could not be opened",
            "It may be damaged or password protected. Open it, save a fresh copy, and add that.",
            status=422,
            error_class="permanent",
            detail=type(exc).__name__,
        ) from exc
    try:
        total = len(pdf)
        parts: list[str] = []
        pages: list[PageSpan] = []
        empty = 0
        pos = 0
        for i in range(total):
            if on_page:
                on_page(i, total, f"Extracting page {i + 1:,} of {total:,}")
            page = pdf[i]
            try:
                textpage = page.get_textpage()
                try:
                    text = _clean_pdf_text(textpage.get_text_range())
                finally:
                    textpage.close()
            finally:
                page.close()
            if len(re.sub(r"\s", "", text)) < _EMPTY_PAGE_CHARS:
                empty += 1
            if parts:
                pos += 2  # the "\n\n" separator
            pages.append(PageSpan(i + 1, pos, pos + len(text)))
            parts.append(text)
            pos += len(text)
        title = None
        try:
            meta = pdf.get_metadata_dict()
            title = (meta.get("Title") or "").strip() or None
        except Exception:
            title = None
    finally:
        pdf.close()
    if total == 0 or empty / total >= _SCANNED_SHARE:
        raise AncileError(
            "extract.scanned_pdf",
            "This PDF has no text layer",
            "It looks scanned. Enable OCR in Settings → Sources, then retry.",
            status=422,
            error_class="permanent",
            detail=f"{empty} of {total} pages had no text",
        )
    if on_page:
        on_page(total, total, f"Extracted {total:,} pages")
    return ExtractedDocument("\n\n".join(parts), title or path.stem, "pdfium", "application/pdf", pages)


# --- Office and HTML (MarkItDown) --------------------------------------------------


def _markitdown() -> object:
    try:
        from markitdown import MarkItDown
    except ImportError as exc:
        raise missing_extra("MarkItDown", "extract") from exc
    return MarkItDown(enable_plugins=False)


def extract_office(path: Path, filename: str | None, mime: str | None) -> ExtractedDocument:
    md = _markitdown()
    try:
        result = md.convert(str(path))  # type: ignore[attr-defined]
    except Exception as exc:
        raise extract_failed(f"MarkItDown: {type(exc).__name__}") from exc
    text = normalise_newlines(result.markdown or "").strip()
    if not text:
        raise extract_failed("MarkItDown returned no text")
    title = getattr(result, "title", None) or Path(filename or path.name).stem
    return ExtractedDocument(text, title, "markitdown", mime)


def html_to_markdown(html: bytes | str, url: str | None = None) -> tuple[str, str | None]:
    """Main content (readability) converted to markdown (MarkItDown)."""
    raw = html.decode("utf-8", errors="replace") if isinstance(html, bytes) else html
    title: str | None = None
    content_html = raw
    try:
        from readability import Document

        doc = Document(raw)
        title = (doc.short_title() or "").strip() or None
        summary = doc.summary(html_partial=True)
        # readability can strip too much on short pages; keep the whole page then.
        if len(re.sub(r"<[^>]+>|\s", "", summary)) >= 200:
            content_html = f"<html><body>{summary}</body></html>"
    except Exception:
        content_html = raw
    from markitdown import StreamInfo

    md = _markitdown()
    result = md.convert_stream(  # type: ignore[attr-defined]
        io.BytesIO(content_html.encode("utf-8")),
        stream_info=StreamInfo(mimetype="text/html", extension=".html", charset="utf-8", url=url),
    )
    text = normalise_newlines(result.markdown or "").strip()
    title = title or getattr(result, "title", None)
    if title and not text.lstrip().startswith("#"):
        text = f"# {title}\n\n{text}"
    return text, title


async def extract_url(item: ExtractInput, *, allow_private: bool, max_bytes: int) -> ExtractedDocument:
    from . import fetch

    assert item.url
    res = await fetch.fetch_url(
        item.url,
        allow_private=allow_private,
        max_bytes=max_bytes,
        etag=item.etag,
        last_modified=item.last_modified,
    )
    if res.status == 304:
        return ExtractedDocument(
            "",
            None,
            "web",
            None,
            etag=res.etag or item.etag,
            last_modified=res.last_modified or item.last_modified,
            not_modified=True,
        )
    ctype = (res.content_type or "").split(";")[0].strip().lower()
    if ctype == "application/pdf" or res.body[:5] == b"%PDF-":
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(res.body)
            tmp_path = Path(tmp.name)
        try:
            doc = extract_pdf(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)
        doc.engine = "web"
    elif ctype in ("text/html", "application/xhtml+xml") or (
        not ctype and b"<html" in res.body[:2048].lower()
    ):
        text, title = html_to_markdown(res.body, res.url)
        if not text:
            raise extract_failed("the page had no readable text")
        doc = ExtractedDocument(text, title, "web", "text/html")
    elif ctype.startswith("text/") or ctype in _PLAIN_MIME:
        doc = ExtractedDocument(normalise_newlines(_decode(res.body)).strip(), None, "web", ctype)
    else:
        raise unsupported(f"pages of type {ctype or 'unknown'}")
    doc.etag = res.etag
    doc.last_modified = res.last_modified
    doc.metadata["final_url"] = res.url
    return doc


# --- entry point -------------------------------------------------------------------


async def extract(
    item: ExtractInput,
    *,
    allow_private: bool = False,
    max_fetch_bytes: int = 50 * 1024 * 1024,
    on_progress: OnProgressT | None = None,
) -> ExtractedDocument:
    engine = choose_engine(item)
    if engine == "plain":
        return extract_plain(item)
    if engine == "web":
        return await extract_url(item, allow_private=allow_private, max_bytes=max_fetch_bytes)
    assert item.path is not None
    if engine in ("pdfium", "docling"):
        # TODO(phase-4): Docling for layout-heavy PDFs (tables, bounding boxes).
        return extract_pdf(item.path, on_progress)
    return extract_office(item.path, item.filename, item.mime)
