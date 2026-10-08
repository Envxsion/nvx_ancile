"""
------------------------------------------------------------------
 Title    |  Contextual enrichment
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Contextual retrieval: a short blurb per chunk that
          |  situates it in its document, prepended for both embedding
          |  and full-text indexing, plus the source's summary.
 How      |  No model calls in phase 3 (the dev stack only has an
          |  offline test model):
          |    blurb    = source title › heading path
          |    summary  = extractive: the first substantive
          |               paragraphs, cut at a sentence, ≤ 600 chars
 Note     |  TODO(phase-4): model-written blurbs and insights through
          |  Core's Gateway (core_client.chat, task_class='utility'),
          |  batched with bounded concurrency, never failing ingestion
          |  for a failed blurb. The seams are blurb_for() and
          |  extractive_summary(); KNOWLEDGE_CONTEXTUAL_CHUNKS gates it.
------------------------------------------------------------------
"""

from __future__ import annotations

import re

PROMPT_PATH = "prompts/knowledge/contextual-chunk.md"
SUMMARY_CHARS = 600
SUMMARY_MODEL = "extractive"
SUMMARY_TRANSFORMATION = "summary"

_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*\s+")
_MD_NOISE = re.compile(r"!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)|[*_`]{1,3}")


def embedding_text(blurb: str | None, chunk_text: str) -> str:
    """What actually gets embedded: blurb first, then the chunk."""
    return f"{blurb}\n\n{chunk_text}" if blurb else chunk_text


def blurb_for(title: str, heading_path: list[str]) -> str:
    """Source title and where in it the chunk sits: "Annual report › Results › Q3"."""
    parts = [title.strip(), *(h.strip() for h in heading_path if h.strip())]
    # A heading equal to the title adds nothing.
    if len(parts) > 1 and parts[1].casefold() == parts[0].casefold():
        parts.pop(1)
    return " › ".join(p for p in parts if p)


def _is_substantive(block: str) -> bool:
    first = block.lstrip()
    if not first or first.startswith(("#", "```", "~~~", "|", ">", "<", "---", "***", "![")):
        return False
    if re.match(r"^([-*+]|\d+[.)])\s", first):
        return False
    words = re.findall(r"\w+", block)
    return len(words) >= 8 and len(block) >= 60


def _plain(block: str) -> str:
    text = _MD_NOISE.sub(lambda m: m.group(1) or "", block)
    return re.sub(r"\s+", " ", text).strip()


def extractive_summary(markdown: str, limit: int = SUMMARY_CHARS) -> str | None:
    """The first substantive paragraph(s), cut at a sentence boundary."""
    out = ""
    for block in re.split(r"\n\s*\n", markdown):
        if not _is_substantive(block):
            continue
        para = _plain(block)
        candidate = f"{out} {para}".strip() if out else para
        if len(candidate) <= limit:
            out = candidate
            if len(out) >= limit * 0.6:
                break
            continue
        if out:
            break
        # One long paragraph: keep whole sentences up to the limit.
        cut = ""
        for m in _SENTENCE_END.finditer(para):
            if m.start() > limit:
                break
            cut = para[: m.start()]
        out = cut or (para[: limit - 1].rsplit(" ", 1)[0] + "…")
        break
    return out or None
