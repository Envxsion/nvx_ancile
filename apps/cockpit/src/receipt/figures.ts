/**
 * ------------------------------------------------------------------
 *  Title    |  The answer's receipt: figures and wording
 *  Ref      |  roadmap WY1 · DESIGN.md §11.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the receipt says that is worked out or
 *           |  phrased, in pure functions: the cost table, what the
 *           |  cache saved, the one sentence on why this model
 *           |  answered, the line for a problem that fixed itself,
 *           |  and the ordered steps of the answer.
 *  How      |  Token maths follow the canonical meaning (Core's
 *           |  gateway/usage.ts): input counts every prompt token, so
 *           |  fresh input = input minus cache reads minus cache
 *           |  writes. Claude Code's records are the exception: they
 *           |  count cache reads apart from input, so only writes come
 *           |  off. A figure the provider never reported is
 *           |  "not reported" and one an older answer never kept is
 *           |  "not recorded": neither is ever shown as 0.
 *  Note     |  Plans and local models show tokens, never rates. The
 *           |  total is Usage.cost_usd: what the provider billed where
 *           |  it said (OpenRouter), else list price.
 * ------------------------------------------------------------------
 */

import {
  type AnswerRoute,
  type ExplainTool,
  isClaudeCodeModel,
  type ModelBilling,
  type Part,
  type Recovered,
  type Usage,
  type UsageCall,
} from '@nvx/contracts';

/* ---- who pays ---------------------------------------------------------------- */

export type PayKind = 'key' | 'plan' | 'free' | 'unknown';

/** What the figures should look like: a key shows rates and money, a plan tokens, local nothing to pay. */
export function payKind(b: ModelBilling | null | undefined): PayKind {
  if (!b) return 'unknown';
  if (b.kind === 'key' || b.kind === 'rented') return 'key';
  if (b.kind === 'plan') return 'plan';
  return 'free';
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

/** "Max plan", or "Plan" when the plan has no name. */
export const planShort = (b: ModelBilling | null | undefined): string =>
  b?.kind === 'plan' && b.payer ? `${cap(b.payer)} plan` : 'Plan';

/** Where a metered Claude Code bill goes, in words ("your Anthropic API key"). */
export function billedToWords(payer: string | null | undefined): string {
  switch (payer) {
    case 'bedrock':
      return 'Amazon Bedrock';
    case 'vertex':
      return 'Google Vertex AI';
    case 'foundry':
      return 'Microsoft Foundry';
    default:
      return 'your Anthropic API key';
  }
}

/** "Opus 5.5" from "Claude Opus 5.5": the family leads, the maker is understood. */
export const shortModelName = (name: string): string => name.replace(/^Claude\s+/i, '');

/* ---- tokens and money --------------------------------------------------------- */

export type Known =
  | { state: 'known'; tokens: number }
  | { state: 'not_reported' }
  | { state: 'not_recorded' };

export interface CostRow {
  id: 'fresh' | 'cached' | 'written' | 'output';
  label: string;
  tokens: Known;
  /** Per million tokens at the time of the answer; null when none applies. */
  rate: number | null;
  usd: number | null;
}

export interface CostTable {
  rows: CostRow[];
  /** What the answer cost: Usage.cost_usd. */
  totalUsd: number;
  /** List price from the figures above, when rates are known. */
  listUsd: number | null;
  /** Set only when the provider's bill differs from list price. */
  billed: { billedUsd: number; listUsd: number } | null;
  /** Against a cold call: every input token at the fresh rate. */
  saving: { kind: 'saved' | 'cost_more'; usd: number } | null;
  /** Rates and money are shown (a key answer with rates on record). */
  priced: boolean;
}

const EPS = 0.000_05;

const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

export function costTable(
  usage: Usage,
  opts: { billing: ModelBilling | null | undefined; cacheApart: boolean },
): CostTable {
  const kind = payKind(opts.billing);
  const rates = usage.rates;
  const priced = kind === 'key' && !!rates;
  const reportedNothing = usage.cache_reported === false;

  const cached: Known = reportedNothing
    ? { state: 'not_reported' }
    : usage.cache_reported === true || usage.cached_tokens > 0
      ? { state: 'known', tokens: usage.cached_tokens }
      : { state: 'not_recorded' };
  const written: Known = reportedNothing
    ? { state: 'not_reported' }
    : usage.cache_write_tokens !== undefined
      ? { state: 'known', tokens: usage.cache_write_tokens }
      : { state: 'not_recorded' };

  const cachedN = cached.state === 'known' ? cached.tokens : 0;
  const writtenN = written.state === 'known' ? written.tokens : 0;
  const freshN = Math.max(0, usage.input_tokens - (opts.cacheApart ? 0 : cachedN) - writtenN);

  const at = (tokens: number, rate: number | undefined) =>
    priced && rate !== undefined ? (tokens * rate) / 1_000_000 : null;
  const rows: CostRow[] = [
    {
      id: 'fresh',
      label: 'Fresh input',
      tokens: { state: 'known', tokens: freshN },
      rate: priced ? (rates?.input ?? null) : null,
      usd: at(freshN, rates?.input),
    },
    {
      id: 'cached',
      label: 'Read from cache',
      tokens: cached,
      rate: priced ? (rates?.cached ?? null) : null,
      usd: cached.state === 'known' ? at(cachedN, rates?.cached) : null,
    },
    {
      id: 'written',
      label: 'Written to cache',
      tokens: written,
      rate: priced ? (rates?.cache_write ?? null) : null,
      usd: written.state === 'known' ? at(writtenN, rates?.cache_write) : null,
    },
    {
      id: 'output',
      label: 'Output',
      tokens: { state: 'known', tokens: usage.output_tokens },
      rate: priced ? (rates?.output ?? null) : null,
      usd: at(usage.output_tokens, rates?.output),
    },
  ];

  const listUsd = priced ? sum(rows.map((r) => r.usd)) : null;
  const billed =
    usage.billed_usd !== undefined &&
    (usage.list_usd ?? listUsd) !== null &&
    Math.abs(usage.billed_usd - ((usage.list_usd ?? listUsd) as number)) > EPS
      ? { billedUsd: usage.billed_usd, listUsd: (usage.list_usd ?? listUsd) as number }
      : null;

  // A cold call pays the fresh rate for every prompt token. Unknown cache figures: no claim.
  let saving: CostTable['saving'] = null;
  if (priced && rates && cached.state === 'known' && written.state === 'known' && listUsd !== null) {
    const allInput = freshN + cachedN + writtenN;
    const cold = (allInput * rates.input + usage.output_tokens * rates.output) / 1_000_000;
    const diff = cold - listUsd;
    if (diff > EPS) saving = { kind: 'saved', usd: diff };
    else if (diff < -EPS) saving = { kind: 'cost_more', usd: -diff };
  }

  return { rows, totalUsd: usage.cost_usd, listUsd, billed, saving, priced };
}

/** Money for a receipt: more places for small sums, so a cheap answer does not read as $0.00. */
export function money(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** A price per million tokens: "$3", "$0.30". */
export const ratePerMillion = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Seconds as "6.4 s", or "420 ms" under a second. */
export function secondsWords(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)} s`;
}

/** The sentence under the cost table about caching, or null when there is nothing true to say. */
export function savingWords(saving: CostTable['saving']): string | null {
  if (!saving) return null;
  return saving.kind === 'saved'
    ? `Cache saved you ${money(saving.usd)} against a cold call.`
    : `Writing the cache cost ${money(saving.usd)} more this time; later turns read it for less.`;
}

/** "About $0.12 at API prices" for a plan answer, from the estimate Claude Code gave; null without one. */
export function planEstimateWords(usage: Usage): string | null {
  return usage.cost_usd > 0
    ? `Would have cost about ${money(usage.cost_usd)} at API prices; your plan covered it.`
    : null;
}

/* ---- the strip ------------------------------------------------------------------ */

export interface StripFacts {
  modelName: string;
  badge: string | null;
  seconds: string | null;
  cost: string;
  saved: string | null;
}

export function stripFacts(a: {
  usage: Usage;
  billing: ModelBilling | null | undefined;
  badge: string | null;
  modelName: string;
  cacheApart: boolean;
  /** Where a metered Claude Code answer was billed, in words. */
  claudeBilledTo?: string | null;
}): StripFacts {
  const kind = payKind(a.billing);
  const table = costTable(a.usage, { billing: a.billing, cacheApart: a.cacheApart });
  let cost: string;
  if (kind === 'plan') cost = planShort(a.billing);
  else if (kind === 'free') cost = 'no cost';
  else if (a.claudeBilledTo)
    cost = a.usage.cost_usd > 0 ? `about ${money(a.usage.cost_usd)}` : 'billed to your key';
  else cost = money(a.usage.cost_usd);
  return {
    modelName: shortModelName(a.modelName),
    badge: a.badge,
    seconds: a.usage.ms !== undefined ? secondsWords(a.usage.ms) : null,
    cost,
    saved: table.saving?.kind === 'saved' ? `cache saved ${money(table.saving.usd)}` : null,
  };
}

/* ---- why this model --------------------------------------------------------------- */

const ATTEMPT_WORDS: Record<string, string> = {
  transient: 'was unavailable',
  capacity: 'was busy (rate limited)',
  refusal: 'declined',
  context_overflow: 'ran out of room',
  policy: 'was blocked by a policy',
  permanent: 'failed',
  bug: 'failed',
};

export interface WhyModelInput {
  /** The name of the model that answered. */
  name: string;
  route?: AnswerRoute | undefined;
  /** Models that could not answer first, with their error class. */
  attempts: { name: string; reason: string }[];
  /** What was asked for, when it was a "latest" alias: its name without the tag. */
  aliasName?: string | null | undefined;
  /** The thread is a Claude Code session. */
  claudeCodeSession: boolean;
  flowName?: string | null | undefined;
  /** The name of a thread model that could no longer answer. */
  unreadyName?: string | null | undefined;
}

/** One or two sentences on why this model answered. */
export function whyThisModel(i: WhyModelInput): string {
  if (i.flowName) return `The ${i.flowName} flow routed it.`;
  if (i.claudeCodeSession)
    return `This thread is a Claude Code session. Claude Code chose ${shortModelName(i.name)} for it.`;
  const short = shortModelName(i.name);
  if (i.attempts.length) {
    const first = i.attempts[0];
    if (i.attempts.length === 1 && first)
      return `${shortModelName(first.name)} ${ATTEMPT_WORDS[first.reason] ?? first.reason}, so ${short} answered.`;
    const names = [...new Set(i.attempts.map((a) => shortModelName(a.name)))];
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
    return `${list} could not answer, so ${short} did.`;
  }
  if (i.aliasName) return `You chose ${shortModelName(i.aliasName)} (latest), which is ${short} now.`;
  const r = i.route;
  const skipped = r?.skipped_flow
    ? r.skipped_flow.because === 'message_model'
      ? ` The ${r.skipped_flow.name} flow was set aside for this message.`
      : ` The ${r.skipped_flow.name} flow is paused in this thread.`
    : '';
  if (r?.from === 'message') return `You picked this model for this message.${skipped}`;
  if (r?.from === 'thread') return `Your choice for this thread.${skipped}`;
  if (i.unreadyName)
    return `This thread's model, ${shortModelName(i.unreadyName)}, can no longer answer (no key, switched off or removed), so your default answered.${skipped}`;
  return `Routing picked the first ready model for ordinary chat.${skipped}`;
}

/* ---- worth knowing --------------------------------------------------------------- */

const humanTool = (t: string) => t.replace(/[_.]+/g, ' ').trim();

const REASON_TOOL: Record<string, string> = {
  rate_limited: 'was rate limited',
  timeout: 'timed out',
  server_error: 'had a server error',
  network: 'lost its connection',
};
const REASON_MODEL: Record<string, string> = {
  rate_limited: 'was rate limited',
  timeout: 'timed out',
  server_error: 'had a server error',
  network: 'lost its connection',
};

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** "The web search tool timed out once and was retried after 1.2 s." */
export function recoveredWords(r: Recovered): string {
  const failed = r.attempts - 1;
  const after = secondsWords(r.waited_ms);
  if (r.what === 'tool')
    return `The ${humanTool(r.name)} tool ${REASON_TOOL[r.reason] ?? 'failed'} ${times(failed)} and was retried after ${after}.`;
  return `${r.name} ${REASON_MODEL[r.reason] ?? 'failed'}${failed > 1 ? ` ${times(failed)}` : ''}; retried after ${after}.`;
}

const ASKED_OUTCOME: Record<string, string> = {
  approved: 'you allowed it',
  denied: 'you declined it',
  expired: 'nobody answered in time',
  policy_deny: 'a policy blocked it',
};

/** "1 tool asked you first (fs write on notes.md, you allowed it)"; null when no tool asked or was refused. */
export function askedWords(tools: ExplainTool[], resourceWords: (r: string) => string): string | null {
  const asked = tools.filter((t) => t.decision && ASKED_OUTCOME[t.decision.outcome]);
  if (!asked.length) return null;
  const items = asked.map(
    (t) =>
      `${humanTool(t.tool)} on ${resourceWords(t.decision?.resource ?? '')}, ${ASKED_OUTCOME[t.decision?.outcome ?? ''] ?? ''}`,
  );
  const noun = asked.length === 1 ? 'tool asked' : 'tools asked';
  const declinedByPolicy = asked.every((t) => t.decision?.outcome === 'policy_deny');
  return `${asked.length} ${declinedByPolicy ? (asked.length === 1 ? 'tool was refused' : 'tools were refused') : `${noun} you first`} (${items.join('; ')})`;
}

/* ---- step by step ------------------------------------------------------------------ */

export interface Step {
  id: string;
  kind: 'context' | 'model' | 'tool';
  label: string;
  detail: string | null;
  /** Right-aligned: how long it took, or null when that was not recorded. */
  ms: number | null;
  /** Right-aligned for model calls on a key: what the call cost. */
  costUsd: number | null;
  /** The step went wrong and was retried, or failed. */
  note: string | null;
  /** Offset from the start of the turn, when known. */
  atMs: number | null;
}

type ToolCall = Extract<Part, { type: 'tool_call' }>;
type ToolResult = Extract<Part, { type: 'tool_result' }>;

/** A short hint of what a tool was asked: its first short text argument. */
function argHint(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  for (const v of Object.values(args as Record<string, unknown>))
    if (typeof v === 'string' && v.trim() && v.length <= 60 && !v.includes('\n')) return v.trim();
  return null;
}

/** Runs of tool calls in the order the model made them: one run per model round that asked for tools. */
function toolRuns(parts: Part[]): ToolCall[][] {
  const runs: ToolCall[][] = [];
  let open = false;
  for (const p of parts) {
    if (p.type === 'tool_call') {
      if (!open) runs.push([]);
      runs[runs.length - 1]?.push(p);
      open = true;
    } else if (p.type === 'tool_result' || p.type === 'text') open = false;
  }
  return runs;
}

/** Tool parts from Core's explain, for an answer whose own parts are not at hand. */
export function toolPartsOf(tools: ExplainTool[]): Part[] {
  return tools.flatMap((t): Part[] => [
    { type: 'tool_call', call_id: t.call_id, tool: t.tool, args: t.args },
    ...(t.ok === null
      ? []
      : [
          {
            type: 'tool_result' as const,
            call_id: t.call_id,
            ok: t.ok,
            result: t.result,
            ...(t.declined_reason !== null && { declined_reason: t.declined_reason }),
            ...(t.duration_ms !== null && { duration_ms: t.duration_ms }),
          },
        ]),
  ]);
}

export function buildSteps(a: {
  calls: UsageCall[] | undefined;
  parts: Part[] | undefined;
  recovered: Recovered[];
  /** Show money on model calls (a key answer). */
  priced: boolean;
  /** One line on what was gathered before the first call, if known. */
  contextDetail?: string | null;
}): Step[] {
  const parts = a.parts ?? [];
  const calls = a.calls ?? [];
  const results = new Map(
    parts.flatMap((p) => (p.type === 'tool_result' ? [[p.call_id, p as ToolResult] as const] : [])),
  );
  const unusedRecoveries = [...a.recovered];
  const toolStep = (c: ToolCall): Step => {
    const r = results.get(c.call_id);
    const i = unusedRecoveries.findIndex((x) => x.what === 'tool' && x.name === c.tool);
    const rec = i >= 0 ? unusedRecoveries.splice(i, 1)[0] : undefined;
    const notes: string[] = [];
    if (rec)
      notes.push(
        `${REASON_TOOL[rec.reason]?.replace(/^was /, '') ?? 'failed'} ${times(rec.attempts - 1)}, retried`,
      );
    if (r?.declined_reason !== undefined) notes.push('declined');
    else if (r && !r.ok) notes.push('failed');
    return {
      id: `tool-${c.call_id}`,
      kind: 'tool',
      label: humanTool(c.tool),
      detail: argHint(c.args),
      ms: r?.duration_ms ?? null,
      costUsd: null,
      note: notes.length ? notes.join('; ') : null,
      atMs: null,
    };
  };

  const steps: Step[] = [];
  const first = calls[0];
  if (first && first.started_ms > 0)
    steps.push({
      id: 'context',
      kind: 'context',
      label: 'Context gathered',
      detail: a.contextDetail ?? null,
      ms: first.started_ms,
      costUsd: null,
      note: null,
      atMs: 0,
    });

  const runs = toolRuns(parts);
  let run = 0;
  calls.forEach((c, i) => {
    const asked = c.stop === 'tool_calls' || (c.stop === undefined && i < runs.length);
    const tokens = c.input_tokens + c.output_tokens;
    steps.push({
      id: `call-${i}`,
      kind: 'model',
      label: `Model call ${i + 1}`,
      detail: `${tokens.toLocaleString('en-GB')} tokens${asked ? ', asked for a tool' : c.stop === 'length' ? ', stopped at the length limit' : ', answered'}`,
      ms: c.ms,
      costUsd: a.priced ? (c.billed_usd ?? c.cost_usd) : null,
      note: c.stop === 'error' ? 'failed' : null,
      atMs: c.started_ms,
    });
    if (asked && runs[run]) for (const t of runs[run] ?? []) steps.push(toolStep(t));
    if (asked) run += 1;
  });
  // Tools no call accounts for (an older answer, or more runs than calls): after the rest.
  if (!calls.length) for (const r of runs) for (const t of r) steps.push(toolStep(t));
  else for (const r of runs.slice(run)) for (const t of r) steps.push(toolStep(t));
  return steps;
}

export { isClaudeCodeModel };
