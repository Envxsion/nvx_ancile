/**
 * ------------------------------------------------------------------
 *  Title    |  What the receipt knows about one answer
 *  Ref      |  roadmap WY1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The few facts the strip and the receipt both need: the
 *           |  usage on record, who paid (as it was at the time), the
 *           |  model's name and badge, and whether Claude Code's
 *           |  cache-apart token meaning applies.
 *  How      |  Reads the message itself. Answers from before the
 *           |  receipt carry no billing; for those the model's billing
 *           |  today stands in, and the receipt says nothing it cannot
 *           |  support.
 * ------------------------------------------------------------------
 */

import type { ModelBilling, Usage } from '@nvx/contracts';
import { modelById, modelName } from '../lib/format';
import type { MessageView } from '../lib/types';
import { billingBadge, modelBadge } from '../models/billing';
import { billedToWords, isClaudeCodeModel, type StripFacts, stripFacts } from './figures';

export interface ReceiptFacts {
  usage: Usage;
  billing: ModelBilling | null;
  badge: string | null;
  name: string;
  /** Claude Code counts cache reads apart from input; everything else counts them in. */
  cacheApart: boolean;
  /** The words for a metered Claude Code bill ("your Anthropic API key"), else null. */
  claudeBilledTo: string | null;
  strip: StripFacts;
}

/** Null when the answer has no usage on record (nothing to put on a receipt). */
export function receiptFacts(m: MessageView): ReceiptFacts | null {
  const usage = m.rawUsage;
  if (!usage || m.role !== 'assistant') return null;
  const model = modelById(m.modelId);
  const billing = usage.billing ?? model?.billing ?? null;
  const badge = usage.billing
    ? modelBadge({ billing: usage.billing, via: model?.via ?? 'direct' })
    : model
      ? modelBadge(model)
      : null;
  const name = model?.name ?? m.modelName ?? modelName(m.modelId);
  const cacheApart = isClaudeCodeModel(m.modelId) || !!m.provenance?.claude_code;
  const claudeBilledTo = cacheApart && billing?.kind === 'key' ? billedToWords(billing.payer) : null;
  return {
    usage,
    billing,
    badge: badge ?? (billing ? billingBadge(billing) : null),
    name,
    cacheApart,
    claudeBilledTo,
    strip: stripFacts({ usage, billing, badge, modelName: name, cacheApart, claudeBilledTo }),
  };
}
