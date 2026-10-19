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
import type { ReceiptRow } from '../pro/slot';
import { billedToWords, costTable, isClaudeCodeModel, payKind, type StripFacts, stripFacts } from './figures';

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

/** The receipt as plain figures, for Pro compare and export (pro/slot.tsx ReceiptRow). Null: no usage on record. */
export function receiptRow(m: MessageView, threadId: string): ReceiptRow | null {
  const f = receiptFacts(m);
  if (!f) return null;
  const table = costTable(f.usage, { billing: f.billing, cacheApart: f.cacheApart });
  const tok = (id: 'fresh' | 'cached' | 'written') => {
    const t = table.rows.find((r) => r.id === id)?.tokens;
    return t?.state === 'known' ? t.tokens : null;
  };
  const kind = payKind(f.billing);
  return {
    id: m.id,
    threadId,
    at: m.createdAt,
    model: f.name,
    badge: f.badge,
    pay: kind === 'unknown' ? null : kind,
    costUsd: kind === 'key' ? f.usage.cost_usd : null,
    tokens: {
      fresh: tok('fresh'),
      cached: tok('cached'),
      written: tok('written'),
      output: f.usage.output_tokens,
    },
    cacheSavedUsd: table.saving?.kind === 'saved' ? table.saving.usd : null,
    ms: f.usage.ms ?? null,
    calls: f.usage.calls?.length ?? null,
  };
}
