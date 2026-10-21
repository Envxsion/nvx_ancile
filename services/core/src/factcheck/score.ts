/**
 * ------------------------------------------------------------------
 *  Title    |  Confidence score
 *  Ref      |  DESIGN.md §10, config/factcheck.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One number per claim, and one per message, that a person
 *           |  can have explained to them in words: how well the sources
 *           |  support it, whether an independent model agrees, and how
 *           |  good the retrieval behind it was.
 *  How      |  confidence = w_s·support + w_a·agreement + w_r·retrieval
 *           |  support    = squash(Σ rerank_score × stance)
 *           |  agreement  = 1 agree · 0.75 partly · 0.5 insufficient · 0 contradicted
 *           |  retrieval  = mean(top-3 rerank) × coverage
 *           |  The verdict is not read off that number. It follows the
 *           |  checker's stance: contradicted if it (or the evidence it
 *           |  marked) contradicts; verified if every checker says
 *           |  supported, a passage backs the claim and the checker is
 *           |  not under `verified` sure of itself; else unverified.
 *           |  "Partly" (mostly right with a nuance: rounded, approximate,
 *           |  a minor outdated detail, true only in part) is a verdict of
 *           |  its own between verified and contradicted. Every checker
 *           |  must say supported or partly, and at least one partly, on
 *           |  the same evidence test as verified. In the message score a
 *           |  partly claim counts half (PARTLY_CREDIT); it never seals.
 *           |  A passage that states a claim outright is verified at
 *           |  whatever its retrieval score, and the number is shown
 *           |  beside the verdict, not instead of it.
 * ------------------------------------------------------------------
 */

export type Stance = 'supports' | 'contradicts' | 'neutral';
export type VerifierVerdict = 'supported' | 'partly' | 'contradicted' | 'insufficient';
export type ClaimVerdict = 'verified' | 'partly' | 'unverified' | 'contradicted' | 'not_checkable';

/** How much of a pass a "partly" claim earns in the answer's score: half. */
export const PARTLY_CREDIT = 0.5;

export interface Evidence {
  stance: Stance;
  /** Reranker score in [0, 1]. */
  score: number;
}

export interface ScoreWeights {
  support: number;
  agreement: number;
  retrieval: number;
}

export interface ScoreThresholds {
  /** Contradicting evidence mass above this makes a claim contradicted. */
  contradict: number;
  /**
   * The least sure a checker that says "supported" may be for the claim to be verified (its own
   * confidence, 0 to 1). A checker that gave none is not second-guessed.
   */
  verified: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { support: 0.5, agreement: 0.3, retrieval: 0.2 };
export const DEFAULT_THRESHOLDS: ScoreThresholds = { contradict: 0.5, verified: 0.5 };

/**
 * A source passage whose relevance to a claim is under this is not evidence for it. Relevance is
 * 0.6 × the reranker's score (a sigmoid of a cross-encoder logit: near 0 for a passage on another
 * subject, near 1 for one that answers the claim) + 0.4 × the share of the claim's words in the
 * passage; an unrelated passage scores 0 to 0.05 and a passage that touches the subject, 0.3 and up.
 * 0.15 sits in the gap between them. Config: thresholds.relevant.
 */
export const DEFAULT_RELEVANT = 0.15;

/** The cut for this config. */
export const relevantAt = (t: { relevant?: number | undefined } | undefined): number =>
  t?.relevant ?? DEFAULT_RELEVANT;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const STANCE: Record<Stance, number> = { supports: 1, contradicts: -1, neutral: 0 };

/** Map an unbounded evidence sum to [0, 1]; one strong source ≈ 0.63. */
export const squash = (x: number) => (x <= 0 ? 0 : 1 - Math.exp(-x));

export function supportScore(evidence: Evidence[]): number {
  return squash(evidence.reduce((s, e) => s + clamp01(e.score) * STANCE[e.stance], 0));
}

export function contradictionMass(evidence: Evidence[]): number {
  return squash(evidence.filter((e) => e.stance === 'contradicts').reduce((s, e) => s + clamp01(e.score), 0));
}

export function agreementScore(v: VerifierVerdict | VerifierVerdict[]): number {
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0) return 0.5;
  const each = list.map((x): number =>
    x === 'supported' ? 1 : x === 'partly' ? 0.75 : x === 'insufficient' ? 0.5 : 0,
  );
  return each.reduce((a, b) => a + b, 0) / each.length;
}

export function retrievalScore(evidence: Evidence[], coverage: number): number {
  if (evidence.length === 0) return 0;
  const top = [...evidence]
    .map((e) => clamp01(e.score))
    .sort((a, b) => b - a)
    .slice(0, 3);
  return (top.reduce((a, b) => a + b, 0) / top.length) * clamp01(coverage);
}

export interface ClaimScore {
  verdict: ClaimVerdict;
  confidence: number;
  support: number;
  agreement: number;
  retrieval: number;
}

export function scoreClaim(
  input: {
    checkable: boolean;
    evidence: Evidence[];
    verifier: VerifierVerdict | VerifierVerdict[];
    coverage: number;
    /** The checker's own confidence in its stance, when it gave one (the least of several). */
    checkerConfidence?: number | null | undefined;
  },
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS,
): ClaimScore {
  if (!input.checkable)
    return { verdict: 'not_checkable', confidence: 0, support: 0, agreement: 0, retrieval: 0 };
  const support = supportScore(input.evidence);
  const agreement = agreementScore(input.verifier);
  const retrieval = retrievalScore(input.evidence, input.coverage);
  const total = weights.support + weights.agreement + weights.retrieval || 1;
  const confidence = clamp01(
    (weights.support * support + weights.agreement * agreement + weights.retrieval * retrieval) / total,
  );

  const verdicts = Array.isArray(input.verifier) ? input.verifier : [input.verifier];
  let verdict: ClaimVerdict = 'unverified';
  if (contradictionMass(input.evidence) >= thresholds.contradict || verdicts.includes('contradicted'))
    verdict = 'contradicted';
  else if (
    verdicts.every((v) => v === 'supported' || v === 'partly') &&
    // A passage the checker leaned on, or one that plainly bears on the claim (it may name no ref).
    (input.evidence.some((e) => e.stance === 'supports') ||
      input.evidence.some((e) => clamp01(e.score) >= 0.5)) &&
    (input.checkerConfidence == null || input.checkerConfidence >= thresholds.verified)
  )
    verdict = verdicts.includes('partly') ? 'partly' : 'verified';
  return { verdict, confidence, support, agreement, retrieval };
}

/** Importance-weighted mean over checkable claims; null when nothing was checkable. */
export function messageConfidence(claims: { importance: number; score: ClaimScore }[]): number | null {
  const checkable = claims.filter((c) => c.score.verdict !== 'not_checkable' && c.importance > 0);
  const w = checkable.reduce((s, c) => s + c.importance, 0);
  if (w === 0) return null;
  const credit = (c: { score: ClaimScore }) => (c.score.verdict === 'partly' ? PARTLY_CREDIT : 1);
  return checkable.reduce((s, c) => s + c.importance * c.score.confidence * credit(c), 0) / w;
}

/** The breakdown in words, for the tooltip on the score chip. */
export function explainScore(s: ClaimScore): string {
  if (s.verdict === 'not_checkable')
    return 'This is an opinion or a prediction, so there is nothing to check it against.';
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (s.verdict === 'partly')
    return `Mostly right, with a difference worth knowing. Support ${pct(s.support)}, and the passages found were ${s.retrieval >= 0.6 ? 'a close' : 'a loose'} match (${pct(s.retrieval)}). Overall confidence ${pct(s.confidence)}; it counts as half a pass in the answer's score.`;
  const src =
    s.support >= 0.6
      ? 'Your sources support it well'
      : s.support > 0.2
        ? 'Your sources partly support it'
        : 'Your sources barely mention it';
  const model =
    s.agreement >= 0.99
      ? 'a second model agrees'
      : s.agreement > 0
        ? 'a second model could not confirm it'
        : 'a second model disagrees';
  const ret =
    s.retrieval >= 0.6 ? 'the passages found were a close match' : 'the passages found were a loose match';
  return `${src} (${pct(s.support)}), ${model}, and ${ret} (${pct(s.retrieval)}). Overall confidence ${pct(s.confidence)}.`;
}
