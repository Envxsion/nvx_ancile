/**
 * ------------------------------------------------------------------
 *  Title    |  Receipt: compare and export (Pro seam)
 *  Ref      |  roadmap WY1 · DESIGN.md §9
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The foot of a receipt: with Pro and the licence, Pro's
 *           |  tools (parts.ReceiptTools) compare this answer with
 *           |  another and export receipts; without them, one quiet
 *           |  line says what unlocks it.
 *  How      |  Hands Pro plain figures (ReceiptRow) and nothing else.
 *  Note     |  Nothing here compares or exports.
 * ------------------------------------------------------------------
 */

import * as proContract from '@nvx/contracts/pro';
import { Link } from '@tanstack/react-router';
import { useThread } from '../lib/data';
import type { MessageView } from '../lib/types';
import { useProFeature } from '../pro/slot';
import { receiptRow } from './facts';

export function ReceiptPro({ m, threadId }: { m: MessageView; threadId: string }) {
  const { ui, unlocked, loading, build } = useProFeature('insights');
  const thread = useThread(threadId);
  const row = receiptRow(m, threadId);
  if (!row || loading) return null;
  const Tools = ui?.parts?.ReceiptTools;
  if (Tools && unlocked) {
    const others = (thread.data?.messages ?? [])
      .filter((x) => x.id !== m.id)
      .map((x) => receiptRow(x, threadId))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    return <Tools row={row} others={others} />;
  }
  return (
    <p className="mute rc__pro gilt-frame gilt-frame--quiet">
      Compare this receipt with another answer, and export receipts as CSV or JSON: part of{' '}
      {proContract.PRO_FEATURE_WORDS.insights.title} in NVX Ancile Pro.{' '}
      <Link to="/admin/$section" params={{ section: 'license' }} className="link-btn">
        {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
      </Link>
    </p>
  );
}
