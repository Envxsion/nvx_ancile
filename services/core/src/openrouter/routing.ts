/**
 * ------------------------------------------------------------------
 *  Title    |  OpenRouter routing presets
 *  Ref      |  docs/openrouter.md (Routing presets)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a plain-language choice (Recommended, Best
 *           |  quality, Lowest real cost, Fastest, Pinned, Advanced)
 *           |  into OpenRouter's `provider` object and a max_tokens,
 *           |  and say in words what that does and turns off.
 *  How      |  buildRouting() is pure: settings + the model's
 *           |  endpoints (when known) + what the job needs. Without
 *           |  endpoints it still builds, just without the exclusions
 *           |  that need them.
 *  Note     |  Auto Exacto (OpenRouter's ordering for tool calls) only
 *           |  runs when Ancile sets neither `order` nor `sort`;
 *           |  sort by price and the :floor suffix turn it off by
 *           |  OpenRouter's own account, and any order of ours replaces
 *           |  it. Recommended keeps it.
 * ------------------------------------------------------------------
 */

import {
  type OrEndpoint,
  type OrProviderObject,
  OrQuantization,
  QUANT_BITS,
  type RoutingPreview,
  type RoutingSettings,
} from '@nvx/contracts';
import type { Need } from './endpoints';

export interface RoutingInput {
  model: string;
  settings: RoutingSettings;
  endpoints: OrEndpoint[] | null;
  need: Need;
  /** The model's max output in Ancile, used when the settings give none. */
  modelMaxOutput: number | null;
  /** Best quality: providers config/openrouter.yaml trusts for this model, most trusted first. */
  trusted?: string[];
  /** Lowest real cost: this person's history for the model. */
  history?: { cacheHitRate: number; inputShare: number } | null;
}

/** Real cost of a turn in USD at a cache hit rate (see cost.ts for the full calculator). */
export function turnCostUsd(
  price: OrEndpoint['price'],
  t: { input: number; output: number; cacheWrite?: number; hitRate: number },
): number {
  const read = t.input * t.hitRate;
  const fresh = t.input - read;
  return (
    (fresh * price.input +
      read * (price.cache_read ?? price.input) +
      (t.cacheWrite ?? 0) * (price.cache_write ?? price.input) +
      t.output * price.output) /
    1_000_000
  );
}

/** Precisions at or above a floor (unknown never passes a floor). */
export function atLeast(floor: OrQuantization): OrQuantization[] {
  return OrQuantization.options.filter((q) => q !== 'unknown' && QUANT_BITS[q] >= QUANT_BITS[floor]);
}

/** An endpoint that cannot hold this job: too short to read it, or to answer it. */
export function tooSmall(e: OrEndpoint, need: Need, maxTokens: number | null): boolean {
  if (e.context !== null && need.context + (maxTokens ?? need.output) > e.context) return true;
  const wants = Math.max(need.output, maxTokens ?? 0);
  if (e.max_output !== null && wants > e.max_output) return true;
  if (need.tools && !e.tools) return true;
  return false;
}

const uniq = (xs: string[]) => [...new Set(xs)];

export function buildRouting(input: RoutingInput): RoutingPreview {
  const s = input.settings;
  const notes: string[] = [];
  const maxTokens = s.max_tokens ?? input.modelMaxOutput ?? null;
  const suffix = /:([a-z]+)$/i.exec(input.model)?.[1]?.toLowerCase() ?? null;

  if (s.preset === 'advanced' && s.advanced) {
    const provider = { ...s.advanced };
    if (s.deny_data_collection) provider.data_collection = 'deny';
    const exacto = !provider.order && !provider.sort && suffix !== 'floor' && suffix !== 'nitro';
    notes.push('Sent exactly as set in Advanced.');
    if (!exacto)
      notes.push(autoExactoOff(provider.sort === 'price' || suffix === 'floor' ? 'price' : 'order'));
    return { provider, max_tokens: maxTokens, auto_exacto: exacto, notes };
  }

  const eps = input.endpoints ?? [];
  const provider: OrProviderObject = { require_parameters: true };
  const avoid = new Set(s.avoid);
  const small = eps.filter((e) => tooSmall(e, input.need, maxTokens)).map((e) => e.provider);
  const usable = eps.filter((e) => !avoid.has(e.provider) && !small.includes(e.provider));

  switch (s.preset) {
    case 'recommended':
    case 'advanced': // Advanced with nothing typed yet behaves as Recommended
      notes.push('OpenRouter picks among providers that can hold this job; tool calls keep Auto Exacto.');
      break;
    case 'best_quality': {
      const trusted = (input.trusted ?? []).filter((p) => usable.some((e) => e.provider === p));
      const ranked = usable
        .filter((e) => e.original_precision !== false)
        .sort(
          (a, b) =>
            Number(b.original_precision === true) - Number(a.original_precision === true) ||
            (b.uptime ?? 0) - (a.uptime ?? 0) ||
            (b.context ?? 0) - (a.context ?? 0),
        )
        .map((e) => e.provider);
      const order = uniq([...trusted, ...ranked]);
      if (order.length) {
        provider.order = order;
        provider.only = order;
      }
      notes.push('Tries trusted providers first, at the lab’s own precision only.');
      break;
    }
    case 'lowest_cost': {
      const h = input.history ?? { cacheHitRate: 0, inputShare: 0.8 };
      const total = Math.max(1, input.need.context + (maxTokens ?? input.need.output) || 4_000);
      const t = { input: total * h.inputShare, output: total * (1 - h.inputShare), hitRate: h.cacheHitRate };
      const order = [...usable]
        .sort((a, b) => turnCostUsd(a.price, t) - turnCostUsd(b.price, t))
        .map((e) => e.provider);
      if (order.length) provider.order = order;
      provider.allow_fallbacks = true;
      notes.push(
        `Ranked by what a turn really costs at your ${Math.round(h.cacheHitRate * 100)}% cache hit rate, not list price.`,
      );
      break;
    }
    case 'fastest':
      provider.sort = 'throughput';
      notes.push('Sorted by speed (like the :nitro suffix, without its priority tier).');
      break;
    case 'pinned': {
      const order = s.providers.filter((p) => !avoid.has(p));
      if (order.length) {
        provider.order = order;
        provider.only = order;
        provider.allow_fallbacks = false;
        notes.push(`Only ${order.join(', ')}, in that order. If they are all down, the answer fails.`);
      } else notes.push('No providers pinned yet, so this behaves as Recommended.');
      break;
    }
  }

  const ignore = uniq([...avoid, ...small]).filter((p) => !provider.only?.includes(p));
  if (ignore.length) provider.ignore = ignore;
  if (small.length)
    notes.push(
      `Leaves out ${small.join(', ')}: too short to read or answer this job${input.need.tools ? ', or no tools' : ''}.`,
    );
  if (s.min_precision) {
    provider.quantizations = atLeast(s.min_precision);
    notes.push(
      `Only endpoints at ${s.min_precision.toUpperCase()} or better; ones that do not say are left out.`,
    );
  }
  if (s.deny_data_collection) {
    provider.data_collection = 'deny';
    notes.push('Only providers that do not keep or train on your prompts.');
  }
  if (maxTokens !== null) notes.push(`Answers may run to ${maxTokens.toLocaleString('en-GB')} tokens.`);

  let exacto = !provider.order && !provider.sort;
  if (suffix === 'floor' || suffix === 'nitro') {
    exacto = false;
    notes.push(
      suffix === 'floor'
        ? 'The :floor suffix sorts by price and turns Auto Exacto off.'
        : 'The :nitro suffix sorts by speed, so Auto Exacto does not choose.',
    );
  } else if (!exacto) notes.push(autoExactoOff(provider.sort === 'price' ? 'price' : 'order'));
  return { provider, max_tokens: maxTokens, auto_exacto: exacto, notes };
}

function autoExactoOff(why: 'price' | 'order'): string {
  return why === 'price'
    ? 'Sorting by price turns Auto Exacto off, so tool calls may land on endpoints that handle tools badly.'
    : 'This sets its own order, so Auto Exacto no longer chooses the provider for tool calls.';
}
