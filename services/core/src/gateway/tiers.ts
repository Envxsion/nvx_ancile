/**
 * ------------------------------------------------------------------
 *  Title    |  Model tiers and routing by need
 *  Ref      |  DESIGN.md D30 · roadmap TR1, TR2 · docs/models.md (Tiers)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Give every model a tier (tiny, small, standard, frontier;
 *           |  stored as tiny, fast, balanced, best) and answer "which
 *           |  ready model fits this need?" without anyone listing the
 *           |  models by hand.
 *  How      |  assignTier: your override, else the model's line (Opus is
 *           |  frontier, Sonnet standard, Haiku small; an OpenRouter id
 *           |  like anthropic/claude-sonnet-4.5 is read as its vendor's),
 *           |  else its size from the id (10B or less tiny, up to 40B
 *           |  small, above standard; a mixture's active size counts),
 *           |  else its price, else small. Never frontier from a guess
 *           |  except by price.
 *           |  resolveWant: filter ready chat models by what the task
 *           |  needs, order by tier distance then price, and widen in a
 *           |  fixed order (drop the other-family preference, one tier up
 *           |  or down, any ready model) saying so in `degraded`. It
 *           |  throws only when no chat model is ready at all.
 *  Note     |  Plan engines (Claude Code) sort after paid keys at the same
 *           |  tier: a plan's limit is shared with your own work.
 *           |  sourceRank is the hook for payment sources (PS1).
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  CLAUDE_CODE_PROVIDER,
  type ModelConfig,
  type ModelTier,
  TIER_RANK,
  type TierSource,
  type Want,
} from '@nvx/contracts';
import { tierLineOf } from '../models/watch/lines';
import { isSubscription } from './router';

/**
 * Families by one name each: Claude Code's models say `claude` where the Anthropic API's say
 * `anthropic`, but they are one family, and an independent check must not be fooled by a spelling.
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

export interface TierAssignment {
  tier: ModelTier;
  source: TierSource;
}

/** The plain word for a stored tier, for people. */
export const TIER_WORD: Record<ModelTier, string> = {
  tiny: 'tiny',
  fast: 'small',
  balanced: 'standard',
  best: 'frontier',
};

const BY_RANK: ModelTier[] = ['tiny', 'fast', 'balanced', 'best'];

/** One tier up, or the same at the top. */
export const tierUp = (t: ModelTier): ModelTier => BY_RANK[Math.min(3, TIER_RANK[t] + 1)] as ModelTier;
/** One tier down, or the same at the bottom. */
export const tierDown = (t: ModelTier): ModelTier => BY_RANK[Math.max(0, TIER_RANK[t] - 1)] as ModelTier;

/**
 * Parameter counts, in billions, read from an id: `llama3.1:8b`, `qwen3-72b`, `mixtral-8x7b`,
 * `qwen3-30b-a3b` (30 total, 3 active), `smollm2:360m`. Null when the id says nothing.
 */
export function sizeBillions(providerModel: string): { total: number; active: number } | null {
  const id = providerModel.toLowerCase();
  const active = /(?:^|[^a-z0-9])a(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(id);
  const moe = /(?:^|[^a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(id);
  const plain = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(id);
  const mega = /(?:^|[^a-z0-9.])(\d+)m(?![a-z0-9])/.exec(id);
  let total: number | null = null;
  if (moe) total = Number(moe[1]) * Number(moe[2]);
  else if (plain) total = Number(plain[1]);
  else if (mega) total = Number(mega[1]) / 1000;
  if (total === null) return null;
  return { total, active: active ? Number(active[1]) : total };
}

const TINY_NAME = /(^|[-_:/])(mini|nano|tiny|micro|lite)($|[-_:.])/;

/** Tier from the size an id carries (TR2): 10B or less tiny, up to 40B small, above that standard. */
export function tierFromSize(providerModel: string): ModelTier | null {
  const s = sizeBillions(providerModel);
  if (s) {
    const b = s.active;
    return b <= 10 ? 'tiny' : b <= 40 ? 'fast' : 'balanced';
  }
  return TINY_NAME.test(providerModel.toLowerCase()) ? 'tiny' : null;
}

/** Tier from price alone, per million output tokens: a last resort, and the only guess that can say frontier. */
export function tierFromPrice(m: Pick<ModelConfig, 'price'>): ModelTier | null {
  const out = m.price.output_per_mtok;
  if (!(out > 0)) return null;
  if (out >= 15) return 'best';
  if (out >= 2) return 'balanced';
  if (out >= 0.25) return 'fast';
  return 'tiny';
}

/** A Claude Code model's name says its line: claude-code/sonnet, claude-code/claude-opus-5-5. */
const CC_LINES: [RegExp, ModelTier][] = [
  [/fable|opus/, 'best'],
  [/sonnet/, 'balanced'],
  [/haiku/, 'fast'],
];

/**
 * The tier of a model and where it came from. `override` is a tier you chose in Admin → Models; a
 * `tier:` in config/models.yaml counts the same.
 */
export function assignTier(m: ModelConfig, override?: ModelTier | null): TierAssignment {
  const pinned = override ?? m.tier;
  if (pinned) return { tier: pinned, source: 'override' };
  if (m.provider === CLAUDE_CODE_PROVIDER) {
    const name = `${m.provider_model} ${m.id}`.toLowerCase();
    const hit = CC_LINES.find(([re]) => re.test(name));
    if (hit) return { tier: hit[1], source: 'line' };
    // Claude Code's own default is whatever your plan runs: a standard model unless you pin it.
    return { tier: 'balanced', source: 'unknown' };
  }
  const line = tierLineOf(m);
  if (line) return { tier: line, source: 'line' };
  const size = tierFromSize(m.provider_model);
  if (size) return { tier: size, source: 'size' };
  const price = tierFromPrice(m);
  if (price) return { tier: price, source: 'price' };
  return { tier: 'fast', source: 'unknown' };
}

/**
 * What the helper classes want when config/routing.yaml says nothing for them, so a task that is
 * not set up still finds a model instead of failing (TR1, TR3). Chat is the person's own choice and
 * has no default want.
 */
export function defaultWantFor(taskClass: string): Want | null {
  if (taskClass === 'utility' || taskClass.startsWith('utility.'))
    return { tier: 'fast', floor: 'tiny', needs: [] };
  if (taskClass === 'factcheck' || taskClass.startsWith('factcheck.'))
    return { tier: 'balanced', distinct_family: 'generator', needs: [] };
  return null;
}

/* ---- Routing by need ---------------------------------------------------------- */

export interface WantContext {
  /** The tier of each model; defaults to assignTier. */
  tierOf?: (m: ModelConfig) => ModelTier;
  /** Family of the model that wrote the text, for `distinct_family: 'generator'`. */
  generatorFamily?: string | null | undefined;
  /** The scope's say on a model: why it may not be used here, or null. */
  allow?: ((m: ModelConfig) => string | null) | undefined;
  /** Where the model's tokens are paid from; lower goes first. Payment sources (PS1) will fill this in. */
  sourceRank?: (m: ModelConfig) => number;
  /** Models tried first, in this order (pins), when they are ready and allowed. */
  pins?: readonly ModelConfig[];
  /** Models that may not be used (already tried, or the writer itself). */
  exclude?: ReadonlySet<string>;
}

export interface WantResolution {
  /** Models to try, best match first; empty when `unmet` says nothing fits. */
  chain: ModelConfig[];
  /** The tier of the first model, or null with an empty chain. */
  tier: ModelTier | null;
  /** Where routing settled for less than was wanted, one sentence each. */
  degraded: string[];
  /** Why the chain is empty: the scope refused every model, or none reaches the floor. */
  unmet: 'scope' | 'floor' | null;
  /** The scope's reasons, when it refused. */
  refused: string[];
}

/** The error when not one chat model is ready: the one case routing by need cannot get around. */
export function noChatModel(): AncileError {
  return new AncileError({
    code: 'routing.no_chat_model',
    title: 'No model is ready yet',
    hint: 'Add a key in Settings → Keys, set up Claude Code in Settings → Claude Code, or pull a model with Ollama.',
    status: 422,
    errorClass: 'permanent',
  });
}

const priceOf = (m: ModelConfig) =>
  isSubscription(m) ? Number.POSITIVE_INFINITY : m.price.output_per_mtok * 4 + m.price.input_per_mtok;

/**
 * The ready chat models that best fit `want`, in the order to try them. `ready` is every model that
 * could answer right now (ready, can chat); the caller owns that. Throws routing.no_chat_model only
 * when `ready` is empty.
 */
export function resolveWant(
  want: Want,
  ready: readonly ModelConfig[],
  ctx: WantContext = {},
): WantResolution {
  if (ready.length === 0) throw noChatModel();
  const tierOf = ctx.tierOf ?? ((m: ModelConfig) => assignTier(m).tier);
  const rank = (m: ModelConfig) => TIER_RANK[tierOf(m)];
  const same = sameFamily;
  const target = TIER_RANK[want.tier];
  const floor = want.floor ? TIER_RANK[want.floor] : 0;
  const degraded: string[] = [];

  const refused: string[] = [];
  let pool = ready.filter((m) => !ctx.exclude?.has(m.id));
  if (ctx.allow) {
    const allow = ctx.allow;
    pool = pool.filter((m) => {
      const why = allow(m);
      if (why) refused.push(why);
      return !why;
    });
  }
  if (pool.length === 0)
    return {
      chain: [],
      tier: null,
      degraded,
      unmet: refused.length ? 'scope' : 'floor',
      refused: [...new Set(refused)],
    };

  // What the task needs. A need nothing meets is dropped, and said.
  const needs = want.needs ?? [];
  let fit = pool.filter(
    (m) =>
      needs.every((n) => m.capabilities.includes(n)) &&
      (!want.ctx_tokens || m.context_window >= want.ctx_tokens),
  );
  if (fit.length === 0) {
    fit = pool;
    degraded.push(
      `No ready model has ${[...needs, ...(want.ctx_tokens ? [`a ${want.ctx_tokens}-token window`] : [])].join(' and ')}, so this may not work as well.`,
    );
  }
  const aboveFloor = fit.filter((m) => rank(m) >= floor);
  if (aboveFloor.length === 0) return { chain: [], tier: null, degraded, unmet: 'floor', refused: [] };

  const gen = want.distinct_family === 'generator' ? (ctx.generatorFamily ?? null) : null;
  const other = (m: ModelConfig) => !gen || !same(m.family, gen);
  const sourceRank = ctx.sourceRank ?? (() => 0);
  const order = (a: ModelConfig, b: ModelConfig) =>
    sourceRank(a) - sourceRank(b) || priceOf(a) - priceOf(b) || a.id.localeCompare(b.id);

  // Steps, in the fixed order. Each model lands in the first step it qualifies for.
  type Step = {
    why: string | null;
    test: (m: ModelConfig) => boolean;
    sort?: (a: ModelConfig, b: ModelConfig) => number;
  };
  const steps: Step[] = [
    { why: null, test: (m) => rank(m) === target && other(m) },
    { why: gen ? 'family' : null, test: (m) => rank(m) === target },
    {
      why: 'tier',
      test: (m) => Math.abs(rank(m) - target) === 1 && other(m),
      sort: (a, b) => Number(rank(a) < target) - Number(rank(b) < target) || order(a, b),
    },
    {
      why: 'tier',
      test: (m) => Math.abs(rank(m) - target) === 1,
      sort: (a, b) => Number(rank(a) < target) - Number(rank(b) < target) || order(a, b),
    },
    {
      why: 'any',
      test: () => true,
      sort: (a, b) => Math.abs(rank(a) - target) - Math.abs(rank(b) - target) || order(a, b),
    },
  ];

  const used = new Set<string>();
  const chain: ModelConfig[] = [];
  let headWhy: string | null | undefined;
  // Pins first: the task's own named models, when they qualify.
  for (const p of ctx.pins ?? []) {
    const m = aboveFloor.find((x) => x.id === p.id);
    if (m && !used.has(m.id)) {
      used.add(m.id);
      chain.push(m);
      if (headWhy === undefined) headWhy = null;
    }
  }
  for (const s of steps) {
    const hits = aboveFloor.filter((m) => !used.has(m.id) && s.test(m)).sort(s.sort ?? order);
    for (const m of hits) {
      used.add(m.id);
      chain.push(m);
      if (headWhy === undefined) headWhy = s.why;
    }
  }
  const head = chain[0] as ModelConfig;
  const headTier = tierOf(head);
  if (headWhy === 'family' && gen)
    degraded.push(
      `No ${TIER_WORD[want.tier]} model from another family is ready, so ${head.display_name} (${head.family}, the writer's family) checked it.`,
    );
  else if (headWhy === 'tier' || headWhy === 'any') {
    const gap = rank(head) < target ? 'below' : 'above';
    degraded.push(
      `No ${TIER_WORD[want.tier]} model is ready, so ${head.display_name} (${TIER_WORD[headTier]}, ${gap} what this wanted) was used.`,
    );
  }
  if (gen && headWhy !== 'family' && !other(head) && !degraded.some((d) => d.includes("writer's family")))
    degraded.push(`${head.display_name} is from the writer's family: no other family was ready.`);
  return { chain, tier: headTier, degraded, unmet: null, refused: [] };
}

/** Whether `m` is a plan engine (a subscription), for callers that sort or label by it. */
export const isPlanEngine = isSubscription;
