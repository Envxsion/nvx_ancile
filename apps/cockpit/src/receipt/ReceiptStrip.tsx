/**
 * ------------------------------------------------------------------
 *  Title    |  The receipt strip
 *  Ref      |  roadmap WY1 · DESIGN.md §11.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The one quiet line under a finished answer: which model,
 *           |  who paid, how long, what it cost, what the cache saved.
 *           |  It is also the button that opens the receipt.
 *  How      |  A real button with aria-expanded and aria-controls. It
 *           |  appears once the answer is done, so a streaming answer
 *           |  never shifts under it.
 * ------------------------------------------------------------------
 */

import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import type { ReceiptFacts } from './facts';

export const stripId = (messageId: string) => `rc-strip-${messageId}`;
export const receiptId = (messageId: string) => `rc-${messageId}`;

export function ReceiptStrip({
  messageId,
  facts,
  showCost,
}: {
  messageId: string;
  facts: ReceiptFacts;
  showCost: boolean;
}) {
  const open = useUi((s) => s.receiptOpen === messageId);
  const f = facts.strip;
  const parts = [f.modelName, f.badge, f.seconds, showCost ? f.cost : null, showCost ? f.saved : null].filter(
    (p): p is string => !!p,
  );
  return (
    <button
      type="button"
      id={stripId(messageId)}
      className="rc-strip"
      aria-expanded={open}
      aria-controls={receiptId(messageId)}
      aria-label={`Receipt: ${parts.join(', ')}. ${open ? 'Hide' : 'Show'} the receipt.`}
      onClick={() => useUi.getState().setReceipt(open ? null : messageId)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          useUi.getState().setReceipt(null);
        }
      }}
    >
      <span className="rc-strip__model">{f.modelName}</span>
      {f.badge ? (
        <span className="rc-badge" data-kind={facts.billing?.kind}>
          {f.badge}
        </span>
      ) : null}
      {f.seconds ? (
        <span className="rc-strip__fig" data-num>
          {f.seconds}
        </span>
      ) : null}
      {showCost ? (
        <span className="rc-strip__fig" data-num>
          {f.cost}
        </span>
      ) : null}
      {showCost && f.saved ? <span className="rc-strip__saved">{f.saved}</span> : null}
      <Icon name="chevronDown" size={11} className="rc-strip__chev" />
    </button>
  );
}
