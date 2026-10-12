"""
------------------------------------------------------------------
 Title    |  Source language
 Ref      |  ROADMAP.md track G ("Mixed languages") · docs/sources.md
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Say which language a source is mostly written in, so a
          |  notebook that mixes languages can be told when its
          |  embedder reads only English, and offered a multilingual
          |  one.
 How      |  py3langid (BSD-3-Clause, a maintained fork of langid.py)
          |  over up to three samples of the extracted text (start,
          |  middle, end) with code, links and markup removed. Each
          |  sample votes with its probability; the language with the
          |  most weight wins if it is confident enough. Too little
          |  text, or no clear winner, is None: "unknown" is honest.
 Note     |  The model ships inside the wheel (about 4 MB); nothing is
          |  downloaded. Without the package, detection is skipped.
------------------------------------------------------------------
"""

from __future__ import annotations

import re
import threading
from typing import Any

from ..obs import get_logger

log = get_logger("language")

SAMPLE_CHARS = 2_000
MIN_LETTERS = 40
MIN_CONFIDENCE = 0.6

# Embedding models that read only English well. Anything not known to be
# multilingual is treated as English-only: a missed hint costs little.
MULTILINGUAL_HINTS = ("multilingual", "-m3", "labse", "xlm", "e5-large-multi", "potion-multilingual")

_lock = threading.Lock()
_identifier: Any = None
_unavailable = False

_CODE = re.compile(r"```.*?(?:```|$)|`[^`\n]*`", re.S)
_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)|https?://\S+|www\.\S+")
_MARKUP = re.compile(r"[#>*_|~=\-]{1,}|<[^>]{1,200}>")


def _get() -> Any:
    global _identifier, _unavailable
    if _identifier is not None or _unavailable:
        return _identifier
    with _lock:
        if _identifier is None and not _unavailable:
            try:
                from py3langid.langid import MODEL_FILE, LanguageIdentifier

                _identifier = LanguageIdentifier.from_model_file(MODEL_FILE, norm_probs=True)
            except Exception as exc:  # the package is optional at runtime
                _unavailable = True
                log.warning("language detection unavailable", error=type(exc).__name__)
    return _identifier


def clean(text: str) -> str:
    text = _CODE.sub(" ", text)
    text = _LINK.sub(r" \1 ", text)
    text = _MARKUP.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def samples(text: str) -> list[str]:
    """Start, middle and end of the text, so a long document's front matter cannot decide alone."""
    if len(text) <= SAMPLE_CHARS * 3:
        return [text]
    mid = len(text) // 2 - SAMPLE_CHARS // 2
    return [text[:SAMPLE_CHARS], text[mid : mid + SAMPLE_CHARS], text[-SAMPLE_CHARS:]]


def detect(markdown: str) -> str | None:
    """ISO 639-1 code of the main language, or None when it cannot be told."""
    text = clean(markdown)
    if sum(ch.isalpha() for ch in text[: SAMPLE_CHARS * 3]) < MIN_LETTERS:
        return None
    ident = _get()
    if ident is None:
        return None
    weight: dict[str, float] = {}
    parts = samples(text)
    for part in parts:
        if sum(ch.isalpha() for ch in part) < MIN_LETTERS:
            continue
        lang, prob = ident.classify(part)
        weight[str(lang)] = weight.get(str(lang), 0.0) + float(prob)
    if not weight:
        return None
    lang, total = max(weight.items(), key=lambda kv: kv[1])
    return lang if total / len(parts) >= MIN_CONFIDENCE else None


def is_multilingual(model: str) -> bool:
    m = model.lower()
    return any(h in m for h in MULTILINGUAL_HINTS)
