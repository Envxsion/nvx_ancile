/**
 * ------------------------------------------------------------------
 *  Title    |  Spend expiring credit first
 *  Ref      |  roadmap RT1 + CR1 · docs/models.md (Monthly API credit)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Unused monthly credit expires at the end of the cycle.
 *           |  When the goal is on, in the last days of a cycle and with
 *           |  credit left, a model paid from the credit goes ahead of a
 *           |  model of equal quality on another bill.
 *  How      |  Equal quality means the same Claude line (Opus, Sonnet,
 *           |  Haiku, Fable): the plan and the key can run the same model.
 *           |  Nothing else is reordered, and a model the person chose
 *           |  for the message stays first.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';

const LINES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const;

/** Which Claude line a model is, or null (not a Claude model). */
export function claudeLineOf(m: Pick<ModelConfig, 'id' | 'provider_model'>): string | null {
  const text = `${m.provider_model} ${m.id}`.toLowerCase();
  return LINES.find((l) => text.includes(l)) ?? null;
}

/**
 * Move each credit model ahead of the first earlier model of its line that is
 * not paid from the credit. `from` skips a fixed head (the person's own pick).
 */
export function preferCreditFirst(
  chain: ModelConfig[],
  isCredit: (m: ModelConfig) => boolean,
  from = 0,
): ModelConfig[] {
  const out = [...chain];
  for (let j = from; j < out.length; j++) {
    const c = out[j] as ModelConfig;
    if (!isCredit(c)) continue;
    const line = claudeLineOf(c);
    if (!line) continue;
    for (let i = from; i < j; i++) {
      const o = out[i] as ModelConfig;
      if (!isCredit(o) && claudeLineOf(o) === line) {
        out.splice(j, 1);
        out.splice(i, 0, c);
        break;
      }
    }
  }
  return out;
}
