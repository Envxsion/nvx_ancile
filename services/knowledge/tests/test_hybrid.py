import pytest

from ancile_knowledge.search.hybrid import reciprocal_rank_fusion


def test_items_in_both_rankings_win():
    fused = reciprocal_rank_fusion({"text": ["a", "b", "c"], "vector": ["c", "a", "d"]})
    assert [f.id for f in fused][:2] == ["a", "c"]
    assert fused[0].ranks == {"text": 1, "vector": 2}


def test_scores_match_formula():
    fused = reciprocal_rank_fusion({"t": ["x"], "v": ["x"]}, k=60)
    assert fused[0].score == pytest.approx(2 / 61)


def test_duplicates_within_a_ranking_count_once():
    fused = reciprocal_rank_fusion({"t": ["a", "a", "b"]})
    assert fused[0].score == pytest.approx(1 / 61)
    assert fused[1].ranks["t"] == 2


def test_weights_and_limit():
    fused = reciprocal_rank_fusion({"t": ["a"], "v": ["b"]}, weights={"t": 0.5, "v": 1.0}, limit=1)
    assert [f.id for f in fused] == ["b"]


def test_deterministic_tie_break():
    fused = reciprocal_rank_fusion({"t": ["b", "a"], "v": ["a", "b"]})
    assert fused[0].score == fused[1].score
    assert [f.id for f in fused] == ["a", "b"]


def test_empty_and_invalid():
    assert reciprocal_rank_fusion({}) == []
    with pytest.raises(ValueError):
        reciprocal_rank_fusion({"t": ["a"]}, k=0)
    with pytest.raises(ValueError):
        reciprocal_rank_fusion({"t": ["a"]}, weights={"t": -1})
