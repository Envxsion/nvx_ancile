import random

import pytest

from ancile_knowledge.sources.dedupe import (
    Candidate,
    classify,
    content_hash,
    find_matches,
    signature,
    similarity,
)

rng = random.Random(3)
VOCAB = [f"w{i}" for i in range(2000)]
BASE = " ".join(rng.choice(VOCAB) for _ in range(800))


def cand(id_, text, **kw):
    return Candidate(id_, content_hash(text), signature(text), **kw)


def test_exact_ignores_whitespace_and_case():
    a = cand("a", BASE)
    b = cand("b", "  " + BASE.upper().replace(" ", "\n  "))
    m = classify(b, a)
    assert m is not None and m.kind == "duplicate"


def test_near_duplicate_with_small_edit():
    words = BASE.split()
    words[400] = "changed"
    m = classify(cand("b", " ".join(words)), cand("a", BASE))
    assert m is not None and m.kind == "near_duplicate" and m.score >= 0.9


def test_new_version_needs_same_origin():
    words = BASE.split()
    edited = " ".join(words[:600] + [rng.choice(VOCAB) for _ in range(200)])
    m = classify(cand("b", edited, uri="https://x.org/p"), cand("a", BASE, uri="https://x.org/p"))
    assert m is not None and m.kind == "new_version"
    assert classify(cand("b", edited, uri="https://other"), cand("a", BASE, uri="https://x.org/p")) is None


def test_unrelated_and_self():
    other = " ".join(rng.choice(VOCAB) for _ in range(800))
    assert classify(cand("b", other), cand("a", BASE)) is None
    a = cand("a", BASE)
    assert classify(a, a) is None


def test_find_matches_orders_best_first():
    a = cand("a", BASE)
    words = BASE.split()
    words[1] = "z"
    b = cand("b", " ".join(words))
    found = find_matches(cand("n", BASE), [b, a])
    assert [m.other_id for m in found] == ["a", "b"]


def test_similarity_requires_equal_lengths():
    with pytest.raises(ValueError):
        similarity([1, 2], [1])
