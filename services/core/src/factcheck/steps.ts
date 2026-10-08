/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check steps: extract, gather, verify
 *  Ref      |  DESIGN.md §10 · prompts/factcheck/*
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The three model-and-search steps behind a fact-check,
 *           |  built on the gateway (fallback and recovery included)
 *           |  and Knowledge's /evidence.
 *  How      |  extract   utility model, prompts/factcheck/extract-claims,
 *           |            JSON. Offsets are re-checked against the answer:
 *           |            a span that does not hold is re-found by its
 *           |            text, or the claim is dropped. Overlaps go.
 *           |  gather    one /evidence call for every checkable claim,
 *           |            scoped to the notebook (or the workspace).
 *           |  verify    factcheck.verify chain with the generator's
 *           |            family moved to the back, so the second opinion
 *           |            is independent when it can be. Evidence goes in
 *           |            inside the untrusted wrapper with a fresh nonce.
 *           |  A model whose output is not the JSON asked for is
 *           |  skipped for the next one in its chain.
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import { AncileError, type EvidenceResponse, type ModelConfig } from '@nvx/contracts';
import { z } from 'zod';
import { loadPrompt, render } from '../conductor/prompt';
import type { Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import type { ModelRequest } from '../gateway/types';
import type { KnowledgeClient } from '../knowledge/client';
import type { ClaimEvidence, ExtractedClaim } from './pipeline';
import type { Stance, VerifierVerdict } from './score';

/** At most this many claims are checked per answer (the prompt asks for 25). */
export const MAX_CLAIMS = 25;
const EVIDENCE_CHARS = 1_200;

const SYSTEM =
  'You are a careful fact-checker inside NVX Ancile. Reply with one JSON object only, no prose and no code fence.';

/* ---- Structured calls ------------------------------------------------------ */

export interface Completion {
  text: string;
  modelId: string;
}

/** Stream one request through the gateway and collect the text. */
async function complete(
  gateway: Gateway,
  chain: ModelConfig[],
  req: ModelRequest,
  signal: AbortSignal,
): Promise<Completion> {
  let text = '';
  let modelId = chain[0]?.id ?? '';
  for await (const ev of gateway.stream(chain, req, signal)) {
    if (ev.type === 'model') {
      modelId = ev.modelId;
      text = '';
    } else if (ev.type === 'chunk' && ev.chunk.type === 'text') text += ev.chunk.delta;
  }
  return { text, modelId };
}

/** The first JSON object in a reply, fences and chatter around it ignored. */
export function parseJsonObject(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Ask models down the chain until one returns JSON matching the schema.
 * Errors from the gateway (every model failed) propagate.
 */
export async function structured<T>(
  deps: { gateway: Gateway },
  chain: ModelConfig[],
  prompt: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<{ value: T; modelId: string }> {
  for (let i = 0; i < chain.length; i++) {
    const out = await complete(
      deps.gateway,
      chain.slice(i),
      { system: SYSTEM, messages: [{ role: 'user', content: prompt }], temperature: 0 },
      signal,
    );
    const parsed = schema.safeParse(parseJsonObject(out.text));
    if (parsed.success) return { value: parsed.data, modelId: out.modelId };
    // The model that answered gave the wrong shape: try the one after it.
    const at = chain.findIndex((m) => m.id === out.modelId);
    if (at > i) i = at;
  }
  throw new AncileError({
    code: 'factcheck.bad_output',
    title: 'No model returned a usable fact-check',
    hint: 'Try again, or add a stronger model for the utility and fact-check tasks in Settings → Models.',
    status: 502,
    errorClass: 'transient',
  });
}

/* ---- Extract ---------------------------------------------------------------- */

const RawClaims = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        char_start: z.coerce.number().int().optional(),
        char_end: z.coerce.number().int().optional(),
        importance: z.coerce.number().optional(),
        checkable: z.boolean().optional(),
      }),
    )
    .default([]),
});

const words = (s: string) =>
  new Set((s.toLowerCase().match(/[a-z][a-z'-]{2,}|\d+(?:[.,]\d+)*/g) ?? []).map((w) => w.replace(/s$/, '')));

/** At least half the claim's words appear in the span. */
export function sameSubject(claim: string, span: string): boolean {
  const c = words(claim);
  if (!c.size) return span.trim().length > 0;
  const have = words(span);
  let n = 0;
  for (const w of c) if (have.has(w)) n++;
  return n / c.size >= 0.5;
}

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

/** Where `text` occurs in `answer` closest to `near` (the model's own offset), or -1. */
export function nearestOccurrence(answer: string, text: string, near: number): number {
  if (!text) return -1;
  let best = -1;
  for (let i = answer.indexOf(text); i >= 0; i = answer.indexOf(text, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/** Hold the model's offsets to the answer: fix what can be found, drop the rest and any overlaps. */
export function validateClaims(answer: string, raw: z.infer<typeof RawClaims>['claims']): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  for (const c of raw) {
    let start = c.char_start ?? -1;
    let end = c.char_end ?? -1;
    // The span must be about the claim (its text may be reworded, so words, not characters).
    const exact = c.text.trim();
    const holds =
      start >= 0 && end > start && end <= answer.length && sameSubject(c.text, answer.slice(start, end));
    // Verbatim text beats counted offsets: models often count code points,
    // which drift by one per emoji. Take the occurrence nearest their count.
    const at = answer.slice(start, end) === exact ? start : nearestOccurrence(answer, exact, start);
    if (at >= 0) {
      start = at;
      end = at + exact.length;
    } else if (!holds) continue;
    // Never cut an emoji (or any astral character) in half.
    if (isLow(answer.charCodeAt(start))) start--;
    if (isHigh(answer.charCodeAt(end - 1))) end++;
    // Trim surrounding space so the underline starts and ends on words.
    while (start < end && /\s/.test(answer[start] ?? '')) start++;
    while (end > start && /\s/.test(answer[end - 1] ?? '')) end--;
    if (end <= start) continue;
    const importance = Math.min(1, Math.max(0, c.importance ?? 0.5));
    out.push({
      text: c.text.trim(),
      charStart: start,
      charEnd: end,
      importance,
      checkable: c.checkable !== false,
    });
  }
  // Most important first decides which of two overlapping claims stays.
  const kept: ExtractedClaim[] = [];
  for (const c of [...out].sort((a, b) => b.importance - a.importance)) {
    if (kept.length >= MAX_CLAIMS) break;
    if (kept.some((k) => c.charStart < k.charEnd && k.charStart < c.charEnd)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.charStart - b.charStart);
}

export interface StepDeps {
  gateway: Gateway;
  registry: ModelRegistry;
  promptsDir: string;
  kn?: Pick<KnowledgeClient, 'post'>;
}

const EXTRACT_FALLBACK = `Split the answer into atomic, verifiable claims. Give each its exact character offsets into the answer, an importance (1, 0.5 or 0.2) and whether it is checkable.

Question:
{{question}}

Answer:
{{message_text}}

Return JSON matching ClaimList: { "claims": [{ "text", "char_start", "char_end", "importance", "checkable" }] }`;

export async function extractClaims(
  deps: StepDeps,
  input: { answer: string; question: string },
  signal: AbortSignal,
): Promise<{ claims: ExtractedClaim[]; modelId: string }> {
  const template = await loadPrompt(deps.promptsDir, 'factcheck.extract-claims', EXTRACT_FALLBACK);
  // The answer goes in after rendering, untouched, so offsets into the prompt's copy are offsets into it.
  const slot = '@@ancile:answer@@';
  const prompt = render(template, { message_text: slot, question: input.question }).replace(
    slot,
    () => input.answer,
  );
  const chain = deps.registry.chain('utility');
  const { value, modelId } = await structured(deps, chain, prompt, RawClaims, signal);
  return { claims: validateClaims(input.answer, value.claims), modelId };
}

/* ---- Gather ----------------------------------------------------------------- */

export interface Gathered {
  evidence: (ClaimEvidence & { text: string })[];
  coverage: number;
}

export async function gatherEvidence(
  deps: StepDeps,
  input: { workspaceId: string; notebookId: string | null; claims: string[] },
): Promise<Gathered[]> {
  if (!input.claims.length) return [];
  if (!deps.kn) return input.claims.map(() => ({ evidence: [], coverage: 0 }));
  let res: EvidenceResponse;
  try {
    res = await deps.kn.post<EvidenceResponse>('/evidence', {
      workspace_id: input.workspaceId,
      notebook_id: input.notebookId,
      claims: input.claims.map((c) => c.slice(0, 4_000)),
      k_per_claim: 4,
    });
  } catch (err) {
    throw new AncileError({
      code: 'factcheck.evidence_unavailable',
      title: 'Your sources could not be searched',
      hint: 'Knowledge did not answer. Check it in Admin → Health, then fact-check again.',
      status: 503,
      errorClass: 'transient',
      cause: err,
    });
  }
  // TODO(phase-5): web evidence (config factcheck.web_search) once a web.search tool exists.
  return input.claims.map((_, i) => {
    const r = res.results[i];
    return {
      coverage: r?.coverage ?? 0,
      evidence: (r?.hits ?? []).map((h) => ({
        kind: h.kind,
        ref: h.chunk_id,
        source_id: h.source_id,
        source_title: h.source_title,
        page: h.page,
        char_start: h.quote_start,
        char_end: h.quote_end,
        quote: h.quote,
        stance: 'neutral' as Stance,
        score: h.relevance,
        text: h.text,
      })),
    };
  });
}

/* ---- Verify ----------------------------------------------------------------- */

const RawVerdict = z.object({
  stance: z.enum(['supported', 'contradicted', 'insufficient']),
  evidence: z
    .array(
      z.object({
        ref: z.coerce.string(),
        quote: z.string().optional(),
        stance: z.enum(['supports', 'contradicts', 'supported', 'contradicted', 'neutral']).optional(),
      }),
    )
    .default([]),
  rationale: z.string().default(''),
});

const VERIFY_FALLBACK = `Judge the claim strictly against the evidence: supported, contradicted or insufficient. For each piece of evidence you relied on, give its ref, the shortest exact quote and whether it supports or contradicts.

Claim:
{{claim}}

Evidence:
{{evidence}}

Return JSON matching ClaimVerdict: { "stance", "evidence": [{ "ref", "quote", "stance" }], "rationale" }`;

const WRAPPER_FALLBACK = `<untrusted kind="{{kind}}" origin="{{origin}}" id="{{marker}}">
{{content}}
</untrusted id="{{marker}}">`;

/** The evidence as the verifier reads it: numbered E1…En, inside the untrusted wrapper. */
export function evidenceBlock(
  evidence: { text: string; source_title: string; page: number | null }[],
  wrapper: string,
): string {
  if (!evidence.length) return '(No evidence was found in your sources.)';
  const marker = randomBytes(6).toString('hex');
  const body = evidence
    .map((e, i) => {
      const text = e.text.length > EVIDENCE_CHARS ? `${e.text.slice(0, EVIDENCE_CHARS)}…` : e.text;
      const where = e.page != null ? `${e.source_title}, page ${e.page}` : e.source_title;
      return `[E${i + 1}] ${where}\n"""\n${text.replace(/"""/g, '"​""')}\n"""`;
    })
    .join('\n\n');
  return render(wrapper, { kind: 'evidence', origin: "the user's sources", marker, content: body });
}

export interface Verified {
  verdict: VerifierVerdict;
  rationale: string;
  /** The evidence with the verifier's stance applied (and its exact quotes, when they hold). */
  evidence: ClaimEvidence[];
  modelId: string;
}

export async function verifyClaim(
  deps: StepDeps,
  input: { claim: string; evidence: Gathered['evidence']; generatorFamily: string | null },
  signal: AbortSignal,
): Promise<Verified> {
  const strip = (e: Gathered['evidence'][number]): ClaimEvidence => {
    const { text: _t, ...rest } = e;
    return rest;
  };
  if (!input.evidence.length)
    return {
      verdict: 'insufficient',
      rationale: 'Nothing in your sources mentions this.',
      evidence: [],
      modelId: '',
    };
  const [template, wrapper] = await Promise.all([
    loadPrompt(deps.promptsDir, 'factcheck.verify-claim', VERIFY_FALLBACK),
    loadPrompt(deps.promptsDir, 'system.untrusted-wrapper', WRAPPER_FALLBACK),
  ]);
  const prompt = render(template, { claim: input.claim, evidence: evidenceBlock(input.evidence, wrapper) });
  const chain = deps.registry.chain('factcheck.verify', null, {
    generatorFamily: input.generatorFamily ?? undefined,
  });
  const { value, modelId } = await structured(deps, chain, prompt, RawVerdict, signal);

  const evidence = input.evidence.map(strip);
  for (const v of value.evidence) {
    const n = Number(/(\d+)/.exec(v.ref)?.[1] ?? Number.NaN);
    const target = Number.isInteger(n) ? evidence[n - 1] : undefined;
    const source = Number.isInteger(n) ? input.evidence[n - 1] : undefined;
    if (!target || !source) continue;
    const s = v.stance ?? (value.stance === 'contradicted' ? 'contradicts' : 'supports');
    target.stance =
      s === 'supports' || s === 'supported' ? 'supports' : s === 'neutral' ? 'neutral' : 'contradicts';
    // A quote the verifier copied exactly is narrower than ours: use it.
    const q = v.quote?.trim();
    const at = q ? source.text.indexOf(q) : -1;
    if (q && at >= 0 && target.char_start !== null) {
      const base = target.char_start - source.text.indexOf(target.quote);
      if (source.text.indexOf(target.quote) >= 0) {
        target.char_start = base + at;
        target.char_end = base + at + q.length;
      }
      target.quote = q;
    }
  }
  return { verdict: value.stance, rationale: value.rationale.trim(), evidence, modelId };
}

export type { Stance };
