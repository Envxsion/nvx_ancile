"""SR1: OCR reads only the pages with no text layer, keeps offsets exact, and fails in plain words."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from ancile_knowledge.errors import AncileError
from ancile_knowledge.ingest import extract as ex
from ancile_knowledge.ingest import ocr
from tests.conftest import blank_pdf, make_pdf


class FakeReader:
    """Stands in for RapidOCR or Tesseract: answers by how many pages it has been asked for."""

    name = "fake"

    def __init__(self, language: str = "en", empty: bool = False) -> None:
        self.language = language
        self.calls = 0
        self.empty = empty

    def read(self, image: Any) -> str:
        self.calls += 1
        assert image.size[0] > 1000, "pages are rendered large enough to read"
        return "" if self.empty else f"Scanned page text {self.calls}\nsecond line  \n"


def plan(tmp_path: Path | None = None, reader: FakeReader | None = None, language: str = "en") -> ocr.OcrPlan:
    r = reader or FakeReader(language)
    return ocr.OcrPlan(language, tmp_path, make_reader=lambda _lang: r)


def write(tmp_path: Path, name: str, data: bytes) -> Path:
    p = tmp_path / name
    p.write_bytes(data)
    return p


def test_without_ocr_a_scan_still_says_how_to_turn_it_on(tmp_path: Path) -> None:
    with pytest.raises(AncileError) as err:
        ex.extract_pdf(write(tmp_path, "scan.pdf", blank_pdf(3)))
    assert err.value.code == "extract.scanned_pdf"
    assert "Settings → Sources" in err.value.hint
    assert "Read with OCR" in err.value.hint


def test_a_scan_is_read_page_by_page_with_progress(tmp_path: Path) -> None:
    seen: list[str] = []
    p = plan()
    doc = ex.extract_pdf(write(tmp_path, "scan.pdf", blank_pdf(3)), lambda d, t, m: seen.append(m), p)
    assert doc.engine == "pdfium+ocr"
    assert [s.page for s in doc.pages] == [1, 2, 3]
    assert "Reading page 2 of 3 with OCR" in seen
    assert "Extracted 3 pages, 3 with OCR" in seen
    assert doc.markdown.count("Scanned page text") == 3
    assert p.pages_read == 3


def test_a_pdf_mixing_text_and_scanned_pages_only_reads_the_empty_ones(tmp_path: Path) -> None:
    pages = [["Page one has real text in it.", "More text."], [], ["Page three is typed too."], []]
    reader = FakeReader()
    doc = ex.extract_pdf(write(tmp_path, "mixed.pdf", make_pdf(pages)), None, plan(reader=reader))
    assert reader.calls == 2
    md = doc.markdown
    # Offsets stay exact: each page's span holds that page's text, and the pages tile the markdown.
    assert md[doc.pages[0].char_start : doc.pages[0].char_end] == "Page one has real text in it.\nMore text."
    assert md[doc.pages[1].char_start : doc.pages[1].char_end].startswith("Scanned page text 1")
    assert md[doc.pages[2].char_start : doc.pages[2].char_end] == "Page three is typed too."
    assert md[doc.pages[3].char_start : doc.pages[3].char_end].startswith("Scanned page text 2")
    assert doc.pages[0].char_start == 0 and doc.pages[-1].char_end == len(md)
    for a, b in zip(doc.pages, doc.pages[1:], strict=False):
        assert md[a.char_end : b.char_start] == "\n\n"


def test_a_pdf_with_a_text_layer_never_starts_the_engine(tmp_path: Path) -> None:
    def boom(_lang: str) -> ocr.Reader:
        raise AssertionError("the OCR engine must not start for a PDF with text")

    doc = ex.extract_pdf(
        write(tmp_path, "typed.pdf", make_pdf([["All typed."], ["Also typed."]])),
        None,
        ocr.OcrPlan("en", None, make_reader=boom),
    )
    assert doc.engine == "pdfium"


def test_ocr_not_installed_is_a_plain_error(tmp_path: Path) -> None:
    none_installed = ocr.OcrPlan("en", None, make_reader=lambda _lang: None)
    with pytest.raises(AncileError) as err:
        ex.extract_pdf(write(tmp_path, "scan.pdf", blank_pdf(2)), None, none_installed)
    assert err.value.code == "extract.ocr_unavailable"
    assert "RapidOCR" in err.value.hint and "Tesseract" in err.value.hint


def test_pages_that_stay_empty_after_ocr_say_so(tmp_path: Path) -> None:
    with pytest.raises(AncileError) as err:
        ex.extract_pdf(write(tmp_path, "faint.pdf", blank_pdf(3)), None, plan(reader=FakeReader(empty=True)))
    assert err.value.code == "extract.empty"
    assert "handwritten" in err.value.hint


def test_each_page_is_cached_so_a_stopped_scan_carries_on(tmp_path: Path) -> None:
    pdf = write(tmp_path, "big.pdf", blank_pdf(5))
    cache = tmp_path / "ocr"
    first = FakeReader()

    class Stops(Exception):
        pass

    stopped_after = 3

    def on_page(done: int | None, total: int | None, message: str) -> None:
        if message.startswith("Reading page") and (done or 0) >= stopped_after:
            raise Stops

    with pytest.raises(Stops):
        ex.extract_pdf(pdf, on_page, plan(cache, first))
    assert first.calls == stopped_after  # pages 1 to 3 were read and kept
    again = FakeReader()
    doc = ex.extract_pdf(pdf, None, plan(cache, again))
    assert again.calls == 2  # only pages 4 and 5 are read the second time
    assert doc.markdown.count("Scanned page text") == 5


def test_a_different_language_does_not_reuse_the_cache(tmp_path: Path) -> None:
    pdf = write(tmp_path, "scan.pdf", blank_pdf(1))
    cache = tmp_path / "ocr"
    ex.extract_pdf(pdf, None, plan(cache, FakeReader("en"), "en"))
    german = FakeReader("de")
    ex.extract_pdf(pdf, None, plan(cache, german, "de"))
    assert german.calls == 1


def test_engine_choice_follows_the_language(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[str] = []

    class Rapid:
        name = "rapidocr"

        def read(self, image: Any) -> str:
            return ""

    class Tess:
        name = "tesseract"

        def __init__(self, language: str) -> None:
            made.append(language)

        def read(self, image: Any) -> str:
            return ""

    monkeypatch.setattr(ocr, "_Rapid", Rapid)
    monkeypatch.setattr(ocr, "_Tesseract", Tess)
    assert ocr.pick_reader("en").name == "rapidocr"  # type: ignore[union-attr]
    assert ocr.pick_reader("de").name == "rapidocr"  # type: ignore[union-attr]
    assert ocr.pick_reader("ru").name == "tesseract"  # type: ignore[union-attr]
    assert ocr.pick_reader("en+ja").name == "tesseract"  # type: ignore[union-attr]
    assert made == ["ru", "en+ja"]

    def broken(_language: str) -> Any:
        raise RuntimeError("not installed")

    monkeypatch.setattr(ocr, "_Tesseract", broken)
    # A non-Latin scan with only RapidOCR installed still gets its best effort rather than a refusal.
    assert ocr.pick_reader("ru").name == "rapidocr"  # type: ignore[union-attr]

    def none(*_a: Any) -> Any:
        raise ImportError

    monkeypatch.setattr(ocr, "_Rapid", none)
    assert ocr.pick_reader("en") is None


def test_settings_are_checked_strictly() -> None:
    assert ocr.parse_settings({"enabled": True, "language": "de"}) == ocr.OcrSettings(True, "de")
    assert ocr.parse_settings({"enabled": False, "language": "chi_sim+eng"}).language == "chi_sim+eng"
    for bad in (
        {"enabled": "yes", "language": "en"},
        {"enabled": True},
        {"enabled": True, "language": "English language"},
        {"enabled": True, "language": "en", "extra": 1},
        "on",
    ):
        with pytest.raises(AncileError) as err:
            ocr.parse_settings(bad)
        assert err.value.code == "request.invalid"
