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
} from '@nvx/contracts';
import { z } from 'zod';
import { loadPrompt, render } from '../conductor/prompt';
import { ChainFailedError, type FailedAttempt, type Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import { NoRouteError } from '../gateway/router';
import type { ModelRequest } from '../gateway/types';
import type { CallUsage } from '../gateway/usage';
import type { KnowledgeClient } from '../knowledge/client';
import { REVIEWER_MAX_B, reviewerModel } from '../permissions/auto/wire';
import type { ClaimEvidence, ExtractedClaim } from './pipeline';
import type { Stance, VerifierVerdict } from './score';
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

type JudgeRegistry = Pick<ModelRegistry, 'chain' | 'all' | 'status'>;

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

/**
 * Families by one name each: Claude Code's models say `claude` where the Anthropic API's say
 * `anthropic`, but they are one family, and GR24 must not be fooled by a spelling.
 */
const FAMILY_ALIASES: Record<string, string> = { claude: 'anthropic', gpt: 'openai', gemini: 'google' };

export function canonicalFamily(family: string | null | undefined): string | null {
  if (!family) return null;
  return FAMILY_ALIASES[family.trim().toLowerCase()] ?? family.trim();
}

/** Whether two family names are one family. */
export function sameFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalFamily(a);
  const y = canonicalFamily(b);
  return !!x && !!y && x.toLowerCase() === y.toLowerCase();
}

/** The family a model id points to when the registry does not know the model (an engine's own model name). */
export function familyFromModelId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (/^(anthropic\/|claude)/i.test(id)) return 'anthropic';
  if (/^(openai\/|gpt|o[134](-|$))/i.test(id)) return 'openai';
  if (/^(google\/|gemini)/i.test(id)) return 'google';
  return null;
}

/** What the registry can say about the models set for a step (a ModelRegistry does; a test double need not). */
type JudgeRegistryFull = JudgeRegistry & Partial<Pick<ModelRegistry, 'configured'>>;

const STATUS_WORDS: Record<string, string> = {
  needs_key: 'no key saved',
  disabled: 'switched off',
  signed_out: 'signed out',
  not_pulled: 'not pulled in Ollama',
  ready: 'ready',
};

/** Each thing a judge search looked at, and why it was skipped: the error names them all (FC2). */
export function triedWords(registry: JudgeRegistryFull, taskClass: string): string[] {
  const out: string[] = [];
  const set = registry.configured?.(taskClass) ?? [];
  for (const m of set) out.push(`${m.name} (${STATUS_WORDS[m.status] ?? m.status})`);
  if (!set.length)
    out.push(
      `the models set for ${taskClass === 'utility' ? 'utility tasks' : 'fact-checking'} (none is set or ready)`,
    );
  const cc = registry.all().filter((m) => m.provider === CLAUDE_CODE_PROVIDER);
  const quick = cc.find((m) => m.id === CLAUDE_CODE_JUDGE) ?? cc[0];
  if (!quick) out.push('Claude Code (not installed or not verified)');
  else out.push(`Claude Code (${STATUS_WORDS[registry.status(quick)] ?? registry.status(quick)})`);
  out.push(`a small Ollama model you pulled (none of ${REVIEWER_MAX_B}B or less is ready)`);
  return out;
}

/** The error when no judge can be found, saying each thing that was tried. */
export function noJudge(taskClass: string, tried: string[] = []): AncileError {
  const list = tried.length
    ? `Tried ${tried.join('; ')}.`
    : `Tried the models set for ${taskClass === 'utility' ? 'utility tasks' : 'fact-checking'} (none is ready), ` +
      'Claude Code (not installed or not verified) and a small Ollama model you pulled ' +
      `(none of ${REVIEWER_MAX_B}B or less).`;
  return new AncileError({
    code: 'factcheck.no_model',
    title: 'No model is ready to fact-check',
    hint: `${list} Add a provider key in Settings → Models, set up Claude Code in Settings → Claude Code, or pull a small model with Ollama.`,
    status: 422,
    errorClass: 'permanent',
  });
}

/**
 * Guard rail GR24: a fact-check is judged by a different model family from
 * the one that wrote the text. When none is ready, say so and do not run: there
 * is no same-family fallback.
 */
export function noOtherFamily(family: string, skipped: string[]): AncileError {
  return new AncileError({
    code: 'factcheck.no_other_family',
    title: 'No second opinion is available',
    hint:
      `This was written by a ${family} model, and a fact-check is always judged by a model from a different family. ` +
      `${skipped.length ? `Skipped: ${skipped.join('; ')}. ` : 'None is ready. '}` +
      'Add a provider key for another family in Settings → Models, or pull a small Ollama model, then check again.',
    status: 422,
    errorClass: 'permanent',
  });
}

/** Every judge that was ready is one the scope keeps out of this notebook. */
export function judgeNotAllowed(reasons: string[]): AncileError {
  return new AncileError({
    code: 'factcheck.judge_not_allowed',
    title: 'No allowed model can fact-check this here',
    hint: `${[...new Set(reasons)].join('. ')}. Allow a model in this notebook's scope, or add a local model, then check again.`,
    status: 422,
    errorClass: 'permanent',
  });
}

export interface JudgeOpts {
  /** The family that wrote the text being checked. */
  generatorFamily?: string | undefined;
  /** GR24: models of the writer's family never judge, and there is no fallback to one. */
  strict?: boolean;
  /** The scope's say on a model: why it may not be used here, or null. */
  allow?: ((m: ModelConfig) => string | null) | undefined;
}

/** Claude Code's quickest model, then the smallest pulled local one: the judges when no model is set. */
function fallbackJudges(registry: JudgeRegistryFull): ModelConfig[] {
  const out: ModelConfig[] = [];
  const cc = registry.all().find((m) => m.id === CLAUDE_CODE_JUDGE && registry.status(m) === 'ready');
  if (cc) out.push({ ...cc, enabled: true });
  const local = reviewerModel(registry);
  if (local) out.push(local);
  return out;
}

/**
 * The models that may judge a step: the chain set for it, else Claude
 * Code's quickest model and then the smallest pulled local model. With
 * `strict` (every fact-check, GR24) the writer's family is dropped and the
 * fallbacks are offered too, so another family is found whenever there is
 * one. Throws factcheck.no_model, naming what was tried, when there is none;
 * factcheck.no_other_family when only the writer's family is ready; and
 * factcheck.judge_not_allowed when the scope keeps every ready one out.
 */
export function judgeChain(
  registry: JudgeRegistryFull,
  taskClass: string,
  opts: JudgeOpts = {},
): ModelConfig[] {
  let base: ModelConfig[] = [];
  try {
    base = registry.chain(
      taskClass,
      null,
      opts.generatorFamily ? { generatorFamily: opts.generatorFamily } : {},
    );
  } catch (err) {
    if (!(err instanceof NoRouteError)) throw err;
  }
  const plain = !opts.strict && !opts.allow;
  if (plain && base.length) return base;
  const seen = new Set<string>();
  const candidates = (opts.strict || !base.length ? [...base, ...fallbackJudges(registry)] : base).filter(
    (m) => !seen.has(m.id) && !!seen.add(m.id),
  );
  if (plain) {
    if (!candidates.length) throw noJudge(taskClass, triedWords(registry, taskClass));
    return candidates;
  }
  const skippedFamily: string[] = [];
  const refused: string[] = [];
  const out: ModelConfig[] = [];
  for (const m of candidates) {
    if (opts.strict && opts.generatorFamily && sameFamily(m.family, opts.generatorFamily)) {
      skippedFamily.push(`${m.display_name} (same family as the writer)`);
      continue;
    }
    const why = opts.allow?.(m) ?? null;
    if (why) {
      refused.push(why);
      continue;
    }
    out.push(m);
  }
  if (out.length) return out;
  if (refused.length) throw judgeNotAllowed(refused);
  if (skippedFamily.length && opts.generatorFamily) throw noOtherFamily(opts.generatorFamily, skippedFamily);
  throw noJudge(taskClass, triedWords(registry, taskClass));
}

/* ---- Structured calls ------------------------------------------------------ */

export interface Completion {
  text: string;
  modelId: string;
  /** What the model that answered reported, and what the provider billed when it said. */
  usage?: CallUsage | undefined;
  costUsd?: number | undefined;
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
  let usage: CallUsage | undefined;
  let costUsd: number | undefined;
  for await (const ev of gateway.stream(chain, req, signal)) {
    if (ev.type === 'model') {
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
  return { text, modelId, usage, costUsd };
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
  deps: { gateway: Gateway; judges?: JudgeSlots | undefined },
  chain: ModelConfig[],
  prompt: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  opts: {
    system?: string;
    maxOutputTokens?: number;
    /** Looks at what a reply says beyond its shape; a message means this model's reply is not usable. */
    accept?: (value: T) => string | null;
  } = {},
): Promise<{ value: T; modelId: string; usage: CallUsage | undefined; costUsd: number | undefined }> {
  const req: ModelRequest = {
    system: opts.system ?? SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    ...(opts.maxOutputTokens && { maxOutputTokens: opts.maxOutputTokens }),
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
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i] as ModelConfig;
    // Claude Code as a judge is asked on its own, through a slot, with a short time limit (started once
    // the slot is free); the next judge is tried if it fails or runs over. Other models fall through the
    // gateway together, up to the next Claude Code one, so that one is never reached without its limit.
    const cc = isCc(model);
    let out: Completion;
    try {
      if (cc) {
        const ask = () =>
          complete(
            deps.gateway,
            [model],
            req,
            AbortSignal.any([signal, AbortSignal.timeout(CLAUDE_CODE_JUDGE_TIMEOUT_MS)]),
          );
        out = deps.judges ? await deps.judges.run(ask, signal) : await ask();
      } else {
        const stop = chain.findIndex((m, k) => k > i && isCc(m));
        out = await complete(deps.gateway, chain.slice(i, stop < 0 ? undefined : stop), req, signal);
      }
    } catch (err) {
      if (signal.aborted) throw err;
      note(model, err);
      if (i === chain.length - 1)
        throw failures.length > 1 || !(err instanceof ChainFailedError)
          ? new ChainFailedError(failures)
          : err;
      if (!cc) {
        // Every model up to the next Claude Code one failed: go on from there.
        const stop = chain.findIndex((m, k) => k > i && isCc(m));
        if (stop < 0) throw err;
        i = stop - 1;
      }
      continue;
    }
    const parsed = schema.safeParse(parseJsonObject(out.text));
    if (parsed.success && !opts.accept?.(parsed.data))
      return { value: parsed.data, modelId: out.modelId, usage: out.usage, costUsd: out.costUsd };
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
  /** Shared by every fact-check: how many Claude Code judge calls run at once. */
  judges?: JudgeSlots;
}

const EXTRACT_FALLBACK = `Split the answer into atomic, verifiable claims. Give each its exact character offsets into the answer, an importance (1, 0.5 or 0.2) and whether it is checkable.

Question:
{{question}}

Answer:
{{message_text}}

Return JSON matching ClaimList: { "claims": [{ "text", "char_start", "char_end", "importance", "checkable" }] }`;

export async function extractClaims(
  deps: StepDeps,
  input: { answer: string; question: string; allow?: JudgeOpts['allow'] },
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
  const { value, modelId } = await structured(deps, chain, prompt, RawClaims, signal);
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
}

export async function verifyClaim(
  deps: StepDeps,
  input: {
    claim: string;
    evidence: Gathered['evidence'];
    generatorFamily: string | null;
    /** GR24: the writer's family never judges and there is no fallback to it (default: yes). */
    strict?: boolean;
    allow?: JudgeOpts['allow'];
  },
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
  const chain = judgeChain(deps.registry, 'factcheck.verify', {
    ...(input.generatorFamily && { generatorFamily: input.generatorFamily }),
    strict: input.strict ?? true,
    allow: input.allow,
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
