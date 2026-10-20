/**
 * ------------------------------------------------------------------
 *  Title    |  Model tiers in words
 *  Ref      |  DESIGN.md D30 · roadmap TR2 · docs/models.md (Tiers)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Say a model's tier and where it came from in plain
 *           |  words, so Admin → Models can show it quietly and let
 *           |  you change it in one click.
 *  How      |  Core stores best, balanced, fast and tiny; people read
 *           |  frontier, standard, small and tiny.
 * ------------------------------------------------------------------
 */

import type { ModelTier, TierSource } from '@nvx/contracts';

export const TIER_WORDS: Record<ModelTier, string> = {
  best: 'Frontier',
  balanced: 'Standard',
  fast: 'Small',
  tiny: 'Tiny',
};

/** Strongest first, for menus and pickers. */
export const TIER_ORDER: ModelTier[] = ['best', 'balanced', 'fast', 'tiny'];

export const TIER_SOURCE_WORDS: Record<TierSource, string> = {
  override: 'Set by you',
  line: 'From its model line',
  size: 'From its size',
  price: 'From its price',
  unknown: 'Not known, so small',
};

/** The tooltip on a model's tier. */
export const tierTitle = (tier: ModelTier, source: TierSource | undefined) =>
  `${TIER_WORDS[tier]} tier. ${source ? TIER_SOURCE_WORDS[source] : ''}`.trim();
