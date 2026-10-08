"""
------------------------------------------------------------------
 Title    |  Offsets for JavaScript readers
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Python indexes strings by code point; the Cockpit and
          |  Core index them by UTF-16 code unit. They agree until the
          |  first character outside the Basic Multilingual Plane (an
          |  emoji, a maths letter like 𝑥, some CJK), after which every
          |  highlight would land one unit early per such character.
 How      |  Everything stored and computed here stays in code points.
          |  At the API boundary each offset into a source's markdown
          |  goes through a U16Map: identity for the usual all-BMP
          |  text, otherwise a binary search over the astral
          |  positions. Maps are cached per (source, version), since a
          |  version's markdown never changes.
------------------------------------------------------------------
"""

from __future__ import annotations

import re
from bisect import bisect_left
from collections.abc import Callable
from functools import lru_cache

_ASTRAL = re.compile("[\U00010000-\U0010ffff]")


class U16Map:
    """Code-point index -> UTF-16 index for one text."""

    __slots__ = ("_astral",)

    def __init__(self, text: str) -> None:
        self._astral: list[int] = [m.start() for m in _ASTRAL.finditer(text)]

    def __call__(self, i: int) -> int:
        if not self._astral or i <= 0:
            return i
        # Each astral character before i adds one extra UTF-16 unit.
        return i + bisect_left(self._astral, i)


def u16_len(text: str) -> int:
    """Length of `text` in UTF-16 code units."""
    return len(text) + len(_ASTRAL.findall(text))


_IDENTITY: Callable[[int], int] = lambda i: i  # noqa: E731


@lru_cache(maxsize=128)
def _cached(source_id: str, version: int) -> Callable[[int], int]:
    from .sources import repo  # late: repo imports settings

    try:
        text = repo.read_markdown(repo.markdown_path(source_id, version))
    except OSError:
        return _IDENTITY
    m = U16Map(text)
    return m if m._astral else _IDENTITY


def for_version(source_id: str, version: int | None) -> Callable[[int], int]:
    """The converter for a stored version's markdown (identity if it cannot be read)."""
    if version is None or version <= 0:
        return _IDENTITY
    return _cached(source_id, int(version))
