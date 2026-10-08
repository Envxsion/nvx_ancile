"""
------------------------------------------------------------------
 Title    |  Automatic tags
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Up to five keywords per source, so a new URL or file is
          |  tagged without anyone typing (DESIGN.md §13.6).
 How      |  TF-IDF without a model: term counts for the source (words
          |  of 3+ letters, stopwords dropped, title words weighted),
          |  document frequency from the other sources in the same
          |  workspace (their top terms, kept in sources.topics). A term
          |  that appears in every source is not a useful tag.
 Note     |  TODO(phase-4): model-suggested tags and topic clusters via
          |  Core's Gateway; /tags/recompute to refresh a workspace.
------------------------------------------------------------------
"""

from __future__ import annotations

import math
import re
from collections import Counter

MAX_TAGS = 5
TOP_TERMS = 40

_WORD = re.compile(r"[A-Za-z][A-Za-z0-9+#.-]*[A-Za-z0-9+#]|[A-Za-z]{3,}")
_STOP = frozenset(
    """
    a about above after again against all also am an and any are aren't as at be because been before
    being below between both but by can cannot could did do does doing down during each few for from
    further had has have having he her here hers herself him himself his how however i if in into is
    it its itself just let like make made many may me more most much must my myself no nor not now
    of off on once one only or other ought our ours ourselves out over own per same she should so
    some such than that the their theirs them themselves then there these they this those through to
    too under until up upon us use used using very via was we were what when where which while who
    whom why will with within without would yet you your yours yourself yourselves new well two
    three first second get got see seen says said say http https www com org html page pages section
    figure table chapter part example examples etc ie eg
    """.split()  # noqa: SIM905 (a word list reads better as text)
)


def terms(text: str, title: str = "") -> Counter[str]:
    """Lower-cased content terms with counts; title words count three times."""
    counts: Counter[str] = Counter()
    for source, weight in ((text, 1), (title, 3)):
        for raw in _WORD.findall(source):
            word = raw.strip(".-").lower()
            if len(word) < 3 or word in _STOP or word.isdigit():
                continue
            counts[word] += weight
    return counts


def top_terms(counts: Counter[str], n: int = TOP_TERMS) -> dict[str, int]:
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n])


def pick_tags(counts: Counter[str], doc_freq: dict[str, int], n_docs: int, k: int = MAX_TAGS) -> list[str]:
    """
    tf-idf with sublinear tf. doc_freq counts other sources containing the
    term among their top terms; n_docs is how many sources were counted.
    """
    if not counts:
        return []
    scored: list[tuple[float, str]] = []
    for term, tf in counts.items():
        if tf < 2 and len(counts) > 20:
            continue  # a single mention is rarely what a document is about
        idf = math.log((n_docs + 1) / (doc_freq.get(term, 0) + 1)) + 1
        scored.append(((1 + math.log(tf)) * idf, term))
    scored.sort(key=lambda st: (-st[0], st[1]))
    return [t for _, t in scored[:k]]
