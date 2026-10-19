/**
 * ------------------------------------------------------------------
 *  Title    |  Ask another model about this: where it opens
 *  Ref      |  roadmap AN2 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The highlight bar's "Ask another model" opens a side
 *           |  card beside the thread. With Pro and the licence, Pro's
 *           |  own card (ProUi.parts.SideAsk) asks a model of a
 *           |  different family and shows the answer, costed; without
 *           |  them the card says what it is and what unlocks it.
 *  How      |  A small store holds the highlighted words and where
 *           |  they came from; SideAskHost, mounted once in the shell,
 *           |  renders it. Nothing is asked or spent until a button
 *           |  inside the card is pressed. Nothing is written to the
 *           |  thread.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { ProUpsell, useProFeature } from './slot';

interface SideAskState {
  open: { threadId: string; messageId: string; text: string } | null;
  show: (t: { threadId: string; messageId: string; text: string }) => void;
  close: () => void;
}

export const useSideAsk = create<SideAskState>((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}));

export const openSideAsk = (t: { threadId: string; messageId: string; text: string }) =>
  useSideAsk.getState().show(t);

export function SideAskHost() {
  const target = useSideAsk((s) => s.open);
  const close = useSideAsk((s) => s.close);
  const { ui, unlocked, build, loading } = useProFeature('beam');
  if (!target) return null;
  const Card = ui?.parts?.SideAsk;
  return (
    <aside
      className="side-ask pro-card gilt-frame gilt-frame--quiet"
      aria-label="Ask another model about this"
    >
      <header className="side-ask__head">
        <Icon name="compare" size={14} /> Ask another model
        <button type="button" className="btn btn--quiet btn--sm" aria-label="Close" onClick={close}>
          <Icon name="close" size={12} />
        </button>
      </header>
      {loading ? (
        <Skeleton lines={3} label="Loading" />
      ) : Card && unlocked ? (
        <Card {...target} onClose={close} />
      ) : (
        <ProUpsell feature="beam" build={build} />
      )}
    </aside>
  );
}
