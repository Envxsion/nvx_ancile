"""
------------------------------------------------------------------
 Title    |  Evidence: passages for each claim, with quotes
 Ref      |  DESIGN.md §10 (step 2) · contracts EvidenceRequest
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  A fact-check asks one question per claim: which passages
          |  in this notebook bear on it, and which sentence in each
          |  is the one to show? The answer carries the quote's exact
          |  span in the source, so the Cockpit can open on it.
 How      |  For each claim: the same scoped hybrid search a chat turn
          |  uses (vector + text, fused, reranked), then
          |    quote      the sentence of the passage sharing most
          |               content words with the claim
          |    relevance  0.6 × rerank score + 0.4 × term overlap
          |               (overlap alone without a reranker)
          |    coverage   share of the claim's content words found
          |               anywhere in its passages
          |  Numbers count as content words at any length: a claim
          |  about "4410" must find "4410".
 Note     |  Pure helpers (terms, best_quote, coverage) are tested
          |  without a database.
------------------------------------------------------------------
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

from ..offsets import u16_len
from . import service as search_service

STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "being",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "may",
        "might",
        "more",
        "most",
        "must",
        "no",
        "not",
        "of",
        "on",
        "or",
        "our",
        "she",
        "should",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "to",
        "too",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "also",
        "about",
        "after",
        "before",
        "between",
        "both",
        "each",
        "few",
        "other",
        "over",
        "same",
        "through",
        "under",
        "until",
        "up",
        "down",
        "out",
        "off",
        "again",
        "further",
        "once",
        "only",
        "own",
        "just",
    ]
)

_WORD = re.compile(r"[A-Za-z][A-Za-z'-]*|\d+(?:[.,]\d+)*")
_SENTENCE = re.compile(r"[^.!?\n]+(?:[.!?]+|$)")


def terms(text: str) -> list[str]:
    """Content words, lowercased, in order, without repeats."""
    out: list[str] = []
    for w in _WORD.findall(text):
        t = w.lower().strip("'-")
        if not t or t in STOPWORDS:
            continue
        if not t[0].isdigit() and len(t) < 3:
            continue
        if t not in out:
            out.append(t)
    return out


def _stem(t: str) -> str:
    # Enough to match "pumps" with "pump" and "primed" with "prime".
    for suf in ("ing", "ed", "es", "s"):
        if len(t) > len(suf) + 3 and t.endswith(suf):
            t = t[: -len(suf)]
            break
    return t[:-1] if len(t) > 4 and t.endswith("e") else t


def overlap(claim_terms: list[str], text: str) -> float:
    """Share of the claim's content words present in text."""
    if not claim_terms:
        return 0.0
    have = {_stem(t) for t in terms(text)}
    return sum(1 for t in claim_terms if _stem(t) in have) / len(claim_terms)


def best_quote(text: str, claim: str) -> tuple[str, int, int]:
    """The sentence of text that shares most content words with claim, and its offsets."""
    ct = terms(claim)
    best: tuple[float, int, int] | None = None
    for m in _SENTENCE.finditer(text):
        raw = m.group(0)
        lead = len(raw) - len(raw.lstrip())
        start, end = m.start() + lead, m.end()
        seg = text[start:end].rstrip()
        if len(seg) < 3 or seg.lstrip().startswith("#"):
            continue
        score = overlap(ct, seg)
        if best is None or score > best[0]:
            best = (score, start, start + len(seg))
    if best is None:
        s = text.strip()[:280]
        i = text.find(s) if s else 0
        return s, max(i, 0), max(i, 0) + len(s)
    _, start, end = best
    if end - start > 400:
        end = start + 400
    return text[start:end], start, end


def coverage(claim: str, texts: list[str]) -> float:
    return overlap(terms(claim), "\n".join(texts))


@dataclass
class EvidenceQuery:
    workspace_id: str
    claims: list[str]
    notebook_id: str | None = None
    k_per_claim: int = 4


def evidence(q: EvidenceQuery) -> dict[str, Any]:
    started = time.perf_counter()
    results: list[dict[str, Any]] = []
    mode, embedder = "hybrid", None
    for claim in q.claims:
        res = search_service.search(
            search_service.Query(
                workspace_id=q.workspace_id,
                query=claim[:4000],
                notebook_id=q.notebook_id,
                k=q.k_per_claim,
                mode="hybrid",
                rerank=True,
            )
        )
        mode, embedder = res["mode"], res["embedder"]
        ct = terms(claim)
        hits: list[dict[str, Any]] = []
        for h in res["hits"]:
            quote, qs, qe = best_quote(h["text"], claim)
            lex = overlap(ct, h["text"])
            rr = h.get("rerank_score")
            relevance = 0.6 * float(rr) + 0.4 * lex if rr is not None else lex
            hits.append(
                {
                    "kind": h["kind"],
                    "chunk_id": h["chunk_id"],
                    "source_id": h["source_id"],
                    "source_title": h["source_title"],
                    "page": h["page"],
                    "heading_path": h["heading_path"],
                    "text": h["text"],
                    "quote": quote,
                    # h's offsets are already UTF-16 (search); qs/qe are code points into its text.
                    "quote_start": h["char_start"] + u16_len(h["text"][:qs]),
                    "quote_end": h["char_start"] + u16_len(h["text"][:qe]),
                    "rerank_score": rr,
                    "relevance": round(min(1.0, max(0.0, relevance)), 6),
                }
            )
        hits.sort(key=lambda x: -x["relevance"])
        results.append(
            {
                "claim": claim,
                "hits": hits,
                "coverage": round(coverage(claim, [h["text"] for h in hits]), 6),
            }
        )
    return {
        "results": results,
        "mode": mode,
        "embedder": embedder,
        "ms": round((time.perf_counter() - started) * 1000, 1),
    }
