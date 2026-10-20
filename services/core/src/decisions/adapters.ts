/**
 * ------------------------------------------------------------------
 *  Title    |  Decision models: the provider adapters
 *  Ref      |  docs/decisions.md (Providers)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Send one DecisionRequest to one route and give back the
 *           |  typed answers, the tokens used and the cost, whatever
 *           |  the provider calls them.
 *  How      |  Two wire shapes. `jev` (Jev on OpenRouter or TypeSafe,
 *           |  Perplexity, OpenAI's preview, a Clef-flash or Laya
 *           |  server): POST {state, questions} with a model name, and
 *           |  answers come back under `answers`. `cloudflare`: the
 *           |  same body to the Workers AI run URL, wrapped in
 *           |  {result, success, errors}. Every call goes through
 *           |  packages/resilience (timeout, one retry, breaker).
 *  Note     |  A failure names its status and, when the provider sent
 *           |  one, a short message of its own; never the key and
 *           |  never the request. 402 and Cloudflare's 4006 carry a
 *           |  code the router uses to leave the route.
 * ------------------------------------------------------------------
 */

import type { DecisionAnswer, DecisionQuestion, DecisionRequest } from '@nvx/contracts';
import { type CircuitBreaker, ClassifiedError, classifyStatus, guarded } from '@nvx/resilience';
import { assertDirectCallAllowed, liveGuardActive } from '../gateway/e2e-guard';
import type { RouteDef } from './catalogue';

/** About four characters to a token, the usual rule when no tokenizer is at hand. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);

export interface CallInput {
  def: RouteDef;
  model: string;
  /** The key, or the Cloudflare API token. */
  key: string | undefined;
  /** Cloudflare only. */
  accountId?: string | undefined;
  /** Local only: the server's base address. */
  localUrl?: string | null | undefined;
  request: DecisionRequest;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  breaker?: CircuitBreaker | undefined;
}

export interface CallResult {
  answers: Record<string, DecisionAnswer>;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  /** USD, when the service reported it. */
  cost_usd: number | null;
}

/** Codes the router acts on. */
export const NO_CREDIT = 'decisions.no_credit';
export const ALLOWANCE_GONE = 'decisions.allowance_gone';
export const NOT_ENABLED = 'decisions.not_enabled';

/** The address a call goes to, or null when the route is not set up. */
export function urlFor(
  def: RouteDef,
  model: string,
  accountId?: string,
  localUrl?: string | null,
): string | null {
  if (def.local) return localUrl ? `${localUrl.replace(/\/+$/, '')}/v1/systemone` : null;
  if (def.shape === 'cloudflare')
    return accountId
      ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`
      : null;
  return def.url;
}

const clamp01 = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const probs = (v: unknown): Record<string, number> => {
  const o = obj(v) ?? {};
  return Object.fromEntries(
    Object.entries(o).flatMap(([k, p]) => (typeof p === 'number' && Number.isFinite(p) ? [[k, p]] : [])),
  );
};

/** Read one answer against the question that was asked; null when it does not fit. */
export function parseAnswer(q: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  const a = obj(raw);
  switch (q.type) {
    case 'noul': {
      const p = clamp01(typeof raw === 'number' ? raw : a?.noul);
      return p === null ? null : { type: 'noul', noul: p };
    }
    case 'choice': {
      const p = probs(a?.probabilities);
      let choice = typeof a?.choice === 'string' ? a.choice : null;
      if (!choice) {
        const best = Object.entries(p).sort((x, y) => y[1] - x[1])[0];
        choice = best ? best[0] : null;
      }
      if (!choice) return null;
      const confidence = clamp01(a?.confidence) ?? clamp01(p[choice]) ?? 0;
      return { type: 'choice', choice, confidence, probabilities: p };
    }
    case 'score': {
      const s = typeof a?.score === 'number' && Number.isFinite(a.score) ? a.score : null;
      if (s === null) return null;
      return {
        type: 'score',
        score: s,
        confidence: clamp01(a?.confidence) ?? 0,
        probabilities: probs(a?.probabilities),
      };
    }
    case 'box':
      return a ? { type: 'box', box: a.box ?? a } : null;
  }
}

const scrub = (text: string, key: string | undefined) => {
  let t = text;
  if (key) t = t.split(key).join('[hidden]');
  return t.replace(/\s+/g, ' ').slice(0, 160);
};

/** The provider's own short message from a JSON error body, when there is one. */
async function providerWords(
  r: Response,
  key: string | undefined,
): Promise<{ words: string; code?: number }> {
  try {
    const j = obj(await r.json());
    const e = obj(j?.error);
    const errs = j?.errors;
    const first = Array.isArray(errs) ? obj(errs[0]) : null;
    const message = [
      e?.message,
      first?.message,
      j?.message,
      j?.detail,
      typeof j?.error === 'string' ? j.error : null,
    ].find((m): m is string => typeof m === 'string' && m.length > 0);
    const code = [first?.code, e?.code].find((c): c is number => typeof c === 'number');
    return { words: message ? scrub(message, key) : '', ...(code !== undefined && { code }) };
  } catch {
    return { words: '' };
  }
}

function failure(def: RouteDef, status: number, words: string, code: number | undefined) {
  const tail = words ? `: ${words}` : '';
  const base = `${def.id} answered ${status}${tail}`;
  if (status === 402)
    return new ClassifiedError('policy', base, { status, code: NO_CREDIT, title: 'Out of credit' });
  if (def.provider === 'cloudflare' && (code === 4006 || /neurons|daily free/i.test(words)))
    return new ClassifiedError('capacity', base, { status, code: ALLOWANCE_GONE });
  if (status === 403 && /not enabled|not available|preview|access/i.test(words))
    return new ClassifiedError('policy', base, { status, code: NOT_ENABLED, title: words });
  return new ClassifiedError(classifyStatus(status, words), base, { status });
}

/** Send one request to one route. Throws a ClassifiedError on any failure. */
export async function callRoute(c: CallInput): Promise<CallResult> {
  if (!c.def.local) {
    assertDirectCallAllowed(`the ${c.def.id} decision route`);
    if (liveGuardActive()) throw new ClassifiedError('permanent', `${c.def.id}: live test run`);
  }
  const url = urlFor(c.def, c.model, c.accountId, c.localUrl);
  if (!url) throw new ClassifiedError('permanent', `${c.def.id}: not set up`);
  if (!c.def.local && !c.key) throw new ClassifiedError('permanent', `${c.def.id}: no key`);
  const doFetch = c.fetch ?? fetch;
  // The model is named in the body for every shape; Cloudflare's URL names it as well.
  const body = JSON.stringify({ model: c.model, state: c.request.state, questions: c.request.questions });

  const res = await guarded(
    {
      key: `decisions.${c.def.id}`,
      ...(c.breaker && { breaker: c.breaker }),
      timeoutMs: c.timeoutMs,
      retry: { maxAttempts: 2 },
      ...(c.signal && { signal: c.signal }),
    },
    async (s) => {
      const r = await doFetch(url, {
        method: 'POST',
        signal: s,
        headers: {
          'content-type': 'application/json',
          ...(c.key && { authorization: `Bearer ${c.key}` }),
        },
        body,
      });
      if (!r.ok) {
        const { words, code } = await providerWords(r, c.key);
        throw failure(c.def, r.status, words, code);
      }
      return (await r.json()) as unknown;
    },
  );

  const top = obj(res) ?? {};
  // Cloudflare wraps the answer: { result: {...}, success, errors }.
  const inner = c.def.shape === 'cloudflare' ? (obj(top.result) ?? top) : top;
  if (c.def.shape === 'cloudflare' && top.success === false)
    throw new ClassifiedError('permanent', `${c.def.id} reported failure`, { status: 200 });
  const rawAnswers = obj(inner.answers) ?? {};
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(c.request.questions)) {
    const a = parseAnswer(q, rawAnswers[id]);
    if (!a) throw new ClassifiedError('permanent', `${c.def.id} gave no usable answer to "${id}"`);
    answers[id] = a;
  }
  const usage = obj(inner.usage) ?? {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const cost =
    typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
  return {
    answers,
    model: typeof inner.model === 'string' ? inner.model : c.model,
    input_tokens: n(usage.input_tokens) ?? n(usage.prompt_tokens),
    output_tokens: n(usage.output_tokens) ?? n(usage.completion_tokens),
    cost_usd: cost,
  };
}

/** Is a decision server answering at `baseUrl`? A cheap GET of its model list. */
export async function probeLocal(
  baseUrl: string,
  key: string | undefined,
  opts: { fetch?: typeof fetch | undefined; breaker?: CircuitBreaker | undefined; timeoutMs?: number } = {},
): Promise<boolean> {
  const doFetch = opts.fetch ?? fetch;
  try {
    return await guarded(
      {
        key: 'decisions.local.probe',
        ...(opts.breaker && { breaker: opts.breaker }),
        timeoutMs: opts.timeoutMs ?? 1_500,
        retry: { maxAttempts: 1 },
      },
      async (s) => {
        const r = await doFetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
          signal: s,
          ...(key && { headers: { authorization: `Bearer ${key}` } }),
        });
        await r.body?.cancel().catch(() => undefined);
        return r.ok;
      },
    );
  } catch {
    return false;
  }
}
