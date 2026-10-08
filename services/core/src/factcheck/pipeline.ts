/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check pipeline
 *  Ref      |  DESIGN.md §10
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Claim by claim: extract what can be checked, find
 *           |  evidence (your sources first, the web only if allowed),
 *           |  ask an independent model, and score. Then say what it
 *           |  adds up to: counts, the message score, and whether the
 *           |  answer earned the seal.
 *  How      |  Pure. The steps that call models and Knowledge live in
 *           |  steps.ts and run inside a durable run (handler.ts);
 *           |  this file turns their results into stored claims and
 *           |  the view the Cockpit reads, so every rule here is
 *           |  testable without a model.
 * ------------------------------------------------------------------
 */

import {
  type ClaimScore,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  explainScore,
  messageConfidence,
  type ScoreThresholds,
  type ScoreWeights,
  scoreClaim,
  type VerifierVerdict,
} from './score';
import type { FactcheckRecord, StoredClaim } from './store';
import type { ClaimEvidence as ContractEvidence, Factcheck, FactcheckClaim, FactsheetCounts } from './types';

export interface ExtractedClaim {
  text: string;
  charStart: number;
  charEnd: number;
  importance: number;
  checkable: boolean;
}

export type ClaimEvidence = ContractEvidence;

export interface CheckedClaim extends ExtractedClaim {
  score: ClaimScore;
  evidence: ClaimEvidence[];
  rationale: string;
}

export interface ScoreConfig {
  weights: ScoreWeights;
  thresholds: ScoreThresholds;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = { weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS };

/** One claim's result from the steps, before scoring. */
export interface ClaimOutcome {
  claim: ExtractedClaim;
  evidence: ClaimEvidence[];
  coverage: number;
  verdict: VerifierVerdict;
  rationale: string;
}

export function scoreOutcome(o: ClaimOutcome, cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): CheckedClaim {
  const score = scoreClaim(
    { checkable: o.claim.checkable, evidence: o.evidence, verifier: o.verdict, coverage: o.coverage },
    cfg.weights,
    cfg.thresholds,
  );
  return {
    ...o.claim,
    evidence: o.evidence,
    rationale: o.claim.checkable ? o.rationale : 'An opinion, advice or a prediction: nothing to check.',
    score,
  };
}

export function toStored(c: CheckedClaim, id: string): StoredClaim {
  return {
    id,
    text: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    importance: c.importance,
    verdict: c.score.verdict,
    confidence: c.score.confidence,
    support: c.score.support,
    agreement: c.score.agreement,
    retrieval: c.score.retrieval,
    evidence: c.evidence,
    rationale: c.rationale,
  };
}

export function countVerdicts(claims: { verdict: StoredClaim['verdict'] }[]): FactsheetCounts {
  const counts: FactsheetCounts = { verified: 0, unverified: 0, contradicted: 0, not_checkable: 0 };
  for (const c of claims) counts[c.verdict] += 1;
  return counts;
}

/** Earned only when there was something to check and every checkable claim held. */
export function isSealed(counts: FactsheetCounts): boolean {
  return counts.verified > 0 && counts.unverified === 0 && counts.contradicted === 0;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The message-level result in words, for the chip's tooltip. */
export function summarise(r: {
  status: FactcheckRecord['status'];
  confidence: number | null;
  counts: FactsheetCounts;
}): string {
  if (r.status === 'running') return 'Checking each claim against your sources.';
  if (r.status === 'failed') return 'The fact-check did not finish.';
  const { verified, unverified, contradicted, not_checkable } = r.counts;
  const checkable = verified + unverified + contradicted;
  if (checkable === 0)
    return not_checkable
      ? 'Nothing here could be checked: it is opinion, advice or prediction.'
      : 'This answer makes no claims that can be checked.';
  const parts = [`${verified} of ${checkable} ${checkable === 1 ? 'claim' : 'claims'} verified`];
  if (contradicted) parts.push(`${contradicted} contradicted by your sources`);
  if (unverified) parts.push(`${unverified} without enough evidence`);
  const head = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${head}.${r.confidence !== null ? ` Confidence ${pct(r.confidence)}, weighted by how much the answer relies on each claim.` : ''}`;
}

export function messageScore(claims: CheckedClaim[]): number | null {
  return messageConfidence(claims);
}

/** The stored record as the Cockpit reads it. */
export function toView(r: FactcheckRecord): Factcheck {
  const claims: FactcheckClaim[] = r.claims.map((c) => ({
    ...c,
    explanation: explainScore({
      verdict: c.verdict,
      confidence: c.confidence,
      support: c.support,
      agreement: c.agreement,
      retrieval: c.retrieval,
    }),
  }));
  const counts = countVerdicts(r.claims);
  return {
    id: r.id,
    message_id: r.message_id,
    run_id: r.run_id,
    status: r.status,
    confidence: r.confidence,
    verifier_model_id: r.verifier_model_id,
    claims,
    counts,
    sealed: r.status === 'done' && isSealed(counts),
    summary: summarise({ status: r.status, confidence: r.confidence, counts }),
    scope: r.scope,
    error: r.error,
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}
