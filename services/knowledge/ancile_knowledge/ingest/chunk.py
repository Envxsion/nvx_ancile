"""
------------------------------------------------------------------
 Title    |  Structure-aware chunking
 Ref      |  DESIGN.md §3.2 (chunks), §10 (citations)
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Turn a source's markdown into retrieval chunks whose
          |  offsets are exact, so a citation can highlight the very
          |  span the model read.
 How      |  1. Scan markdown into blocks: headings, fenced code
          |     (atomic), paragraphs/lists/tables, with offsets.
          |  2. Group blocks into sections by heading; each section
          |     knows its heading path ["Methods", "Sampling"].
          |  3. Break blocks into units: whole blocks when they fit,
          |     else sentences, else word windows; code by lines.
          |  4. Pack units greedily into child chunks within a section,
          |     carrying trailing units forward as overlap.
          |  5. Parent chunks are whole sections (split when huge):
          |     retrieve on children, expand to parents for context.
 Note     |  Invariant, tested: source[c.char_start:c.char_end] == c.text
          |  for every chunk. Chunks never cross a heading boundary.
------------------------------------------------------------------
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

_WORDISH = re.compile(r"\w+|[^\w\s]")
_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
# A sentence ends at . ! ? (optionally followed by closing quotes/brackets) then whitespace.
_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*\s+")


def count_tokens(text: str) -> int:
    """Approximate token count: words and punctuation. Close enough for packing,
    and deterministic. Swap in tiktoken via ChunkConfig.tokenizer if needed."""
    return len(_WORDISH.findall(text))


@dataclass(frozen=True)
class ChunkConfig:
    max_tokens: int = 512
    overlap_tokens: int = 64
    parent_max_tokens: int = 2048
    tokenizer: Callable[[str], int] = count_tokens

    def __post_init__(self) -> None:
        if self.max_tokens < 16:
            raise ValueError("max_tokens must be at least 16")
        if not 0 <= self.overlap_tokens < self.max_tokens:
            raise ValueError("overlap_tokens must be >= 0 and smaller than max_tokens")
        if self.parent_max_tokens < self.max_tokens:
            raise ValueError("parent_max_tokens must be >= max_tokens")


@dataclass
class ChunkSpan:
    ordinal: int
    text: str
    char_start: int
    char_end: int
    heading_path: list[str]
    tokens: int
    kind: str  # "child" | "parent"
    parent_ordinal: int | None = None


@dataclass
class ChunkResult:
    parents: list[ChunkSpan] = field(default_factory=list)
    children: list[ChunkSpan] = field(default_factory=list)


@dataclass
class _Block:
    start: int
    end: int
    kind: str  # heading | code | text


@dataclass
class _Section:
    heading_path: list[str]
    blocks: list[_Block]


@dataclass
class _Unit:
    start: int
    end: int
    tokens: int


def _trim(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def _scan_blocks(text: str) -> list[tuple[_Block, int | None, str | None]]:
    """Blocks with (heading level, heading text) for headings."""
    out: list[tuple[_Block, int | None, str | None]] = []
    lines = text.splitlines(keepends=True)
    pos = 0
    i = 0
    para_start: int | None = None

    def flush(end: int) -> None:
        nonlocal para_start
        if para_start is not None:
            s, e = _trim(text, para_start, end)
            if s < e:
                out.append((_Block(s, e, "text"), None, None))
        para_start = None

    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip("\r\n")
        fence = _FENCE.match(stripped)
        if fence:
            flush(pos)
            marker = fence.group(1)
            start = pos
            pos += len(line)
            i += 1
            while i < len(lines):
                closing = lines[i].rstrip("\r\n").strip()
                pos += len(lines[i])
                i += 1
                if closing.startswith(marker[0] * len(marker)) and set(closing) <= {marker[0]}:
                    break
            s, e = _trim(text, start, pos)
            out.append((_Block(s, e, "code"), None, None))
            continue
        heading = _HEADING.match(stripped)
        if heading:
            flush(pos)
            s, e = _trim(text, pos, pos + len(stripped))
            out.append((_Block(s, e, "heading"), len(heading.group(1)), heading.group(2).strip()))
        elif stripped.strip() == "":
            flush(pos)
        elif para_start is None:
            para_start = pos
        pos += len(line)
        i += 1
    flush(pos)
    return out


def _sections(text: str) -> list[_Section]:
    sections: list[_Section] = []
    stack: list[tuple[int, str]] = []
    current = _Section([], [])
    for block, level, title in _scan_blocks(text):
        if block.kind == "heading" and level is not None and title is not None:
            if current.blocks:
                sections.append(current)
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            current = _Section([t for _, t in stack], [block])
        else:
            current.blocks.append(block)
    if current.blocks:
        sections.append(current)
    return sections


def _split_words(text: str, start: int, end: int, cfg: ChunkConfig) -> list[_Unit]:
    units: list[_Unit] = []
    words = [(m.start() + start, m.end() + start) for m in re.finditer(r"\S+", text[start:end])]
    i = 0
    while i < len(words):
        j = i
        s = words[i][0]
        e = words[i][1]
        while j + 1 < len(words) and cfg.tokenizer(text[s : words[j + 1][1]]) <= cfg.max_tokens:
            j += 1
            e = words[j][1]
        units.append(_Unit(s, e, cfg.tokenizer(text[s:e])))
        i = j + 1
    return units


def _units_for_block(text: str, block: _Block, cfg: ChunkConfig) -> list[_Unit]:
    tokens = cfg.tokenizer(text[block.start : block.end])
    if tokens <= cfg.max_tokens:
        return [_Unit(block.start, block.end, tokens)]
    pieces: list[tuple[int, int]] = []
    if block.kind == "code":
        offset = block.start
        for line in text[block.start : block.end].splitlines(keepends=True):
            pieces.append((offset, offset + len(line)))
            offset += len(line)
    else:
        seg_start = block.start
        for m in _SENTENCE_END.finditer(text, block.start, block.end):
            pieces.append((seg_start, m.start()))
            seg_start = m.end()
        pieces.append((seg_start, block.end))
    units: list[_Unit] = []
    for s, e in pieces:
        s, e = _trim(text, s, e)
        if s >= e:
            continue
        t = cfg.tokenizer(text[s:e])
        if t <= cfg.max_tokens:
            units.append(_Unit(s, e, t))
        else:
            units.extend(_split_words(text, s, e, cfg))
    return units


def _pack(text: str, units: list[_Unit], limit: int, overlap: int, cfg: ChunkConfig) -> list[tuple[int, int]]:
    """Greedy packing by the real token count of the joined span (separators count too)."""
    windows: list[tuple[int, int]] = []
    i = 0
    while i < len(units):
        j = i
        while j + 1 < len(units) and cfg.tokenizer(text[units[i].start : units[j + 1].end]) <= limit:
            j += 1
        windows.append((units[i].start, units[j].end))
        if j + 1 >= len(units):
            break
        # Carry trailing units forward as overlap, but always advance.
        k = j + 1
        carried = 0
        while k - 1 > i and carried + units[k - 1].tokens <= overlap:
            carried += units[k - 1].tokens
            k -= 1
        i = k
    return windows


def chunk_markdown(text: str, cfg: ChunkConfig | None = None) -> ChunkResult:
    cfg = cfg or ChunkConfig()
    result = ChunkResult()
    ordinal = 0
    for section in _sections(text):
        units: list[_Unit] = []
        for block in section.blocks:
            units.extend(_units_for_block(text, block, cfg))
        if not units:
            continue
        parent_windows = _pack(text, units, cfg.parent_max_tokens, 0, cfg)
        parent_ordinals: list[tuple[int, int, int]] = []
        for s, e in parent_windows:
            span = ChunkSpan(
                ordinal, text[s:e], s, e, list(section.heading_path), cfg.tokenizer(text[s:e]), "parent"
            )
            result.parents.append(span)
            parent_ordinals.append((s, e, ordinal))
            ordinal += 1
        for s, e in _pack(text, units, cfg.max_tokens, cfg.overlap_tokens, cfg):
            parent = next((o for ps, pe, o in parent_ordinals if ps <= s and e <= pe), None)
            if parent is None:  # overlap straddled two parents: attach to where it starts
                parent = next(o for ps, pe, o in parent_ordinals if ps <= s < pe)
            result.children.append(
                ChunkSpan(
                    ordinal,
                    text[s:e],
                    s,
                    e,
                    list(section.heading_path),
                    cfg.tokenizer(text[s:e]),
                    "child",
                    parent,
                )
            )
            ordinal += 1
    return result


def outline(text: str) -> list[dict[str, object]]:
    """Headings with their offsets, for a source viewer's outline."""
    return [
        {"level": level, "title": title, "char_start": block.start}
        for block, level, title in _scan_blocks(text)
        if block.kind == "heading" and level is not None and title is not None
    ]
