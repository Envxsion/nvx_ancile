/**
 * ------------------------------------------------------------------
 *  Title    |  The model you get when you chose none
 *  Ref      |  DESIGN.md §7.2 · docs/models.md (Tiers)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Pick the model the composer starts on when the thread
 *           |  and your saved choice name none that can answer, without
 *           |  ever landing on the dearest model by the order of a list.
 *  How      |  1. the routing default (chat.default), when it can
 *           |  answer; 2. the cheapest standard-tier model that can;
 *           |  3. the cheapest small or tiny one; 4. the cheapest of
 *           |  anything else. Never a GPU-node model (asking it wakes
 *           |  and bills the node), and a plan model only when nothing
 *           |  else can answer. A model you chose yourself never comes
 *           |  through here.
 * ------------------------------------------------------------------
 */

import { canAnswer } from './data';
import type { ModelView } from './types';

/** Standard first, then the cheaper tiers, and frontier last. */
const TIER_PREFERENCE = ['balanced', 'fast', 'tiny', 'best'] as const;

/** What an answer costs, for ordering only: output weighs more, as in Core. Plans sort last. */
const cost = (m: ModelView): number =>
  m.billing?.kind === 'plan' ? Number.POSITIVE_INFINITY : (m.price?.out ?? 0) * 4 + (m.price?.in ?? 0);

const byCost = (a: ModelView, b: ModelView) => cost(a) - cost(b) || a.id.localeCompare(b.id);

/** `routingDefault` is the first id in the ready chat.default chain, if the routing list has loaded. */
export function pickDefaultModel(
  models: readonly ModelView[],
  routingDefault?: string | null,
): ModelView | undefined {
  const usable = models.filter((m) => canAnswer(m) && m.via !== 'controller');
  const real = usable.filter((m) => !m.offline);
  const pool = real.length ? real : usable;
  const routed = routingDefault ? pool.find((m) => m.id === routingDefault) : undefined;
  if (routed) return routed;
  for (const tier of TIER_PREFERENCE) {
    const hit = pool.filter((m) => m.tier === tier).sort(byCost)[0];
    if (hit) return hit;
  }
  // Models whose tier is not known yet: the cheapest, never the first listed.
  return [...pool].sort(byCost)[0] ?? models.find(canAnswer);
}
