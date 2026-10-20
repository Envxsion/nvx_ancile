/**
 * ------------------------------------------------------------------
 *  Title    |  What a provider's error means
 *  Ref      |  roadmap GW1, PV3 · docs/errors.md (provider.*)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read a failed call's status, body and headers through
 *           |  the provider's profile and say what kind of trouble it
 *           |  is: a bad key, no credit, a rate limit, the wrong
 *           |  region, a model the key may not use. The gateway, the
 *           |  key tests and the retry policy all ask here.
 *  How      |  Pure functions. The profile's rules (profiles.ts) are
 *           |  tried in order, then a conservative default by status.
 *           |  The body is read for codes (error.code, error.type,
 *           |  error.status, base_resp.status_code...) and words.
 *  Note     |  A key is only called bad on a 401 or 403 with a body
 *           |  that sounds like authentication (or a bare 401), never
 *           |  on a rule that is not confirmed, and never on a 429 or
 *           |  a quota 403. A rule that is not confirmed and says "bad
 *           |  key" outside 401/403 becomes invalid_request with
 *           |  `suspectBadKey` set. Bodies and keys are never logged.
 * ------------------------------------------------------------------
 */

import { type ErrorClass, parseRetryAfter } from '@nvx/resilience';
import {
  AUTH_BODY_RE,
  CREDIT_BODY_RE,
  type ErrorKind,
  type ErrorRule,
  type FailureNote,
  otherRegions,
  type ProviderProfile,
  REGION_BODY_RE,
} from './profiles';

export interface ProviderErrorResult {
  kind: ErrorKind;
  /** How long the provider asked to wait (Retry-After), in ms; for rate limits, overload and server errors. */
  retryAfterMs?: number;
  /** The key may belong to another region of this provider. */
  regionHint?: boolean;
  /** An unconfirmed signal pointed at the key: say "may be", not "rejected". */
  suspectBadKey?: boolean;
  /** The matching rule is confirmed in the provider's docs. */
  confirmed: boolean;
  /** The fix is not the usual one (a spend cap, a plan window...): failureWords gives it words. */
  note?: FailureNote;
}

/** The longest Retry-After kept; a provider asking for more is treated as "later", not waited for. */
export const RETRY_AFTER_CAP_MS = 60_000;

interface ReadBody {
  /** Lower-case words of the body, for matching. */
  text: string;
  /** Every code, type, reason and status found, lower-case. */
  codes: Set<string>;
  empty: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function addCode(codes: Set<string>, v: unknown): void {
  if (typeof v === 'string' && v) codes.add(v.toLowerCase());
  else if (typeof v === 'number' && Number.isFinite(v)) codes.add(String(v));
}

/**
 * Read a body that may be a string (JSON or not), an object, or missing. The
 * error's own message (the SDK's reading of the body) adds to the words, never
 * to the codes.
 */
export function readBody(body: unknown, message = ''): ReadBody {
  let parsed: unknown = body;
  let raw = '';
  if (typeof body === 'string') {
    raw = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  } else if (body !== undefined && body !== null) {
    try {
      raw = JSON.stringify(body);
    } catch {
      raw = '';
    }
  }
  const codes = new Set<string>();
  const top = asRecord(parsed);
  if (top) {
    const err = asRecord(top.error);
    for (const o of [top, err ?? {}]) {
      addCode(codes, o.code);
      addCode(codes, o.type);
      addCode(codes, o.status);
      addCode(codes, o.reason);
    }
    // Gemini: error.details[].reason. Cloudflare: errors[].code.
    for (const list of [err?.details, top.errors, err?.errors])
      if (Array.isArray(list))
        for (const d of list) {
          const r = asRecord(d);
          if (r) {
            addCode(codes, r.reason);
            addCode(codes, r.code);
          }
        }
    // Anthropic: error.details.error_code (enforced_spend_limit_reached), which is an object, not a list.
    for (const holder of [top, err ?? {}, asRecord(top.details) ?? {}, asRecord(err?.details) ?? {}])
      addCode(codes, holder.error_code);
    // MiniMax: a non-zero base_resp.status_code, even on HTTP 200.
    const base = asRecord(top.base_resp);
    if (base && typeof base.status_code === 'number' && base.status_code !== 0)
      addCode(codes, base.status_code);
  }
  return {
    text: `${raw.slice(0, 4000)} ${message.slice(0, 1000)}`.toLowerCase(),
    codes,
    empty: raw.trim() === '' && message.trim() === '',
  };
}

const headerOf = (headers: unknown, name: string): string | undefined => {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) if (k.toLowerCase() === name && typeof v === 'string') return v;
  return undefined;
};

const ruleHit = (rule: ErrorRule, body: ReadBody): boolean => {
  if (!rule.codes && !rule.text) return true;
  const byCode = !!rule.codes?.some((c) => body.codes.has(String(c).toLowerCase()));
  const byText = !!rule.text && rule.text.test(body.text);
  if (rule.both && rule.codes && rule.text) return byCode && byText;
  return byCode || byText;
};

/** Does this 401 or 403 body sound like authentication? A bare 401 (no body at all) does. */
const authShaped = (status: number, body: ReadBody): boolean =>
  AUTH_BODY_RE.test(body.text) || (status === 401 && body.empty);

/**
 * What kind of trouble a failed call was, read through the provider's profile.
 * `status` 0 means "no HTTP status known"; a MiniMax-style body code still counts.
 */
export function classifyProviderError(
  profile: ProviderProfile,
  status: number,
  rawBody: unknown,
  headers?: unknown,
  now: number = Date.now(),
  message = '',
  ctx: { planCredit?: boolean } = {},
): ProviderErrorResult {
  const body = readBody(rawBody, message);
  const asked = parseRetryAfter(headerOf(headers, 'retry-after'), now);
  const wait = asked === undefined ? {} : { retryAfterMs: Math.min(asked, RETRY_AFTER_CAP_MS) };
  const waited = (r: ProviderErrorResult): ProviderErrorResult =>
    r.kind === 'rate_limited' || r.kind === 'overloaded' || r.kind === 'server' ? { ...r, ...wait } : r;
  // CR1: on a key that draws on the plan's monthly credit, "out of credit" means that credit is spent.
  // A tier spend cap or a limit you set yourself is not the plan credit running out, so those stay as they are.
  const done = (r: ProviderErrorResult): ProviderErrorResult =>
    waited(
      ctx.planCredit && r.kind === 'no_credit' && r.note !== 'spend_cap' && r.note !== 'own_limit'
        ? { ...r, kind: 'credit_exhausted' }
        : r,
    );

  for (const rule of profile.errors) {
    if (rule.status && !rule.status.includes(status)) continue;
    if (!ruleHit(rule, body)) continue;
    if (rule.kind === 'bad_key') {
      const authStatus = status === 401 || status === 403;
      // An unconfirmed signal is never proof of a bad key, and neither is a status that is not an auth status.
      if (!authStatus || !rule.confirmed)
        return done(
          authStatus
            ? { kind: 'bad_key', confirmed: false, ...(rule.regionHint && { regionHint: true }) }
            : { kind: 'invalid_request', suspectBadKey: true, confirmed: false },
        );
      return done({ kind: 'bad_key', confirmed: true, ...(rule.regionHint && { regionHint: true }) });
    }
    return done({
      kind: rule.kind,
      confirmed: rule.confirmed,
      ...(rule.regionHint && { regionHint: true }),
      ...(rule.note && { note: rule.note }),
    });
  }

  // Nothing in the profile matched: a conservative default by status.
  const hasRegions = !!profile.regions;
  if (status === 402) return done({ kind: 'no_credit', confirmed: true });
  if (status === 429) {
    if (
      /(insufficient[_ ]quota|credit_balance|insufficient (balance|credits)|exceeded your current quota)/.test(
        body.text,
      )
    )
      return done({ kind: 'no_credit', confirmed: false });
    return done({ kind: 'rate_limited', confirmed: false });
  }
  if (status === 401 || status === 403) {
    if (REGION_BODY_RE.test(body.text)) return done({ kind: 'region', confirmed: false });
    if (status === 403 && CREDIT_BODY_RE.test(body.text))
      return done({ kind: 'no_credit', confirmed: false });
    if (authShaped(status, body))
      return done({ kind: 'bad_key', confirmed: false, ...(hasRegions && { regionHint: true }) });
    if (
      status === 403 &&
      /model/.test(body.text) &&
      /(access|permission|not allowed|not permitted)/.test(body.text)
    )
      return done({ kind: 'model_not_permitted', confirmed: false });
    return done({ kind: 'unknown', confirmed: false });
  }
  if (status === 529) return done({ kind: 'overloaded', confirmed: false });
  if (status === 503 && /(overload|busy|capacity)/.test(body.text))
    return done({ kind: 'overloaded', confirmed: false });
  if (status === 408 || status === 425 || status >= 500) return done({ kind: 'server', confirmed: false });
  if (status === 400 || status === 413 || status === 422)
    return done({ kind: 'invalid_request', confirmed: false });
  if (status === 404 && /model/.test(body.text) && /(not found|does not exist|no access)/.test(body.text))
    return done({ kind: 'invalid_request', confirmed: false });
  return done({ kind: 'unknown', confirmed: false });
}

/** The HTTP status, headers, body and message an SDK error or a ClassifiedError carries, as far as it does. */
export function failureParts(err: unknown): {
  status: number;
  body: unknown;
  message: string;
  headers: unknown;
} {
  const e = (err && typeof err === 'object' ? err : {}) as {
    statusCode?: unknown;
    status?: unknown;
    responseHeaders?: unknown;
    responseBody?: unknown;
    data?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const cause = (e.cause && typeof e.cause === 'object' ? e.cause : {}) as typeof e;
  const s = [e.statusCode, e.status, cause.statusCode, cause.status].find((v) => typeof v === 'number');
  return {
    status: typeof s === 'number' ? s : 0,
    // The raw body when there is one, else the parsed one.
    body: e.responseBody ?? cause.responseBody ?? e.data ?? cause.data,
    message: typeof e.message === 'string' ? e.message : '',
    headers: e.responseHeaders ?? cause.responseHeaders,
  };
}

/** classifyProviderError for anything a call threw. */
export function classifyFailure(
  profile: ProviderProfile,
  err: unknown,
  now?: number,
  ctx: { planCredit?: boolean } = {},
): ProviderErrorResult & { status: number } {
  const p = failureParts(err);
  return {
    ...classifyProviderError(profile, p.status, p.body, p.headers, now, p.message, ctx),
    status: p.status,
  };
}

/** The ErrorClass the resilience layer should see for a kind; null leaves it to the status default. */
export function errorClassFor(kind: ErrorKind): ErrorClass | null {
  switch (kind) {
    case 'bad_key':
    case 'no_credit':
    case 'credit_exhausted':
    case 'region':
    case 'model_not_permitted':
      return 'permanent';
    case 'rate_limited':
    case 'overloaded':
    case 'server':
      return 'transient';
    default:
      return null;
  }
}

export interface FailureWords {
  code: string;
  title: string;
  hint: string;
}

/**
 * Words for the failures whose fix is not "top up" (docs/errors.md, provider.no_credit). Each is from the
 * provider's own docs: Anthropic's errors and rate-limits pages, Z.ai's Coding Plan FAQ, MiniMax's plan FAQ,
 * OpenRouter's limits page.
 */
const NOTE_WORDS: Record<FailureNote, (name: string) => { title: string; hint: string }> = {
  spend_cap: (name) => ({
    title: `${name} has stopped requests at your monthly spend cap`,
    hint: `Retrying will not help. The cap resets at 00:00 UTC on the 1st of the month: until then pick another model, or check your limits in the Claude Console.`,
  }),
  own_limit: (name) => ({
    title: `You have reached the usage limit you set at ${name}`,
    hint: `Raise the limit in the Claude Console, or pick another model.`,
  }),
  billing: (name) => ({
    title: `${name} reports a billing problem`,
    hint: `Check Plans and Billing in the Claude Console: a payment may have failed. Then try again, or pick another model.`,
  }),
  plan_scope: (name) => ({
    title: `${name} says there is no balance or resource package`,
    hint: `Top up at ${name}. If this is a GLM Coding Plan key, it can also mean the plan was used from a tool it does not cover: the plan only works in its supported tools, so use a pay-as-you-go API key here.`,
  }),
  plan_limit: (name) => ({
    title: `Your ${name} Coding Plan quota is used up`,
    hint: 'The plan never draws on your account balance, so topping up will not help. Wait for the plan to reset (5-hour, weekly and monthly caps), or pick another model.',
  }),
  plan_window: (name) => ({
    title: `Your ${name} plan has no usage left in this window`,
    hint: 'Plan usage runs in 5-hour and weekly windows, and a plan key never spends your pay-as-you-go balance, so topping up will not help. Wait for the next window, or pick another model.',
  }),
  negative_balance: (name) => ({
    title: `${name} says your account is out of credit`,
    hint: `Add credit at ${name}. While the balance is below zero every model is blocked, free ones too. Then try again, or pick another model.`,
  }),
  privacy_blocked: (name) => ({
    title: `Your ${name} privacy settings block every provider for this model`,
    hint: `Allow a provider in your ${name} privacy settings (openrouter.ai/settings/privacy), or pick another model.`,
  }),
};

/**
 * The documented words for a kind (docs/errors.md), or null when the kind has
 * no code of its own. `model` names the model that was refused, when known.
 */
export function failureWords(
  kind: ErrorKind,
  profile: ProviderProfile,
  ctx: {
    model?: string | undefined;
    region?: string | null | undefined;
    regionHint?: boolean;
    note?: FailureNote | undefined;
  } = {},
): FailureWords | null {
  const name = profile.name;
  switch (kind) {
    case 'no_credit': {
      const special = ctx.note ? NOTE_WORDS[ctx.note](name) : null;
      return {
        code: 'provider.no_credit',
        title: special?.title ?? `${name} says your account is out of credit`,
        hint: special?.hint ?? `Top up at ${name}, or pick another model.`,
      };
    }
    case 'credit_exhausted':
      return {
        code: 'provider.credit_exhausted',
        title: `Your plan's monthly API credit is used up`,
        hint: 'It renews at the start of the next cycle. Until then this model is skipped: pick another, or buy credit in the Claude Console.',
      };
    case 'region': {
      const others = otherRegions(profile, ctx.region).map((r) => r.label);
      return {
        code: 'provider.wrong_region',
        title: `${name} says this key is for another region`,
        hint: others.length
          ? `Try ${others.join(' or ')}: change the region beside the key in Settings → API keys.`
          : `${name} is not available where you are. Use another provider, or a key from an account in a supported country.`,
      };
    }
    case 'model_not_permitted': {
      const special = ctx.note === 'privacy_blocked' ? NOTE_WORDS.privacy_blocked(name) : null;
      return {
        code: 'provider.model_not_permitted',
        title: special?.title ?? `${name} says this key can't use ${ctx.model ?? 'that model'}`,
        hint:
          special?.hint ?? `Pick another model, or check that your plan or project at ${name} includes it.`,
      };
    }
    case 'bad_key': {
      const others = ctx.regionHint ? otherRegions(profile, ctx.region).map((r) => r.label) : [];
      const hint = others.length
        ? `Check you copied the whole key, and that it is active. A key only works in the region it was made in: if it is for ${others.join(' or ')}, change the region beside the key.`
        : 'Check you copied the whole key, and that it is active in your provider account.';
      return {
        code: 'provider.auth_failed',
        title: `${name} rejected the API key`,
        hint: profile.keyNote ? `${hint} ${profile.keyNote}` : hint,
      };
    }
    default:
      return null;
  }
}
