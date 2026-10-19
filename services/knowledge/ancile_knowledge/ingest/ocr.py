"""
------------------------------------------------------------------
 Title    |  OCR for scanned PDFs
 Ref      |  ROADMAP SR1 · docs/knowledge.md (Scanned PDFs)
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Read the pages of a PDF that carry no text layer, on this
          |  computer, so a scan can be searched, cited and
          |  highlighted like any other source.
 How      |  A page with a text layer is never OCR'd; only an empty
          |  page is rendered (pypdfium2) and read. The text goes into
          |  the page's own span of the markdown, so offsets stay
          |  exact and a citation still lands on the page. Engines:
          |  RapidOCR (ONNX, Latin and Chinese) first, Tesseract when
          |  it is installed and the language needs it. The settings
          |  (Core owns them: Settings → Sources) arrive with
          |    PUT /kn/v1/maintenance/ocr  {enabled, language}
          |  and are stored in knowledge.ocr_settings. A single source
          |  can ask for OCR on its own (sources.ocr), which is what
          |  "Read with OCR" on a failed source does.
 TODO     |  TODO(phase-0.3.0): Pro sends large scans to a GPU (CM1).
 Note     |  Each page's text is cached on disk beside the source, so
          |  a 500-page scan that is stopped, or the service
          |  restarting, carries on from the last page read. Nothing
          |  leaves this computer. Handwriting is read badly by both
          |  engines; a page that still comes back empty fails with
          |  extract.empty rather than pretending.
------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from fastapi import APIRouter, Request
from sqlalchemy import text

from ..db import sessions
from ..errors import AncileError
from ..obs import get_logger

log = get_logger("ocr")

S = "knowledge"

# ISO 639-1 → Tesseract's language codes, for the languages people actually scan in.
TESSERACT_LANG = {
    "en": "eng",
    "de": "deu",
    "fr": "fra",
    "es": "spa",
    "it": "ita",
    "pt": "por",
    "nl": "nld",
    "sv": "swe",
    "pl": "pol",
    "tr": "tur",
    "ru": "rus",
    "uk": "ukr",
    "el": "ell",
    "he": "heb",
    "ar": "ara",
    "hi": "hin",
    "th": "tha",
    "vi": "vie",
    "ja": "jpn",
    "ko": "kor",
    "zh": "chi_sim",
}
# What RapidOCR's bundled model reads well: Latin letters and Chinese.
RAPID_LANGS = {"en", "de", "fr", "es", "it", "pt", "nl", "sv", "pl", "tr", "zh", "ch"}
_LANG_RE = re.compile(r"^[a-z]{2,3}(_[a-z]{2,8})?(\+[a-z]{2,3}(_[a-z]{2,8})?){0,3}$")


@dataclass(frozen=True)
class OcrSettings:
    enabled: bool = False
    #: ISO 639-1 ("de"), a Tesseract code ("chi_sim"), or several joined with "+".
    language: str = "en"


DEFAULTS = OcrSettings()


def parse_settings(data: object) -> OcrSettings:
    """The settings Core sends, exactly: {enabled: bool, language: str}; a 400 otherwise."""
    if (
        not isinstance(data, dict)
        or set(data) != {"enabled", "language"}
        or not isinstance(data["enabled"], bool)
        or not isinstance(data["language"], str)
        or not _LANG_RE.match(data["language"].strip().lower())
    ):
        raise AncileError(
            "request.invalid",
            "The OCR settings were not in the expected shape",
            "Send enabled (true or false) and language (for example en, de or chi_sim).",
            status=400,
            error_class="permanent",
        )
    return OcrSettings(enabled=data["enabled"], language=data["language"].strip().lower())


# --- engines -------------------------------------------------------------------------


class Reader(Protocol):
    name: str

    def read(self, image: Any) -> str:  # a PIL image
        ...


class _Rapid:
    name = "rapidocr"

    def __init__(self) -> None:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]

        self._engine = RapidOCR()

    def read(self, image: Any) -> str:
        import numpy as np

        result, _ = self._engine(np.asarray(image.convert("RGB")))
        if not result:
            return ""
        # Each hit is [box, text, score]; group into lines by the box's vertical middle.
        rows: list[tuple[float, float, str]] = []
        for box, line, _score in result:
            ys = [p[1] for p in box]
            xs = [p[0] for p in box]
            rows.append(((min(ys) + max(ys)) / 2, min(xs), str(line)))
        rows.sort()
        out: list[str] = []
        height = max((max(r[0] for r in rows) - min(r[0] for r in rows)) / max(len(rows), 1), 1.0)
        last_y = None
        for y, _x, line in rows:
            if last_y is not None and abs(y - last_y) < height * 0.5:
                out[-1] += " " + line
            else:
                out.append(line)
            last_y = y
        return "\n".join(out)


class _Tesseract:
    name = "tesseract"

    def __init__(self, language: str) -> None:
        import pytesseract  # type: ignore[import-not-found]

        pytesseract.get_tesseract_version()  # raises when the program is not installed
        self._t = pytesseract
        self._lang = "+".join(TESSERACT_LANG.get(p, p) for p in language.split("+"))

    def read(self, image: Any) -> str:
        return str(self._t.image_to_string(image, lang=self._lang))


def tesseract_installed() -> bool:
    return shutil.which("tesseract") is not None


def pick_reader(language: str) -> Reader | None:
    """
    The engine for a language: Tesseract when the language needs it and it is installed,
    else RapidOCR, else (a Latin or Chinese scan) whichever exists. None: nothing is installed.
    """
    langs = language.split("+")
    needs_tesseract = any(p not in RAPID_LANGS for p in langs)
    order = ("tesseract", "rapid") if needs_tesseract else ("rapid", "tesseract")
    for which in order:
        try:
            return _Tesseract(language) if which == "tesseract" else _Rapid()
        except Exception:  # not installed, or would not start: try the next
            continue
    return None


def installed() -> dict[str, bool]:
    """What this computer can do, for Settings → Sources: {rapidocr, tesseract}."""
    rapid = False
    try:
        import rapidocr_onnxruntime  # type: ignore[import-not-found]  # noqa: F401

        rapid = True
    except Exception:
        rapid = False
    return {"rapidocr": rapid, "tesseract": tesseract_installed()}


def unavailable() -> AncileError:
    return AncileError(
        "extract.ocr_unavailable",
        "OCR is not installed",
        "Install RapidOCR (uv pip install rapidocr-onnxruntime) or Tesseract on this computer, then retry. "
        "Languages other than Latin letters and Chinese need Tesseract with that language's data.",
        status=422,
        error_class="permanent",
    )


# --- the plan a PDF extraction follows --------------------------------------------------


class OcrPlan:
    """
    What extract_pdf is told: read empty pages, in this language, caching each page's text in
    `cache_dir`. The engine is only started when the first empty page needs it, so a PDF with a
    text layer never pays for it and never fails because OCR is missing.
    """

    def __init__(
        self,
        language: str = "en",
        cache_dir: Path | None = None,
        make_reader: Callable[[str], Reader | None] = pick_reader,
    ) -> None:
        self.language = language
        self.cache_dir = cache_dir
        self._make = make_reader
        self._reader: Reader | None = None
        self.pages_read = 0

    def _engine(self) -> Reader:
        if self._reader is None:
            self._reader = self._make(self.language)
            if self._reader is None:
                raise unavailable()
        return self._reader

    @property
    def engine_name(self) -> str:
        return self._reader.name if self._reader else ""

    def _cache_file(self, page: int) -> Path | None:
        if self.cache_dir is None:
            return None
        return self.cache_dir / f"{self.language}-page-{page:05d}.txt"

    def read_page(self, page: int, render: Callable[[], Any]) -> str:
        """The text of page number `page` (1-based): from the cache, else rendered and read."""
        f = self._cache_file(page)
        if f is not None and f.exists():
            return f.read_text(encoding="utf-8")
        reader = self._engine()
        image = render()
        try:
            out = reader.read(image).replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
        finally:
            close = getattr(image, "close", None)
            if close:
                close()
        out = re.sub(r"[ \t]+\n", "\n", out).strip()
        self.pages_read += 1
        if f is not None:
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_suffix(".tmp")
            tmp.write_text(out, encoding="utf-8", newline="")
            tmp.replace(f)
        return out


# --- the settings, stored ------------------------------------------------------------------


def load() -> OcrSettings:
    with sessions().begin() as db:
        raw = db.execute(text(f"SELECT settings FROM {S}.ocr_settings WHERE id = 1")).scalar()
    if not isinstance(raw, dict):
        return DEFAULTS
    try:
        return parse_settings({"enabled": raw.get("enabled", False), "language": raw.get("language", "en")})
    except AncileError:
        log.warning("stored OCR settings invalid; using the default")
        return DEFAULTS


def store(new: OcrSettings) -> OcrSettings:
    with sessions().begin() as db:
        db.execute(
            text(
                f"INSERT INTO {S}.ocr_settings (id, settings, updated_at) "
                f"VALUES (1, CAST(:s AS jsonb), now()) "
                f"ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()"
            ),
            {"s": json.dumps({"enabled": new.enabled, "language": new.language})},
        )
    log.info("OCR settings stored", enabled=new.enabled, language=new.language)
    return new


def view(s: OcrSettings) -> dict[str, Any]:
    return {"enabled": s.enabled, "language": s.language, "installed": installed()}


router = APIRouter()


@router.get("/maintenance/ocr")
async def get_ocr() -> dict[str, Any]:
    """The settings in force, and which engines this computer has."""
    return view(await asyncio.to_thread(load))


@router.put("/maintenance/ocr")
async def put_ocr(request: Request) -> dict[str, Any]:
    """Replace the settings (Core, at start and after every change)."""
    raw = await request.body()
    try:
        data: object = json.loads(raw)
    except ValueError:
        raise AncileError(
            "request.invalid",
            "The OCR settings were not valid JSON",
            "Send a JSON body with enabled and language.",
            status=400,
            error_class="permanent",
        ) from None
    new = parse_settings(data)
    return view(await asyncio.to_thread(store, new))
