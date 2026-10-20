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
 *           |  A reply is read tolerantly first (tolerant.ts: a wrapper
 *           |  key, "SUPPORTED", 85 for 0.85). One that still fails the
 *           |  schema is asked again once, on the same model, saying what
 *           |  was wrong; if that fails too, the model counts as failed
 *           |  and the next one in the chain is asked.
 *           |  limits    every model call is counted against the claim and
 *           |            the check (budget.ts), so a bad day at a provider
 *           |            ends as "Not checked: <reason>", never as 54 calls.
 *           |  judges    when no model is set for a step (no provider
 *           |            key), Claude Code's quickest model answers
 *           |            (one lean call: no tools, none of your settings,
 *           |            a short time limit), then the smallest Ollama
 *           |            model you pulled. With none of them, the error
 *           |            says each thing that was tried.
 *           |  Every Claude Code judge call (fallback or chosen for a
 *           |  step) is asked on its own, with its own time limit, and
 *           |  through JudgeSlots: at most Settings → Claude Code's
 *           |  "fact-check judges at once" (default 1) across every
 *           |  fact-check, since each is a session on your Claude plan.
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import {
  AncileError,
  CLAUDE_CODE_MODEL_PREFIX,
  CLAUDE_CODE_PROVIDER,
  type EvidenceResponse,
  type ModelConfig,
  type ModelTier,
  TIER_RANK,
} from '@nvx/contracts';
import { z } from 'zod';
import { loadPrompt, render } from '../conductor/prompt';
import { ChainFailedError, type FailedAttempt, type Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import { canonicalFamily, sameFamily, type WantResolution } from '../gateway/tiers';
import type { ModelRequest } from '../gateway/types';
import { type CallUsage, priceOf } from '../gateway/usage';
import type { KnowledgeClient } from '../knowledge/client';
import { CheckLimit, type ClaimBudget } from './budget';
import type { VerdictCache } from './cache';
import type { ClaimEvidence, ExtractedClaim } from './pipeline';
import type { Stance, VerifierVerdict } from './score';
import { parseJsonValue, REPAIR_LEAD, tolerantClaims, tolerantVerdict } from './tolerant';
import { escalateTo, type Triage } from './triage';
import { hostName, type WebHit } from './web';

/** At most this many claims are checked per answer (the prompt asks for 25). */
export const MAX_CLAIMS = 25;
const EVIDENCE_CHARS = 1_200;

const SYSTEM =
  'You are a careful fact-checker inside NVX Ancile. Reply with one JSON object only, no prose and no code fence.';

/* ---- Judges ------------------------------------------------------------------ */

/** Claude Code's model a fact-check falls back to: the quickest. */
export const CLAUDE_CODE_JUDGE = `${CLAUDE_CODE_MODEL_PREFIX}haiku`;
/** One Claude Code judge call gets this long before the next judge is tried. */
export const CLAUDE_CODE_JUDGE_TIMEOUT_MS = 90_000;

/**
 * At most `limit()` Claude Code judge calls at once, across every
 * fact-check; the rest wait in order. The limit is read as each call asks,
 * so a new setting applies to the next call.
 */
export class JudgeSlots {
  private busy = 0;
  private max = 1;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: () => Promise<number> | number) {}

  /** Run `fn` once a slot is free. A stop while waiting gives up the place in the queue. */
  async run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      this.max = Math.max(1, Math.floor(await this.limit()));
    } catch {
      /* the last known limit stands */
    }
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.busy -= 1;
      this.next();
    }
  }

  /** Calls running now, and waiting. */
  get load(): { running: number; waiting: number } {
    return { running: this.busy, waiting: this.waiting.length };
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.busy < this.max && this.waiting.length === 0) {
      this.busy += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        signal.removeEventListener('abort', stop);
        this.busy += 1;
        resolve();
      };
      const stop = () => {
        const at = this.waiting.indexOf(go);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', stop, { once: true });
      this.waiting.push(go);
      this.next();
    });
  }

  private next() {
    while (this.busy < this.max && this.waiting.length) this.waiting.shift()?.();
  }
}

export { canonicalFamily, sameFamily };

/** The family a model id points to when the registry does not know the model (an engine's own model name). */
export function familyFromModelId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (/^(anthropic\/|claude)/i.test(id)) return 'anthropic';
  if (/^(openai\/|gpt|o[134](-|$))/i.test(id)) return 'openai';
  if (/^(google\/|gemini)/i.test(id)) return 'google';
  return null;
}

export interface JudgeOpts {
  /** The family that wrote the text being checked: models of other families go first. */
  generatorFamily?: string | undefined;
  /** The scope's say on a model: why it may not be used here, or null. */
  allow?: ((m: ModelConfig) => string | null) | undefined;
}

/** Every ready model is refused by the scope (a private notebook, nothing may leave this machine). */
export function judgeNotAllowed(reasons: string[]): AncileError {
  return new AncileError({
    code: 'factcheck.judge_not_allowed',
    title: 'No allowed model can fact-check this here',
    hint: `${[...new Set(reasons)].join('. ')}. Allow a model in this notebook's scope, or add a local model, then check again.`,
    status: 422,
    errorClass: 'permanent',
  });
}

/**
 * The models that may answer a task class (utility, factcheck.verify…), best match first. Routing finds
 * them by need (TR1), so a machine with any ready chat model has an answer; it fails only when no chat
 * model is ready (routing.no_chat_model: add a key), or when the scope refuses every one
 * (factcheck.judge_not_allowed).
 */
export function judgeChain(
  registry: Pick<ModelRegistry, 'chain'>,
  taskClass: string,
  opts: JudgeOpts = {},
): ModelConfig[] {
  const base = registry.chain(
    taskClass,
    null,
    opts.generatorFamily ? { generatorFamily: opts.generatorFamily } : {},
  );
  if (!opts.allow) return base;
  const refused: string[] = [];
  const out = base.filter((m) => {
    const why = opts.allow?.(m) ?? null;
    if (why) refused.push(why);
    return !why;
  });
  if (out.length) return out;
  throw judgeNotAllowed(refused);
}

/** The models to check a claim with at a tier, with how far routing had to settle (TR1). */
export function verifierPlan(
  registry: Pick<ModelRegistry, 'resolveWant'>,
  a: {
    tier: ModelTier;
    floor?: ModelTier | undefined;
    generatorFamily?: string | null | undefined;
    allow?: JudgeOpts['allow'];
    exclude?: ReadonlySet<string> | undefined;
  },
): WantResolution {
  const res = registry.resolveWant(
    {
      tier: a.tier,
      ...(a.floor && { floor: a.floor }),
      distinct_family: 'generator',
      needs: [],
    },
    {
      generatorFamily: a.generatorFamily ?? null,
      allow: a.allow,
      ...(a.exclude && { exclude: a.exclude }),
    },
  );
  if (res.unmet === 'scope') throw judgeNotAllowed(res.refused);
  return res;
}

/** The models mission-critical mode may pick for itself, or null when it must ask (D30). */
export function criticalCheckers(
  registry: Pick<ModelRegistry, 'resolveWant'>,
  a: { generatorFamily: string | null; generatorModelId: string | null; allow?: JudgeOpts['allow'] },
): ModelConfig[] | null {
  const plan = verifierPlan(registry, {
    tier: 'balanced',
    floor: 'balanced',
    generatorFamily: a.generatorFamily,
    allow: a.allow,
    ...(a.generatorModelId && { exclude: new Set([a.generatorModelId]) }),
  });
  const ok = plan.chain.filter((m) => !a.generatorFamily || !sameFamily(m.family, a.generatorFamily));
  const first = ok[0];
  const second = first ? ok.find((m) => !sameFamily(m.family, first.family)) : undefined;
  return first && second ? [first, second] : null;
}

/* ---- Structured calls ------------------------------------------------------ */

export interface Completion {
  text: string;
  modelId: string;
  /** What the model that answered reported, and what the provider billed when it said. */
  usage?: CallUsage | undefined;
  costUsd?: number | undefined;
}

/** One model call (or a gateway chain of them) gets this long before it counts as failed. */
export const CALL_TIMEOUT_MS = 60_000;

/** Stream one request through the gateway and collect the text. `fallbacks` counts the models it fell through. */
async function complete(
  gateway: Gateway,
  chain: ModelConfig[],
  req: ModelRequest,
  signal: AbortSignal,
): Promise<Completion & { fallbacks: number }> {
  let text = '';
  let modelId = chain[0]?.id ?? '';
  let usage: CallUsage | undefined;
  let costUsd: number | undefined;
  let fallbacks = 0;
  for await (const ev of gateway.stream(chain, req, signal, { purpose: 'factcheck' })) {
    if (ev.type === 'fallback') fallbacks += 1;
    else if (ev.type === 'model') {
      modelId = ev.modelId;
      text = '';
      usage = undefined;
      costUsd = undefined;
    } else if (ev.type === 'chunk' && ev.chunk.type === 'text') text += ev.chunk.delta;
    else if (ev.type === 'chunk' && ev.chunk.type === 'finish') {
      usage = ev.chunk.usage;
      costUsd = ev.chunk.costUsd;
    }
  }
  return { text, modelId, usage, costUsd, fallbacks };
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

/** What was wrong with a reply, in words a model can act on. */
function problemWith(error: z.ZodError, raw: unknown): string {
  if (raw === undefined) return 'it was not a JSON object';
  const fields = [...new Set(error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
  return fields.length
    ? `these fields were missing or had the wrong type: ${fields.join(', ')}`
    : 'it did not have the fields asked for';
}

export interface StructuredOpts<T> {
  system?: string;
  maxOutputTokens?: number;
  /** Looks at what a reply says beyond its shape; a message means this model's reply is not usable. */
  accept?: (value: T) => string | null;
  /** Reads a reply that is dressed differently before the schema sees it (tolerant.ts). */
  normalize?: (raw: unknown) => unknown;
  /** The reply's shape as JSON Schema, for the provider's own JSON mode. */
  jsonSchema?: Record<string, unknown>;
  /** The reply's shape as an example, shown when a bad reply is asked for again. */
  shape?: string;
  /** Calls this may make (budget.ts); absent: only the chain bounds it. */
  budget?: ClaimBudget | undefined;
}

/**
 * Ask models down the chain until one returns JSON matching the schema. A reply that does not match is
 * asked again once on the same model; then that model has failed and the next is asked. Every call is
 * counted against the budget, and CheckLimit is thrown before one that would go over. Errors from the
 * gateway (every model failed) propagate.
 */
export async function structured<T>(
  deps: { gateway: Gateway; judges?: JudgeSlots | undefined; registry?: Pick<ModelRegistry, 'get'> },
  chain: ModelConfig[],
  prompt: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  opts: StructuredOpts<T> = {},
): Promise<{ value: T; modelId: string; usage: CallUsage | undefined; costUsd: number | undefined }> {
  const req: ModelRequest = {
    system: opts.system ?? SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    ...(opts.maxOutputTokens && { maxOutputTokens: opts.maxOutputTokens }),
    ...(opts.jsonSchema && { json: { schema: opts.jsonSchema } }),
  };
  const isCc = (m: ModelConfig | undefined) => m?.provider === CLAUDE_CODE_PROVIDER;
  // Every attempt that failed on the way, so the error can say what each one did (FC2).
  const failures: FailedAttempt[] = [];
  const note = (model: ModelConfig, err: unknown) => {
    if (err instanceof ChainFailedError) failures.push(...err.attempts);
    else
      failures.push({
        model: model.id,
        errorClass: 'transient',
        detail: err instanceof Error ? err.message : String(err),
      });
  };
  const read = (text: string): { value: T } | { problem: string } => {
    const raw = parseJsonValue(text);
    const parsed = schema.safeParse(opts.normalize ? opts.normalize(raw) : raw);
    if (!parsed.success) return { problem: problemWith(parsed.error, raw) };
    const why = opts.accept?.(parsed.data);
    return why ? { problem: why } : { value: parsed.data };
  };
  /** Count a finished call: its fallbacks as calls, its cost as spend (a Claude Code call costs no bill). */
  const settle = (out: Completion & { fallbacks: number }, fallback: ModelConfig) => {
    opts.budget?.charge(out.fallbacks);
    const m = chain.find((c) => c.id === out.modelId) ?? deps.registry?.get(out.modelId) ?? fallback;
    if (isCc(m)) return;
    opts.budget?.spend(out.costUsd ?? (out.usage ? priceOf(m, out.usage) : 0));
  };
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i] as ModelConfig;
    // Claude Code as a judge is asked on its own, through a slot, with a short time limit (started once
    // the slot is free); the next judge is tried if it fails or runs over. Other models fall through the
    // gateway together, up to the next Claude Code one, so that one is never reached without its limit.
    const cc = isCc(model);
    opts.budget?.take();
    const stop = chain.findIndex((m, k) => k > i && isCc(m));
    // The gateway may fall through at most as many models as the budget has calls left.
    const room = opts.budget ? opts.budget.remaining() + 1 : chain.length;
    const end = cc ? i + 1 : Math.min(stop < 0 ? chain.length : stop, i + Math.max(1, room));
    const ask = async (
      models: ModelConfig[],
      r: ModelRequest,
    ): Promise<Completion & { fallbacks: number }> => {
      if (!cc)
        return complete(
          deps.gateway,
          models,
          r,
          AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        );
      const go = () =>
        complete(
          deps.gateway,
          models,
          r,
          AbortSignal.any([signal, AbortSignal.timeout(CLAUDE_CODE_JUDGE_TIMEOUT_MS)]),
        );
      return deps.judges ? deps.judges.run(go, signal) : go();
    };
    let out: Completion & { fallbacks: number };
    try {
      out = await ask(chain.slice(i, end), req);
    } catch (err) {
      if (signal.aborted) throw err;
      note(model, err);
      if (err instanceof ChainFailedError) opts.budget?.charge(Math.max(0, err.attempts.length - 1));
      if (end >= chain.length) {
        if (cc || i === chain.length - 1 || stop < 0)
          throw failures.length > 1 || !(err instanceof ChainFailedError)
            ? new ChainFailedError(failures)
            : err;
      }
      i = end - 1;
      continue;
    }
    settle(out, model);
    let result = read(out.text);
    let answered = out;
    if ('problem' in result) {
      // One more try on the model that answered, saying what was wrong. Then it has failed.
      const asked = chain.find((m) => m.id === out.modelId) ?? model;
      try {
        opts.budget?.take();
        const again = await ask([asked], {
          ...req,
          messages: [
            ...req.messages,
            { role: 'assistant', content: out.text.slice(0, 2_000) || '(no reply)' },
            {
              role: 'user',
              content: `${REPAIR_LEAD}: ${result.problem}. Reply again with only one JSON object${
                opts.shape ? ` shaped exactly like this: ${opts.shape}` : ' with the fields asked for'
              }. No other text, no code fence, no wrapper key.`,
            },
          ],
        });
        settle(again, asked);
        answered = again;
        result = read(again.text);
      } catch (err) {
        if (err instanceof CheckLimit || signal.aborted) throw err;
        note(asked, err);
      }
    }
    if ('value' in result)
      return {
        value: result.value,
        modelId: answered.modelId,
        usage: answered.usage,
        costUsd: answered.costUsd,
      };
    // The model that answered gave the wrong shape twice: try the one after it.
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

/** The JSON the claim prompt asks for, as an example and as JSON Schema (for the provider's JSON mode). */
export const CLAIMS_SHAPE =
  '{"claims":[{"text":"Mount Everest is 8,849 metres tall.","char_start":0,"char_end":35,"importance":1,"checkable":true}]}';
export const CLAIMS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          char_start: { type: 'integer' },
          char_end: { type: 'integer' },
          importance: { type: 'number' },
          checkable: { type: 'boolean' },
        },
        required: ['text', 'char_start', 'char_end', 'importance', 'checkable'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
};

export const RawClaims = z.object({
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
  /** Shared by every fact-check: how many Claude Code judge calls run at once. */
  judges?: JudgeSlots;
}

const EXTRACT_FALLBACK = `Split the answer into atomic, verifiable claims. Give each its exact character offsets into the answer, an importance (1, 0.5 or 0.2) and whether it is checkable.

Question:
{{question}}

Answer:
{{message_text}}

Reply with one JSON object and nothing else: { "claims": [{ "text": string, "char_start": integer, "char_end": integer, "importance": 1 or 0.5 or 0.2, "checkable": true or false }] }
Return JSON matching ClaimList.`;

export async function extractClaims(
  deps: StepDeps,
  input: { answer: string; question: string; allow?: JudgeOpts['allow']; budget?: ClaimBudget | undefined },
  signal: AbortSignal,
): Promise<{ claims: ExtractedClaim[]; modelId: string }> {
  const template = await loadPrompt(deps.promptsDir, 'factcheck.extract-claims', EXTRACT_FALLBACK);
  // The answer goes in after rendering, untouched, so offsets into the prompt's copy are offsets into it.
  const slot = '@@ancile:answer@@';
  const prompt = render(template, { message_text: slot, question: input.question }).replace(
    slot,
    () => input.answer,
  );
  const chain = judgeChain(deps.registry, 'utility', { allow: input.allow });
  const { value, modelId } = await structured(deps, chain, prompt, RawClaims, signal, {
    normalize: tolerantClaims,
    jsonSchema: CLAIMS_JSON_SCHEMA,
    shape: CLAIMS_SHAPE,
    budget: input.budget,
  });
  return { claims: validateClaims(input.answer, value.claims), modelId };
}

/* ---- Gather ----------------------------------------------------------------- */

export interface Gathered {
  evidence: (ClaimEvidence & { text: string })[];
  coverage: number;
}

/** A web search the check may run: the query goes through the permission gate before it leaves. */
export type WebLookup = (query: string, signal: AbortSignal) => Promise<WebHit[] | null>;

/** The most claims one check looks up on the web: a cap on time and on what leaves this machine. */
export const WEB_MAX_QUERIES = 8;
/** Web results kept for a claim. */
export const WEB_HITS_PER_CLAIM = 3;
/** A claim with no source passage, or weaker coverage than this, is looked up on the web (FC4). */
const WEB_WHEN_COVERAGE = 0.6;

/** A search query for a claim: its words, kept short. */
export function webQuery(claim: string): string {
  const t = claim.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200).replace(/\s\S*$/, '') : t;
}

const webEvidence = (h: WebHit): Gathered['evidence'][number] => ({
  kind: 'url',
  ref: h.url,
  source_id: null,
  source_title: h.title || hostName(h.url),
  page: null,
  char_start: null,
  char_end: null,
  quote: h.snippet.slice(0, 280),
  stance: 'neutral' as Stance,
  score: 0.5,
  origin: 'web',
  text: `${h.title}\n${h.snippet}`.slice(0, EVIDENCE_CHARS),
});

export async function gatherEvidence(
  deps: StepDeps,
  input: {
    workspaceId: string;
    notebookId: string | null;
    claims: string[];
    /** Look claims your sources do not cover up on the web (FC4); absent: sources only. */
    web?: WebLookup | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<Gathered[]> {
  if (!input.claims.length) return [];
  let res: EvidenceResponse | null = null;
  if (deps.kn) {
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
  }
  const out: Gathered[] = input.claims.map((_, i) => {
    const r = res?.results[i];
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
        origin: 'source' as const,
        text: h.text,
      })),
    };
  });
  // The web, for the claims your sources cover least, up to WEB_MAX_QUERIES. A search that fails or is
  // refused leaves the claim with what the sources gave: the web adds evidence, it never removes any.
  if (input.web) {
    const order = out
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.evidence.length === 0 || g.coverage < WEB_WHEN_COVERAGE)
      .sort((a, b) => a.g.coverage - b.g.coverage)
      .slice(0, WEB_MAX_QUERIES);
    for (const { g, i } of order) {
      const claim = input.claims[i] ?? '';
      const signal = input.signal ?? new AbortController().signal;
      const hits = await input.web(webQuery(claim), signal).catch(() => null);
      if (hits?.length) g.evidence.push(...hits.slice(0, WEB_HITS_PER_CLAIM).map(webEvidence));
    }
  }
  return out;
}

/* ---- Verify ----------------------------------------------------------------- */

/** The JSON the verify prompts ask for, as an example and as JSON Schema (for the provider's JSON mode). */
export const VERDICT_SHAPE =
  '{"stance":"supported","evidence":[{"ref":"E1","quote":"Everest is 8,849 m tall.","stance":"supports"}],"rationale":"E1 gives the same height.","confidence":0.9}';
export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    stance: { type: 'string', enum: ['supported', 'contradicted', 'insufficient'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          quote: { type: 'string' },
          stance: { type: 'string', enum: ['supports', 'contradicts', 'neutral'] },
        },
        required: ['ref', 'quote', 'stance'],
        additionalProperties: false,
      },
    },
    rationale: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['stance', 'evidence', 'rationale', 'confidence'],
  additionalProperties: false,
};

export const RawVerdict = z.object({
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
  /** How sure the model is, 0 to 1. Optional: models that leave it out are not second-guessed. */
  confidence: z.coerce.number().min(0).max(1).optional(),
});

const VERIFY_FALLBACK = `Judge the claim strictly against the evidence: supported, contradicted or insufficient. For each piece of evidence you relied on, give its ref, the shortest exact quote and whether it supports or contradicts.

Claim:
{{claim}}

Evidence:
{{evidence}}

Reply with one JSON object and nothing else, with exactly these fields:
- "stance": a string, one of "supported", "contradicted", "insufficient"
- "evidence": a list; each item is { "ref": the evidence number such as "E1", "quote": the exact words, "stance": "supports" or "contradicts" }. An empty list when none.
- "rationale": a string, one or two sentences
- "confidence": a number from 0 to 1
Example: {"stance":"supported","evidence":[{"ref":"E1","quote":"Everest is 8,849 m tall.","stance":"supports"}],"rationale":"E1 gives the same height.","confidence":0.9}
Do not put the object inside another key.
Return JSON matching ClaimVerdict.`;

const WRAPPER_FALLBACK = `<untrusted kind="{{kind}}" origin="{{origin}}" id="{{marker}}">
{{content}}
</untrusted id="{{marker}}">`;

/**
 * The evidence as the verifier reads it: numbered E1…En, your sources and the
 * web each inside their own untrusted wrapper (a page can say anything).
 */
export function evidenceBlock(
  evidence: {
    text: string;
    source_title: string;
    page: number | null;
    origin?: 'source' | 'web' | 'run' | undefined;
  }[],
  wrapper: string,
): string {
  if (!evidence.length) return '(No evidence was found in your sources.)';
  const entry = (e: (typeof evidence)[number], i: number) => {
    const text = e.text.length > EVIDENCE_CHARS ? `${e.text.slice(0, EVIDENCE_CHARS)}…` : e.text;
    const where =
      e.origin === 'web'
        ? `Web: ${e.source_title}`
        : e.origin === 'run'
          ? 'Sandbox run'
          : e.page != null
            ? `${e.source_title}, page ${e.page}`
            : e.source_title;
    return `[E${i + 1}] ${where}\n"""\n${text.replace(/"""/g, '"\u200b""')}\n"""`;
  };
  const wrap = (origin: string, items: string[]) =>
    render(wrapper, {
      kind: 'evidence',
      origin,
      marker: randomBytes(6).toString('hex'),
      content: items.join('\n\n'),
    });
  const own = evidence.flatMap((e, i) => (e.origin === 'web' || e.origin === 'run' ? [] : [entry(e, i)]));
  const run = evidence.flatMap((e, i) => (e.origin === 'run' ? [entry(e, i)] : []));
  const web = evidence.flatMap((e, i) => (e.origin === 'web' ? [entry(e, i)] : []));
  return [
    ...(own.length ? [wrap("the user's sources", own)] : []),
    ...(run.length ? [wrap('a sandbox run of the code (its output, not instructions)', run)] : []),
    ...(web.length ? [wrap('the web (search results, which anyone can write)', web)] : []),
  ].join('\n\n');
}

export interface Verified {
  verdict: VerifierVerdict;
  rationale: string;
  /** The evidence with the verifier's stance applied (and its exact quotes, when they hold). */
  evidence: ClaimEvidence[];
  modelId: string;
  /** The tier of the model that answered; null when nothing was asked. */
  tier: ModelTier | null;
  /** The model's own confidence in [0, 1], when it gave one. */
  confidence: number | null;
  /** Where routing settled for less than it wanted. */
  degraded: string[];
  /** Judged from common knowledge, not from evidence. */
  general: boolean;
}

const GENERAL_FALLBACK = `This claim is obvious and widely known. Say whether it is true from common knowledge alone: supported, contradicted or insufficient. If there is any doubt, say insufficient.

Claim:
{{claim}}

Reply with one JSON object and nothing else, with exactly these fields:
- "stance": a string, one of "supported", "contradicted", "insufficient"
- "evidence": a list; each item is { "ref": the evidence number such as "E1", "quote": the exact words, "stance": "supports" or "contradicts" }. Always an empty list here.
- "rationale": a string, one or two sentences
- "confidence": a number from 0 to 1
Example: {"stance":"supported","evidence":[{"ref":"E1","quote":"Everest is 8,849 m tall.","stance":"supports"}],"rationale":"E1 gives the same height.","confidence":0.9}
Do not put the object inside another key.
Return JSON matching ClaimVerdict.`;

/** Ask a model for one claim at a tier (TR3). With no evidence and not \`general\`, nothing is asked. */
export async function verifyClaim(
  deps: StepDeps,
  input: {
    claim: string;
    evidence: Gathered['evidence'];
    generatorFamily: string | null;
    allow?: JudgeOpts['allow'];
    /** The tier to start at (default small) and the lowest acceptable. */
    tier?: ModelTier;
    floor?: ModelTier | undefined;
    /** Judge from common knowledge when there is no evidence (an obvious claim). */
    general?: boolean;
    /** Models that may not be used (already asked, or the writer). */
    exclude?: ReadonlySet<string> | undefined;
    /** Ask exactly these models, in order (the person chose them). */
    only?: ModelConfig[] | undefined;
    /** The calls this claim may still make (budget.ts). */
    budget?: ClaimBudget | undefined;
  },
  signal: AbortSignal,
): Promise<Verified> {
  const strip = (e: Gathered['evidence'][number]): ClaimEvidence => {
    const { text: _t, ...rest } = e;
    return rest;
  };
  const general = !!input.general && input.evidence.length === 0;
  if (!input.evidence.length && !general)
    return {
      verdict: 'insufficient',
      rationale: 'Nothing in your sources mentions this.',
      evidence: [],
      modelId: '',
      tier: null,
      confidence: null,
      degraded: [],
      general: false,
    };
  let prompt: string;
  if (general) {
    const t = await loadPrompt(deps.promptsDir, 'factcheck.verify-general', GENERAL_FALLBACK);
    prompt = render(t, { claim: input.claim });
  } else {
    const [template, wrapper] = await Promise.all([
      loadPrompt(deps.promptsDir, 'factcheck.verify-claim', VERIFY_FALLBACK),
      loadPrompt(deps.promptsDir, 'system.untrusted-wrapper', WRAPPER_FALLBACK),
    ]);
    prompt = render(template, { claim: input.claim, evidence: evidenceBlock(input.evidence, wrapper) });
  }
  let chain: ModelConfig[];
  let degraded: string[] = [];
  if (input.only?.length) chain = input.only;
  else {
    const plan = verifierPlan(deps.registry, {
      tier: input.tier ?? 'fast',
      floor: input.floor,
      generatorFamily: input.generatorFamily,
      allow: input.allow,
      exclude: input.exclude,
    });
    if (!plan.chain.length) throw new NeedsChoice();
    chain = plan.chain;
    degraded = plan.degraded;
  }
  const { value, modelId } = await structured(deps, chain, prompt, RawVerdict, signal, {
    normalize: tolerantVerdict,
    jsonSchema: VERDICT_JSON_SCHEMA,
    shape: VERDICT_SHAPE,
    budget: input.budget,
  });
  const answered = chain.find((m) => m.id === modelId) ?? deps.registry.get(modelId);
  const tier = answered ? deps.registry.tierOf(answered) : null;

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
  return {
    verdict: value.stance,
    rationale: value.rationale.trim(),
    evidence,
    modelId,
    tier,
    confidence: value.confidence ?? null,
    degraded,
    general,
  };
}

/* ---- One claim, start to finish ---------------------------------------------- */

/** How a claim was checked: the verdict and the road to it. */
export interface Checked extends Verified {
  /** Every checker's verdict, when more than one asked (mission-critical mode). */
  verdicts: VerifierVerdict[];
  /** The tier it started at when it was sent up, else null. */
  escalatedFrom: ModelTier | null;
  /** Answered from an earlier check; nothing was asked of a model. */
  cached: { at: string; model_id: string | null; scope: 'notebook' | 'global' } | null;
}

const worst = (vs: VerifierVerdict[]): VerifierVerdict =>
  vs.includes('contradicted')
    ? 'contradicted'
    : vs.every((v) => v === 'supported')
      ? 'supported'
      : 'insufficient';

export interface CheckDeps extends StepDeps {
  cache?: VerdictCache | undefined;
}

/**
 * Check one claim. A cached verdict answers first (unless `again`). Otherwise a model of the claim's
 * tier asks; low confidence, disagreement with the writer or criticality send it up a tier, twice at
 * most (TR3). Mission-critical mode asks two checkers at standard tier or better, or exactly the
 * ones the person chose, and the claim holds only if both agree.
 */
export async function checkClaim(
  deps: CheckDeps,
  input: {
    claim: string;
    evidence: Gathered['evidence'];
    triage: Triage;
    critical: boolean;
    generatorFamily: string | null;
    generatorModelId?: string | null;
    allow?: JudgeOpts['allow'];
    /** Models the person chose for a critical check. */
    chosen?: ModelConfig[] | undefined;
    notebookId: string | null;
    sharing: boolean;
    again?: boolean | undefined;
    /** The calls this claim may make (budget.ts); absent: only the chain bounds it. */
    budget?: ClaimBudget | undefined;
  },
  signal: AbortSignal,
): Promise<Checked> {
  const cacheArgs = {
    notebookId: input.notebookId,
    shared: input.sharing,
    claim: input.claim,
    evidence: input.evidence,
    critical: input.critical,
  };
  if (deps.cache && !input.again && input.evidence.length + (input.triage.obvious ? 1 : 0) > 0) {
    const hit = await deps.cache.lookup(cacheArgs);
    if (hit) {
      const v = hit.entry.verdict;
      return {
        verdict: v.stance,
        rationale: v.rationale,
        evidence: v.evidence,
        modelId: hit.entry.model_id ?? '',
        tier: hit.entry.tier,
        confidence: v.confidence,
        degraded: [],
        general: v.general,
        verdicts: [v.stance],
        escalatedFrom: null,
        cached: { at: hit.entry.created_at, model_id: hit.entry.model_id, scope: hit.scope },
      };
    }
  }
  const ask = {
    claim: input.claim,
    evidence: input.evidence,
    generatorFamily: input.generatorFamily,
    allow: input.allow,
    budget: input.budget,
  };
  let out: Checked;
  if (input.critical) {
    const writer = input.generatorModelId ? new Set([input.generatorModelId]) : undefined;
    const models =
      input.chosen && input.chosen.length > 0
        ? input.chosen
        : (criticalCheckers(deps.registry, {
            generatorFamily: input.generatorFamily,
            generatorModelId: input.generatorModelId ?? null,
            allow: input.allow,
          }) ?? []);
    if (models.length === 0) throw needsChoice();
    const all: Verified[] = [];
    for (const m of models) all.push(await verifyClaim(deps, { ...ask, only: [m], exclude: writer }, signal));
    const first = all[0] as Verified;
    out = {
      ...first,
      verdict: worst(all.map((v) => v.verdict)),
      verdicts: all.map((v) => v.verdict),
      degraded: [
        ...new Set([
          ...all.flatMap((v) => v.degraded),
          ...all.flatMap((v) =>
            v.tier && TIER_RANK[v.tier] < TIER_RANK.balanced
              ? [`${v.modelId} is below standard tier; you chose it.`]
              : [],
          ),
        ]),
      ],
      // Two checkers often say the same thing (and "nothing in your sources" twice is noise): once is enough.
      rationale: [...new Set(all.map((v) => v.rationale).filter(Boolean))].join(' '),
      escalatedFrom: null,
      cached: null,
    };
  } else {
    let tier = input.triage.tier;
    const general = input.triage.obvious;
    const used = new Set<string>();
    let hops = 0;
    let v = await verifyClaim(deps, { ...ask, tier, floor: input.triage.floor, general }, signal);
    for (;;) {
      if (!v.modelId) break;
      used.add(v.modelId);
      const next = escalateTo({
        tier: v.tier ?? tier,
        hops,
        verdict: v.verdict,
        confidence: v.confidence,
        critical: input.triage.critical,
      });
      if (!next) break;
      // Only a stronger model is worth asking; with none ready the answer stands.
      const better = verifierPlan(deps.registry, {
        tier: next,
        floor: next,
        generatorFamily: input.generatorFamily,
        allow: input.allow,
        exclude: used,
      });
      if (!better.chain.length) break;
      // A stronger look is a bonus: if a limit is reached first, the answer already in hand stands.
      let stronger: Verified;
      try {
        stronger = await verifyClaim(
          deps,
          { ...ask, tier: next, floor: next, general, exclude: used },
          signal,
        );
      } catch (err) {
        if (err instanceof CheckLimit) break;
        throw err;
      }
      tier = next;
      hops++;
      v = stronger;
    }
    out = {
      ...v,
      verdicts: [v.verdict],
      escalatedFrom: hops > 0 ? input.triage.tier : null,
      cached: null,
    };
  }
  if (deps.cache && out.modelId) {
    await deps.cache
      .record({
        ...cacheArgs,
        verdict: {
          stance: out.verdict,
          rationale: out.rationale,
          evidence: out.evidence,
          confidence: out.confidence,
          general: out.general,
        },
        tier: out.tier,
        modelId: out.modelId,
      })
      .catch(() => undefined);
  }
  return out;
}

/** Thrown when mission-critical mode has no two independent checkers and the person has not chosen. */
export class NeedsChoice extends Error {
  readonly errorClass = 'permanent' as const;
  constructor() {
    super('factcheck.needs_choice');
    this.name = 'NeedsChoice';
  }
}
const needsChoice = () => new NeedsChoice();

export type { Stance };
