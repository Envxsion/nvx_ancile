/**
 * ------------------------------------------------------------------
 *  Title    |  The bar beside a highlight
 *  Ref      |  roadmap FC3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Offer Fact-check (check this claim), Quote in reply, Ask
 *           |  about this, Save to note and Branch from here (AN2), and
 *           |  Copy from the context menu, beside highlighted text.
 *  How      |  A small floating bar over the highlight, or at the
 *           |  pointer for the context menu. It never takes the
 *           |  selection away (mouse down is not allowed to move
 *           |  focus), has a name for screen readers and says its
 *           |  key: F fact-checks a highlight in the selected message.
 *           |  Escape puts it away. Nothing is sent or spent until the
 *           |  button is pressed.
 * ------------------------------------------------------------------
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { notify } from '../state/notify';
import { type Highlight, useSelectionCheck } from '../state/selectionCheck';
import { Icon } from '../ui/Icon';
import { Kbd } from '../ui/primitives';

const GAP = 8;

/** Where the bar sits: over the highlight if there is room, else under it; kept on screen. */
export function barPosition(
  h: Pick<Highlight, 'box' | 'via' | 'at'>,
  size: { w: number; h: number },
  view: { w: number; h: number },
): { left: number; top: number } {
  if (h.via === 'menu' && h.at) {
    return {
      left: Math.max(GAP, Math.min(h.at.x, view.w - size.w - GAP)),
      top: Math.max(GAP, Math.min(h.at.y, view.h - size.h - GAP)),
    };
  }
  const centre = (h.box.left + h.box.right) / 2 - size.w / 2;
  const above = h.box.top - size.h - GAP;
  return {
    left: Math.max(GAP, Math.min(centre, view.w - size.w - GAP)),
    top: above >= GAP ? above : Math.min(h.box.bottom + GAP, view.h - size.h - GAP),
  };
}

export function SelectionToolbar({ messageId }: { messageId: string }) {
  const h = useSelectionCheck((s) => (s.toolbar?.messageId === messageId ? s.toolbar : null));
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!h || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos(barPosition(h, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }));
  }, [h]);

  // Scrolling moves the words; the bar goes with them rather than hanging in the air.
  useEffect(() => {
    if (!h) return;
    const off = () => useSelectionCheck.getState().hideToolbar(messageId);
    window.addEventListener('scroll', off, { capture: true, passive: true });
    window.addEventListener('resize', off);
    return () => {
      window.removeEventListener('scroll', off, { capture: true });
      window.removeEventListener('resize', off);
    };
  }, [h, messageId]);

  if (!h) return null;
  const check = () => useSelectionCheck.getState().openCard(h);
  // AN2: the other ways to use the words. Each loads its code when first pressed.
  const act = (run: (m: typeof import('../lib/selectionActions')) => unknown) => () => {
    void import('../lib/selectionActions').then(run);
    useSelectionCheck.getState().hideToolbar(messageId);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(h.text);
      notify({ level: 'success', title: 'Copied' });
    } catch {
      notify({ level: 'warn', title: 'Clipboard is blocked', body: 'Select the text and copy it by hand.' });
    }
    useSelectionCheck.getState().hideToolbar(messageId);
  };

  return createPortal(
    <div
      ref={ref}
      className="selbar"
      role="toolbar"
      aria-label="Highlighted text"
      data-via={h.via}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      // A press on the bar must not move focus or collapse the highlight.
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') useSelectionCheck.getState().hideToolbar(messageId);
      }}
    >
      <button type="button" className="selbar__btn" aria-keyshortcuts="F" onClick={check}>
        <Icon name="factcheck" size={13} />
        Fact-check
        <Kbd keys="f" />
      </button>
      <button type="button" className="selbar__btn" onClick={act((m) => m.quoteInReply(h.threadId, h.text))}>
        <Icon name="quote" size={13} />
        Quote in reply
      </button>
      <button type="button" className="selbar__btn" onClick={act((m) => m.askAbout(h.threadId, h.text))}>
        <Icon name="question" size={13} />
        Ask about this
      </button>
      <button
        type="button"
        className="selbar__btn"
        onClick={act((m) => m.saveToNote({ threadId: h.threadId, messageId: h.messageId, text: h.text }))}
      >
        <Icon name="note" size={13} />
        Save to note
      </button>
      <button
        type="button"
        className="selbar__btn"
        onClick={act((m) => m.branchFrom(h.threadId, h.messageId))}
      >
        <Icon name="branch" size={13} />
        Branch from here
      </button>
      {h.via === 'menu' ? (
        <button type="button" className="selbar__btn" onClick={() => void copy()}>
          <Icon name="copy" size={13} />
          Copy
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
