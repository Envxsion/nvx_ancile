/**
 * ------------------------------------------------------------------
 *  Title    |  The lineup in pickers: company, current, Older
 *  Ref      |  roadmap MD2 · docs/models.md (Lines and tiers)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every line ships its current model and the one before
 *           |  it. A picker shows the current ones, grouped by company,
 *           |  and folds the previous generation under a quiet "Older"
 *           |  row, so a larger lineup does not mean a longer list.
 *  How      |  Pure functions over the `company` and `older` Core
 *           |  sends. A model with no company (a direct provider's, or
 *           |  one you added) is grouped under its provider alone.
 *  Note     |  The model you have selected is never folded away.
 * ------------------------------------------------------------------
 */

export interface LineupAware {
  id: string;
  /** Set for a company inside OpenRouter's lineup (Meta, Mistral…). */
  company?: string | undefined;
  /** A previous generation of its line. */
  older?: boolean | undefined;
}

/** The label above older models. */
export const OLDER_LABEL = 'Older';

/** What a picker lists first, and what it folds. The selected model is never folded. */
export function splitOlder<T extends LineupAware>(
  models: readonly T[],
  selected: ReadonlyArray<string | null | undefined> = [],
): { current: T[]; older: T[] } {
  const keep = new Set(selected.filter((s): s is string => !!s));
  const out: { current: T[]; older: T[] } = { current: [], older: [] };
  for (const m of models) (m.older && !keep.has(m.id) ? out.older : out.current).push(m);
  return out;
}

/** The group a model sits under: its provider, or "OpenRouter · Meta" for a company inside OpenRouter's lineup. */
export const groupLabel = (provider: string, company?: string | undefined): string =>
  company ? `${provider} · ${company}` : provider;

/** Items in the order first seen, one group per label; an item with no label comes in one group with a null label. */
export function groupedBy<T>(
  items: readonly T[],
  label: (item: T) => string | null | undefined,
): { label: string | null; items: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const it of items) {
    const key = label(it) ?? null;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return [...groups].map(([l, list]) => ({ label: l, items: list }));
}
