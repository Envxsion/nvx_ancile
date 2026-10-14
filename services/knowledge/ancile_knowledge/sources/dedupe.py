"""
------------------------------------------------------------------
 Title    |  Duplicate detection
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Offer to merge when the same document arrives twice, and
          |  notice when a "new" source is really a new version of an
          |  old one (DESIGN.md §13.6).
 How      |  Exact: sha256 of normalised text (NFKC, collapsed
          |  whitespace, case-folded). Near: MinHash over 5-word
          |  shingles, 128 permutations; estimated Jaccard decides.
          |    ≥ near (0.90 by default)     near_duplicate
          |    ≥ 0.50 and same uri/title    new_version
          |  near is the duplicate_sources automation's
          |  near_duplicate_percent / 100 (automations.py); at 0.50 the
          |  new_version band is empty. Signatures are plain int lists
          |  so they persist in JSONB and can feed an LSH index later.
------------------------------------------------------------------
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from datasketch import MinHash

NUM_PERM = 128
SHINGLE = 5
NEAR_DUPLICATE = 0.90
NEW_VERSION = 0.50

Relation = Literal["duplicate", "near_duplicate", "new_version"]

_WS = re.compile(r"\s+")
_WORD = re.compile(r"\w+")


def normalise(text: str) -> str:
    return _WS.sub(" ", unicodedata.normalize("NFKC", text)).strip().casefold()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalise(text).encode("utf-8")).hexdigest()


def shingles(text: str, size: int = SHINGLE) -> set[str]:
    words = _WORD.findall(normalise(text))
    if len(words) < size:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i : i + size]) for i in range(len(words) - size + 1)}


def signature(text: str) -> list[int]:
    m = MinHash(num_perm=NUM_PERM, seed=7)
    for sh in shingles(text):
        m.update(sh.encode("utf-8"))
    return [int(v) for v in m.hashvalues]


def similarity(sig_a: list[int], sig_b: list[int]) -> float:
    if len(sig_a) != len(sig_b) or not sig_a:
        raise ValueError("signatures must be the same non-zero length")
    return sum(1 for a, b in zip(sig_a, sig_b, strict=True) if a == b) / len(sig_a)


@dataclass(frozen=True)
class Candidate:
    id: str
    hash: str
    sig: list[int]
    uri: str | None = None
    title: str | None = None


@dataclass(frozen=True)
class Match:
    other_id: str
    kind: Relation
    score: float


def _same_origin(a: Candidate, b: Candidate) -> bool:
    if a.uri and b.uri and a.uri == b.uri:
        return True
    return bool(a.title and b.title and normalise(a.title) == normalise(b.title))


def classify(new: Candidate, existing: Candidate, near: float = NEAR_DUPLICATE) -> Match | None:
    if new.id == existing.id:
        return None
    if new.hash == existing.hash:
        return Match(existing.id, "duplicate", 1.0)
    score = similarity(new.sig, existing.sig)
    if score >= near:
        return Match(existing.id, "near_duplicate", score)
    if score >= NEW_VERSION and _same_origin(new, existing):
        return Match(existing.id, "new_version", score)
    return None


def find_matches(new: Candidate, pool: list[Candidate], near: float = NEAR_DUPLICATE) -> list[Match]:
    """Best match first. Linear scan; swap for MinHash LSH past ~50k sources."""
    if not NEW_VERSION <= near <= 1:
        raise ValueError(f"near-duplicate threshold must be between {NEW_VERSION} and 1, not {near}")
    found = [m for m in (classify(new, c, near) for c in pool) if m is not None]
    order = {"duplicate": 0, "near_duplicate": 1, "new_version": 2}
    return sorted(found, key=lambda m: (order[m.kind], -m.score, m.other_id))
