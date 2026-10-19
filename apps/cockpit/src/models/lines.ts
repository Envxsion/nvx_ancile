/**
 * ------------------------------------------------------------------
 *  Title    |  Model lines in pickers
 *  Ref      |  roadmap MD4, MD5 · guard rail GR16 · packages/contracts/src/modelwatch.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where you choose a line (like Claude Opus) answers use
 *           |  its newest model. These helpers decide what every
 *           |  picker lists: the line once, tagged "Latest", not the
 *           |  model it answers with today, and nothing retired.
 *  How      |  Pure functions over the alias_of, line_id and lifecycle
 *           |  Core sends. The model you have selected is never hidden,
 *           |  so a choice made earlier still shows as chosen.
 *  Note     |  Literal ids are never rewritten: picking the concrete
 *           |  model still pins it.
 * ------------------------------------------------------------------
 */

import { isLineAlias } from '@nvx/contracts/modelwatch';
import { queryClient } from '../lib/query';
import type { ModelView } from '../lib/types';

export interface LineAware {
  id: string;
  name: string;
  /** Alias entries: the concrete model it answers with now. */
  aliasOf?: string | null | undefined;
  lineId?: string | null | undefined;
  lifecycle?: 'active' | 'deprecated' | 'retired' | undefined;
}

/** The small tag on a line entry. */
export const LATEST_TAG = 'Latest';

export const isAliasEntry = (m: Pick<LineAware, 'id' | 'aliasOf'>): boolean =>
  !!m.aliasOf || isLineAlias(m.id);

/**
 * What a picker lists: retired models and the concrete model an alias
 * answers with now are left out, unless one of them is selected.
 */
export function offerable<T extends LineAware>(
  models: T[],
  selected: ReadonlyArray<string | null | undefined> = [],
): T[] {
  const keep = new Set(selected.filter((s): s is string => !!s));
  const pointedAt = new Set(models.map((m) => m.aliasOf).filter((s): s is string => !!s));
  return models.filter((m) => {
    if (keep.has(m.id)) return true;
    if (m.lifecycle === 'retired') return false;
    return !pointedAt.has(m.id);
  });
}

/** "now Claude Opus 5.6" for a line entry; null for anything else. */
export function nowNote<T extends LineAware>(m: T, models: T[]): string | null {
  if (!m.aliasOf) return null;
  const current = models.find((x) => x.id === m.aliasOf);
  return `now ${current?.name ?? m.aliasOf}`;
}

/** The model a line answers with now, by any model of that line. */
function lineCurrent<T extends LineAware>(m: T, models: T[]): T | undefined {
  if (!m.lineId) return undefined;
  const alias = models.find((x) => x.aliasOf && x.lineId === m.lineId);
  return alias ? models.find((x) => x.id === alias.aliasOf) : undefined;
}

/** "Retired: answers come from Claude Opus 5.6" for a retired model; null otherwise. */
export function retiredNote<T extends LineAware>(m: T, models: T[]): string | null {
  if (m.lifecycle !== 'retired') return null;
  const now = lineCurrent(m, models);
  return now ? `Retired: answers come from ${now.name}` : 'Retired';
}

/**
 * An answer from the model an alias points to is the alias doing its
 * job, not a fallback. True when `requested` is a line alias and
 * `answeredBy` belongs to that line.
 */
export function isOwnAnswer<T extends LineAware>(
  requested: string,
  answeredBy: string | null | undefined,
  models: T[],
): boolean {
  if (!answeredBy || !isLineAlias(requested)) return false;
  // Only the alias answering through its own current model is "not a fallback".
  // An older model of the same line that stepped in after a failure is a real
  // fallback and keeps its line under the message.
  return models.find((m) => m.id === requested)?.aliasOf === answeredBy;
}

/** isOwnAnswer over the model list the cockpit already holds: for the "answered by" line under a message. */
export function aliasAnswered(requested: string, answeredBy: string | null | undefined): boolean {
  const live = queryClient.getQueryData<ModelView[]>(['models']) ?? [];
  return isOwnAnswer(requested, answeredBy, live);
}
