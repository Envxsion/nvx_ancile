/**
 * ------------------------------------------------------------------
 *  Title    |  openrouter/auto
 *  Ref      |  docs/openrouter.md (Auto)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Auto picks a model per request, so its window, output
 *           |  cap and price are not known until it has answered.
 *           |  Ancile plans for the smallest plausible window so a
 *           |  thread never overflows, and records what really served
 *           |  (usage.served) and what it really cost (usage.cost).
 *  How      |  autoLimits() clamps an Auto model's config when the
 *           |  registry takes it in. A window learnt from a served
 *           |  model only ever narrows it: the next request may go to
 *           |  a different, smaller model.
 * ------------------------------------------------------------------
 */

import { type ModelConfig, OPENROUTER_AUTO } from '@nvx/contracts';

/** The smallest window among the models Auto commonly picks, rounded down. */
export const AUTO_SAFE_WINDOW = 32_768;
export const AUTO_SAFE_OUTPUT = 8_192;

export const isAuto = (m: Pick<ModelConfig, 'provider' | 'provider_model'>) =>
  m.provider === 'openrouter' && m.provider_model.replace(/:[a-z]+$/i, '') === OPENROUTER_AUTO;

/** An Auto model as Ancile plans for it: the smallest plausible window and output. */
export function autoLimits(m: ModelConfig, servedWindow?: number | null): ModelConfig {
  if (!isAuto(m)) return m;
  const window = Math.min(m.context_window, AUTO_SAFE_WINDOW, servedWindow ?? Number.POSITIVE_INFINITY);
  return { ...m, context_window: window, max_output: Math.min(m.max_output, AUTO_SAFE_OUTPUT) };
}
