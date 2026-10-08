"""Chunking invariants (ROADMAP phase 3): exact offsets, headings, overlap, parents."""

import pytest

from ancile_knowledge.ingest.chunk import ChunkConfig, chunk_markdown, count_tokens

DOC = """# Report

Intro paragraph about the study. It has two sentences.

## Methods

We sampled 400 participants. Each one completed a survey.

### Sampling

Stratified by region and age.

```python
# a heading inside code is not a heading
def f():
    return 1
```

## Results

Results were significant.
"""


def _all(res):
    return res.parents + res.children


def test_offsets_are_exact():
    res = chunk_markdown(DOC)
    assert res.children
    for c in _all(res):
        assert DOC[c.char_start : c.char_end] == c.text
        assert c.text.strip() == c.text


def test_heading_paths_follow_structure():
    res = chunk_markdown(DOC)
    paths = {tuple(c.heading_path) for c in res.children}
    assert ("Report",) in paths
    assert ("Report", "Methods") in paths
    assert ("Report", "Methods", "Sampling") in paths
    assert ("Report", "Results") in paths


def test_code_fence_heading_is_not_a_section():
    res = chunk_markdown(DOC)
    assert not any("a heading inside code" in p for c in res.children for p in c.heading_path)
    code = [c for c in res.children if "def f()" in c.text]
    assert code and code[0].heading_path == ["Report", "Methods", "Sampling"]


def test_chunks_never_cross_headings():
    res = chunk_markdown(DOC)
    for c in res.children:
        body = c.text.splitlines()[1:]
        assert not any(line.startswith("## ") for line in body)


def test_children_point_at_containing_parent():
    res = chunk_markdown(DOC)
    parents = {p.ordinal: p for p in res.parents}
    for c in res.children:
        p = parents[c.parent_ordinal]
        assert p.char_start <= c.char_start < p.char_end
        assert p.heading_path == c.heading_path


def test_ordinals_unique():
    res = chunk_markdown(DOC)
    ords = [c.ordinal for c in _all(res)]
    assert len(ords) == len(set(ords))


def test_long_paragraph_splits_with_overlap_and_limit():
    sentences = " ".join(f"Sentence number {i} talks about topic {i % 7}." for i in range(300))
    text = f"# Long\n\n{sentences}\n"
    cfg = ChunkConfig(max_tokens=80, overlap_tokens=16, parent_max_tokens=400)
    res = chunk_markdown(text, cfg)
    assert len(res.children) > 5
    for c in res.children:
        assert text[c.char_start : c.char_end] == c.text
        assert c.tokens <= cfg.max_tokens
    pairs = list(zip(res.children, res.children[1:], strict=False))
    assert all(b.char_start < a.char_end for a, b in pairs), "consecutive children overlap"
    starts = [c.char_start for c in res.children]
    assert starts == sorted(starts) and len(set(starts)) == len(starts), "always advances"


def test_giant_single_sentence_falls_back_to_word_windows():
    text = "# W\n\n" + " ".join(f"word{i}" for i in range(1000))
    res = chunk_markdown(text, ChunkConfig(max_tokens=50, overlap_tokens=0, parent_max_tokens=200))
    assert all(c.tokens <= 50 for c in res.children)
    joined = " ".join(c.text for c in res.children)
    assert "word0" in joined and "word999" in joined


def test_no_overlap_partitions_text():
    text = "# A\n\n" + "\n\n".join(f"Paragraph {i} " + "x " * 30 for i in range(20))
    res = chunk_markdown(text, ChunkConfig(max_tokens=64, overlap_tokens=0, parent_max_tokens=128))
    for a, b in zip(res.children, res.children[1:], strict=False):
        assert a.char_end <= b.char_start


def test_empty_and_heading_only_documents():
    assert chunk_markdown("").children == []
    res = chunk_markdown("# Only a title\n")
    assert len(res.children) == 1 and res.children[0].text == "# Only a title"


def test_crlf_offsets():
    text = "# T\r\n\r\nLine one.\r\nLine two.\r\n\r\n## U\r\n\r\nBody.\r\n"
    res = chunk_markdown(text)
    for c in _all(res):
        assert text[c.char_start : c.char_end] == c.text
    assert ["T", "U"] in [c.heading_path for c in res.children]


def test_config_validation():
    with pytest.raises(ValueError):
        ChunkConfig(max_tokens=100, overlap_tokens=100)
    with pytest.raises(ValueError):
        ChunkConfig(max_tokens=100, parent_max_tokens=50)


def test_count_tokens():
    assert count_tokens("Hello, world!") == 4
