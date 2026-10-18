/**
 * ------------------------------------------------------------------
 *  Title    |  What a check found
 *  Ref      |  roadmap MD4, MD5 · docs/models.md (Changes)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Compare one provider's live list with what was seen
 *           |  before and with the models you have, and say what is
 *           |  new, what changed and what has gone.
 *  How      |  Pure: rows and changes come back; the service saves
 *           |  them. A model you have is compared field by field with
 *           |  what the registry uses now (so a changed price shows
 *           |  once, then the live value is the one in use). A model
 *           |  you don't have is "new" once, ever: rows are never
 *           |  deleted. A model missing from three successful checks in
 *           |  a row is marked retired, and stays.
 *  Note     |  A provider's first check records everything silently
 *           |  except the newest stable model of a line you already
 *           |  use, so installing a key doesn't open with a hundred
 *           |  "new" models. OpenRouter's list never offers new models
 *           |  (the catalogue browser already does).
 * ------------------------------------------------------------------
 */
import type { ModelChange, ModelConfig, WatchPrice } from '@nvx/contracts';

type Capability = ModelConfig['capabilities'][number];

import { type Member, newestStable } from './linebook';
import { compareModels, dateOf, lineFor } from './lines';
import type { Listed } from './listers';
import { matchOpenRouterPrice, normaliseForMatch } from './listers';
import type { StoredModel } from './store';

/** A registry id part: any `/` as `__` (ids hold one slash). */
export const idPart = (s: string) => s.replace(/\//g, '__').replace(/[^A-Za-z0-9._:-]/g, '-');

/** How to treat prices this run. */
export type PriceMode =
  /** Match direct models against OpenRouter's public list. */
  | { mode: 'index'; index: Map<string, WatchPrice> }
  /** The setting is off: no prices from OpenRouter. */
  | { mode: 'off' }
  /** The public list could not be read this time: keep the last prices. */
  | { mode: 'keep' };

export interface DiffInput {
  provider: string;
  vendor: string | null;
  baseUrl?: string | null;
  now: string;
  listed: Listed[];
  /** Rows of this provider from earlier checks. */
  previous: StoredModel[];
  /** The registry's models of this provider, as they answer now. */
  catalogue: ModelConfig[];
  prices: PriceMode;
  /** The provider's own list carries prices (OpenRouter). */
  ownPrices?: boolean;
  /** OpenRouter's list: never offers new models. */
  suppressNew?: boolean;
  newId: () => string;
}

export interface DiffResult {
  rows: StoredModel[];
  changes: ModelChange[];
}

const EPS = 1e-9;
const same = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) < EPS;

export const samePrice = (a: WatchPrice, b: WatchPrice) =>
  same(a.input_per_mtok, b.input_per_mtok) &&
  same(a.output_per_mtok, b.output_per_mtok) &&
  (b.cached_per_mtok === undefined || same(a.cached_per_mtok, b.cached_per_mtok)) &&
  (b.cache_write_per_mtok === undefined || same(a.cache_write_per_mtok, b.cache_write_per_mtok));

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Of the models that are one model under two spellings, the one to keep: undated, else the latest snapshot. */
function representatives(listed: Listed[]): Listed[] {
  const groups = new Map<string, Listed[]>();
  for (const m of listed) {
    const k = normaliseForMatch(m.provider_model);
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return [...groups.values()].map((g) =>
    g.reduce((best, m) =>
      compareModels(
        { version: null, date: dateOf(m.provider_model) },
        { version: null, date: dateOf(best.provider_model) },
      ) > 0
        ? m
        : best,
    ),
  );
}

/**
 * What a model can do after a check: what it could already do, plus what the
 * list now says yes to, minus only what the list explicitly says no to. A key
 * missing from a provider's list never takes an ability away.
 */
export function effectiveCaps(
  l: Pick<Listed, 'capabilities' | 'capsDenied'>,
  before: readonly Capability[],
): Capability[] {
  const out = new Set<Capability>([...before, ...l.capabilities]);
  for (const c of l.capsDenied ?? []) out.delete(c);
  return [...out];
}

export function diffProvider(input: DiffInput): DiffResult {
  const { provider, now } = input;
  const day = now.slice(0, 10);
  const prevById = new Map(input.previous.map((r) => [r.id, r]));
  const catByKey = new Map(input.catalogue.map((m) => [normaliseForMatch(m.provider_model), m]));
  const firstCheck = input.previous.length === 0;
  const rows: StoredModel[] = [];
  const changes: ModelChange[] = [];
  const emit = (c: Omit<ModelChange, 'id' | 'at' | 'seen'>) =>
    changes.push({ ...c, id: input.newId(), at: now, seen: false });

  const seenIds = new Set<string>();
  const built: {
    row: StoredModel;
    cat: ModelConfig | undefined;
    prev: StoredModel | undefined;
    listed: Listed;
  }[] = [];
  for (const l of representatives(input.listed)) {
    const cat = catByKey.get(normaliseForMatch(l.provider_model));
    const id = cat?.id ?? `${provider}/${idPart(l.provider_model)}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const prev = prevById.get(id);
    const providerModel = cat?.provider_model ?? l.provider_model;
    const line = lineFor(provider, input.baseUrl, providerModel);
    let price: WatchPrice | null = null;
    let source: StoredModel['price_source'] = null;
    let checked: string | null = null;
    if (l.price && input.ownPrices) {
      price = l.price;
      source = 'provider';
      checked = day;
    } else if (input.prices.mode === 'index' && input.vendor) {
      const hit = matchOpenRouterPrice(input.prices.index, input.vendor, providerModel);
      if (hit) {
        price = hit;
        source = 'openrouter';
        checked = day;
      }
    } else if (input.prices.mode === 'keep' && prev?.price && prev.price_source === 'openrouter') {
      price = prev.price;
      source = prev.price_source;
      checked = prev.price_checked_at;
    }
    const row: StoredModel = {
      id,
      provider,
      provider_model: providerModel,
      display_name: cat?.display_name ?? l.display_name,
      line_id: line?.line_id ?? null,
      version: line?.version ?? null,
      preview: line?.preview ?? false,
      context_window: l.context_window,
      max_output: l.max_output,
      capabilities: l.capsKnown
        ? effectiveCaps(l, cat?.capabilities ?? prev?.capabilities ?? [])
        : (prev?.capabilities ?? []),
      other_abilities: l.other_abilities,
      price,
      price_source: source,
      price_checked_at: checked,
      lifecycle: l.lifecycle,
      retires_at: l.retires_at,
      first_seen: prev?.first_seen ?? now,
      last_seen: now,
      in_catalogue: !!cat,
      caps_known: l.capsKnown,
      created_at: l.created_at,
      missed: 0,
      line_name: line?.name ?? null,
      line_tier: line?.tier ?? null,
    };
    built.push({ row, cat, prev, listed: l });
  }

  // On a provider's first check, only the newest stable model of a line you already use is worth saying.
  const firstOffer = new Set<string>();
  if (firstCheck) {
    const have = new Map<string, Member[]>();
    for (const m of input.catalogue) {
      const l = lineFor(provider, input.baseUrl, m.provider_model);
      if (!l) continue;
      have.set(l.line_id, [
        ...(have.get(l.line_id) ?? []),
        {
          id: m.id,
          provider,
          line_id: l.line_id,
          name: l.name,
          tier: l.tier,
          version: l.version,
          date: dateOf(m.provider_model),
          created: null,
          preview: l.preview,
          retired: false,
          have: true,
        },
      ]);
    }
    const byLine = new Map<string, Member[]>();
    for (const { row } of built) {
      if (!row.line_id || row.in_catalogue || row.preview || row.lifecycle !== 'active') continue;
      byLine.set(row.line_id, [
        ...(byLine.get(row.line_id) ?? []),
        {
          id: row.id,
          provider,
          line_id: row.line_id,
          name: row.line_name ?? '',
          tier: row.line_tier ?? 'best',
          version: row.version,
          date: dateOf(row.provider_model),
          created: row.created_at,
          preview: false,
          retired: false,
          have: false,
        },
      ]);
    }
    for (const [lineId, members] of byLine) {
      const mine = newestStable(have.get(lineId) ?? []);
      const top = newestStable(members);
      if (mine && top && compareModels(top, mine) > 0) firstOffer.add(top.id);
    }
  }

  for (const { row, cat, prev, listed } of built) {
    rows.push(row);
    const base = { model_id: row.id, line_id: row.line_id, reason: null } as const;
    if (!cat) {
      if (
        !prev &&
        !input.suppressNew &&
        row.lifecycle === 'active' &&
        (!firstCheck || firstOffer.has(row.id))
      )
        emit({ ...base, kind: 'new_model', before: null, after: null });
      continue;
    }
    // A model you have: live values against what is in use now.
    if (
      (listed.context_window && listed.context_window !== cat.context_window) ||
      (listed.max_output && listed.max_output !== cat.max_output)
    )
      emit({
        ...base,
        kind: 'context',
        before: { context_window: cat.context_window, max_output: cat.max_output },
        after: {
          context_window: listed.context_window ?? cat.context_window,
          max_output: listed.max_output ?? cat.max_output,
        },
      });
    if (listed.capsKnown) {
      const eff = effectiveCaps(listed, cat.capabilities as Capability[]);
      if (!sameSet(eff, cat.capabilities as Capability[]))
        emit({ ...base, kind: 'capability', before: cat.capabilities, after: eff });
    }
    if (prev) {
      const gained = listed.other_abilities.filter((a) => !prev.other_abilities.includes(a));
      if (gained.length)
        emit({
          ...base,
          kind: 'unsupported_capability',
          before: prev.other_abilities,
          after: listed.other_abilities,
        });
    }
    if (row.price && !samePrice(cat.price, row.price))
      emit({ ...base, kind: 'price', before: cat.price, after: row.price });
    if (row.lifecycle !== 'active' && prev?.lifecycle !== row.lifecycle)
      emit({ ...base, kind: 'retired', before: null, after: null });
  }

  // Gone from the list: three successful checks in a row and it is retired. The row stays.
  for (const prev of input.previous) {
    if (seenIds.has(prev.id)) continue;
    const missed = prev.missed + 1;
    let lifecycle = prev.lifecycle;
    if (missed >= 3 && lifecycle !== 'retired') {
      lifecycle = 'retired';
      if (prev.in_catalogue || input.catalogue.some((m) => m.id === prev.id))
        emit({
          model_id: prev.id,
          line_id: prev.line_id,
          reason: null,
          kind: 'retired',
          before: null,
          after: null,
        });
    }
    rows.push({ ...prev, missed, lifecycle, in_catalogue: input.catalogue.some((m) => m.id === prev.id) });
  }
  return { rows, changes };
}
