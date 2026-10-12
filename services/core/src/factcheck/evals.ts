/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check evals: labelled claims against fixed sources
 *  Ref      |  tests/eval/README.md (factcheck/) · DESIGN.md §10
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Measure the fact-check's verdicts and citations on a
 *           |  fixed, labelled set, so a change to the verifier
 *           |  prompt, its parsing or the score shows up as a number
 *           |  and fails CI when it drops below the checked-in floor.
 *  How      |  For each case: the claim's evidence is the top passages
 *           |  of the fixture sources by BM25 (a deterministic stand-in
 *           |  for Knowledge's /evidence, whose own retrieval and quote
 *           |  choice tests/eval/retrieval/run.py measures), then the
 *           |  real verifyClaim (prompt, untrusted wrapper, gateway,
 *           |  JSON parsing) and scoreOutcome. Reports accuracy,
 *           |  macro-F1 over verified / contradicted / unverified,
 *           |  citation accuracy (the evidence the verdict rests on
 *           |  comes from the labelled source and quotes the labelled
 *           |  sentence) and the expected calibration error of the
 *           |  confidence against "the claim is true".
 *  Note     |  With the offline test model the verifier is word
 *           |  overlap, not understanding: deterministic, no network,
 *           |  no cost. Near-miss words ("July" for "June") fool it,
 *           |  and the floors say so. A real verifier is measured the
 *           |  same way by pointing the registry at it.
 * ------------------------------------------------------------------
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CircuitBreaker } from '@nvx/resilience';
import { z } from 'zod';
import { FakeProvider } from '../gateway/fake';
import { contentTerms } from '../gateway/fake-factcheck';
import { Gateway } from '../gateway/gateway';
import { ModelRegistry } from '../gateway/registry';
import { MemorySecretStore, SecretBox } from '../secrets';
import { MemorySettings } from '../settings';
import { DEFAULT_SCORE_CONFIG, scoreOutcome } from './pipeline';
import type { ClaimVerdict } from './score';
import { type Gathered, type StepDeps, verifyClaim } from './steps';

export const EvalSource = z.object({
  id: z.string(),
  title: z.string(),
  passages: z.array(z.string().min(1)).min(1),
});
export type EvalSource = z.infer<typeof EvalSource>;

export const EvalCase = z.object({
  claim: z.string().min(1),
  label: z.enum(['supported', 'contradicted', 'insufficient']),
  source: z.string().nullable(),
  /** The sentence a correct citation quotes; null when nothing should be cited. */
  quote: z.string().nullable(),
  type: z.string(),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalThresholds = z.object({
  accuracy: z.number().min(0).max(1),
  macro_f1: z.number().min(0).max(1),
  citation_accuracy: z.number().min(0).max(1),
  max_ece: z.number().min(0).max(1),
});
export type EvalThresholds = z.infer<typeof EvalThresholds>;

/** The verdict a label expects: "insufficient" is the claim staying unverified. */
const EXPECTED: Record<EvalCase['label'], ClaimVerdict> = {
  supported: 'verified',
  contradicted: 'contradicted',
  insufficient: 'unverified',
};
const CLASSES: ClaimVerdict[] = ['verified', 'contradicted', 'unverified'];

/* ---- The Knowledge stand-in: BM25 over passages ----------------------------- */

interface Passage {
  ref: string;
  source: EvalSource;
  text: string;
  terms: string[];
  /** Offset of the passage in its source's joined text (passages joined by a blank line). */
  start: number;
}

export interface PassageIndex {
  passages: Passage[];
  df: Map<string, number>;
  avgLen: number;
}

export function indexSources(sources: EvalSource[]): PassageIndex {
  const passages: Passage[] = [];
  for (const s of sources) {
    let start = 0;
    s.passages.forEach((text, i) => {
      passages.push({ ref: `${s.id}#${i}`, source: s, text, terms: contentTerms(text), start });
      start += text.length + 2;
    });
  }
  const df = new Map<string, number>();
  for (const p of passages) for (const t of new Set(p.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = passages.reduce((n, p) => n + p.terms.length, 0) / (passages.length || 1);
  return { passages, df, avgLen };
}

/** The k passages BM25 ranks highest for the claim (ties broken by order, so runs repeat). */
export function topPassages(
  index: PassageIndex,
  claim: string,
  k = 4,
): { passage: Passage; score: number }[] {
  const q = contentTerms(claim);
  const n = index.passages.length;
  const K1 = 1.2;
  const B = 0.75;
  const scored = index.passages.map((p, order) => {
    let score = 0;
    for (const t of q) {
      const tf = p.terms.filter((x) => x === t).length;
      if (!tf) continue;
      const df = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * p.terms.length) / (index.avgLen || 1)));
    }
    return { passage: p, score, order };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, k)
    .map(({ passage, score }) => ({ passage, score }));
}

/** Share of the claim's content words in the text: the same overlap Knowledge scores relevance by. */
function overlap(claimTerms: string[], text: string): number {
  if (!claimTerms.length) return 0;
  const have = new Set(contentTerms(text));
  return claimTerms.filter((t) => have.has(t)).length / claimTerms.length;
}

/** The sentence of a passage sharing most of the claim's words, as Knowledge's best_quote picks it. */
function bestQuote(text: string, claimTerms: string[]): { quote: string; at: number } {
  let best = { quote: text, at: 0, score: -1 };
  for (const m of text.matchAll(/[^.!?]+[.!?]*/g)) {
    const quote = m[0].trim();
    if (quote.length < 3) continue;
    const score = overlap(claimTerms, quote);
    if (score > best.score) best = { quote, at: (m.index ?? 0) + m[0].indexOf(quote), score };
  }
  return best;
}

/** Evidence for one claim, in the shape gatherEvidence hands the verifier. */
export function gatherFromIndex(index: PassageIndex, claim: string, k = 4): Gathered {
  const terms = contentTerms(claim);
  const hits = topPassages(index, claim, k);
  const evidence = hits.map(({ passage }) => {
    const q = bestQuote(passage.text, terms);
    return {
      kind: 'chunk' as const,
      ref: passage.ref,
      source_id: passage.source.id,
      source_title: passage.source.title,
      page: null,
      char_start: passage.start + q.at,
      char_end: passage.start + q.at + q.quote.length,
      quote: q.quote,
      stance: 'neutral' as const,
      // No reranker here, so relevance is the overlap alone (evidence.py without one).
      score: Math.round(overlap(terms, passage.text) * 1e6) / 1e6,
      text: passage.text,
    };
  });
  evidence.sort((a, b) => b.score - a.score);
  return { evidence, coverage: overlap(terms, evidence.map((e) => e.text).join('\n')) };
}

/* ---- Metrics ------------------------------------------------------------------ */

export interface CaseResult {
  claim: string;
  type: string;
  label: EvalCase['label'];
  expected: ClaimVerdict;
  verdict: ClaimVerdict;
  confidence: number;
  correct: boolean;
  /** null when the case has nothing to cite or the verdict was wrong. */
  cited: boolean | null;
}

export interface EvalReport {
  cases: number;
  accuracy: number;
  macro_f1: number;
  per_class: Record<string, { precision: number; recall: number; f1: number; support: number }>;
  citation_accuracy: number;
  ece: number;
  by_type: Record<string, { cases: number; accuracy: number }>;
  results: CaseResult[];
}

/** Expected calibration error of `confidence` against "the claim is true", in `bins` equal bins. */
export function expectedCalibrationError(points: { p: number; y: 0 | 1 }[], bins = 5): number {
  if (!points.length) return 0;
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = points.filter((x) => x.p >= lo && (b === bins - 1 ? x.p <= hi : x.p < hi));
    if (!inBin.length) continue;
    const conf = inBin.reduce((s, x) => s + x.p, 0) / inBin.length;
    const acc = inBin.reduce((s, x) => s + x.y, 0) / inBin.length;
    ece += (inBin.length / points.length) * Math.abs(acc - conf);
  }
  return ece;
}

export function summarise(results: CaseResult[]): EvalReport {
  const per_class: EvalReport['per_class'] = {};
  for (const c of CLASSES) {
    const tp = results.filter((r) => r.verdict === c && r.expected === c).length;
    const predicted = results.filter((r) => r.verdict === c).length;
    const support = results.filter((r) => r.expected === c).length;
    const precision = predicted ? tp / predicted : 0;
    const recall = support ? tp / support : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    per_class[c] = { precision, recall, f1, support };
  }
  const present = CLASSES.filter((c) => (per_class[c]?.support ?? 0) > 0);
  const cited = results.filter((r) => r.cited !== null);
  const by_type: EvalReport['by_type'] = {};
  for (const r of results) {
    const t = by_type[r.type] ?? { cases: 0, accuracy: 0 };
    by_type[r.type] = t;
    t.cases += 1;
    t.accuracy += r.correct ? 1 : 0;
  }
  for (const t of Object.values(by_type)) t.accuracy /= t.cases;
  return {
    cases: results.length,
    accuracy: results.filter((r) => r.correct).length / (results.length || 1),
    macro_f1: present.reduce((s, c) => s + (per_class[c]?.f1 ?? 0), 0) / (present.length || 1),
    per_class,
    citation_accuracy: cited.length ? cited.filter((r) => r.cited).length / cited.length : 1,
    ece: expectedCalibrationError(
      results.map((r) => ({ p: r.confidence, y: r.label === 'supported' ? 1 : 0 })),
    ),
    by_type,
    results,
  };
}

/** Which floors a report misses, in words; empty when it passes. */
export function missedThresholds(r: EvalReport, t: EvalThresholds): string[] {
  const out: string[] = [];
  const f = (x: number) => x.toFixed(3);
  if (r.accuracy < t.accuracy) out.push(`accuracy ${f(r.accuracy)} is under ${f(t.accuracy)}`);
  if (r.macro_f1 < t.macro_f1) out.push(`macro-F1 ${f(r.macro_f1)} is under ${f(t.macro_f1)}`);
  if (r.citation_accuracy < t.citation_accuracy)
    out.push(`citation accuracy ${f(r.citation_accuracy)} is under ${f(t.citation_accuracy)}`);
  if (r.ece > t.max_ece) out.push(`ECE ${f(r.ece)} is over ${f(t.max_ece)}`);
  return out;
}

/* ---- Fixtures and the offline models ------------------------------------------- */

export interface EvalFixtures {
  sources: EvalSource[];
  cases: EvalCase[];
  thresholds: EvalThresholds;
}

/** tests/eval/factcheck: sources.json, cases.jsonl and thresholds.json, validated. */
export async function loadEvalFixtures(dir: string): Promise<EvalFixtures> {
  const read = (f: string) => readFile(join(dir, f), 'utf8');
  const [sources, cases, thresholds] = await Promise.all([
    read('sources.json'),
    read('cases.jsonl'),
    read('thresholds.json'),
  ]);
  return {
    sources: z.object({ sources: z.array(EvalSource) }).parse(JSON.parse(sources)).sources,
    cases: cases
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => EvalCase.parse(JSON.parse(l))),
    thresholds: EvalThresholds.parse(JSON.parse(thresholds).offline),
  };
}

/**
 * The steps' dependencies with only the offline test models: no keys, no
 * network, the same answers every run. No secret is ever read.
 */
export async function offlineEvalDeps(promptsDir: string): Promise<StepDeps> {
  const registry = new ModelRegistry({
    models: [],
    taskClasses: {},
    secrets: new MemorySecretStore(new SecretBox(Buffer.alloc(32).toString('base64'))),
    settings: new MemorySettings(),
    offline: true,
  });
  await registry.refresh();
  return {
    registry,
    gateway: new Gateway({ client: new FakeProvider(), breaker: new CircuitBreaker() }),
    promptsDir,
  };
}

/* ---- The run -------------------------------------------------------------------- */

export async function runFactcheckEval(
  deps: StepDeps,
  input: { sources: EvalSource[]; cases: EvalCase[]; k?: number },
  signal: AbortSignal = new AbortController().signal,
): Promise<EvalReport> {
  const index = indexSources(input.sources);
  const results: CaseResult[] = [];
  for (const c of input.cases) {
    const gathered = gatherFromIndex(index, c.claim, input.k ?? 4);
    const v = await verifyClaim(
      deps,
      { claim: c.claim, evidence: gathered.evidence, generatorFamily: null },
      signal,
    );
    const checked = scoreOutcome(
      {
        claim: { text: c.claim, charStart: 0, charEnd: c.claim.length, importance: 1, checkable: true },
        evidence: v.evidence,
        coverage: gathered.coverage,
        verdict: v.verdict,
        rationale: v.rationale,
      },
      DEFAULT_SCORE_CONFIG,
    );
    const expected = EXPECTED[c.label];
    const correct = checked.score.verdict === expected;
    // The verdict rests on the evidence the verifier took a side on.
    const relied = checked.evidence.filter((e) => e.stance !== 'neutral');
    const cited =
      c.source && c.quote && correct
        ? relied.some((e) => e.source_id === c.source && (c.quote ?? '').includes(e.quote.trim()))
        : null;
    results.push({
      claim: c.claim,
      type: c.type,
      label: c.label,
      expected,
      verdict: checked.score.verdict,
      confidence: checked.score.confidence,
      correct,
      cited,
    });
  }
  return summarise(results);
}
