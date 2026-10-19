/**
 * ------------------------------------------------------------------
 *  Title    |  Reading a highlight in a message
 *  Ref      |  roadmap FC3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Notice when text inside one message is highlighted (with
 *           |  the mouse, a finger or the keyboard) and tell the
 *           |  selection store, so Fact-check can be offered beside it.
 *  How      |  Listens on the message itself for the end of a drag, a
 *           |  Shift+arrow and the context menu, and on the document
 *           |  for the selection going away. Only text inside the
 *           |  message's body counts: not its buttons, not another
 *           |  message, not the composer. A highlight of one or two
 *           |  characters is a click, not a claim.
 *  Note     |  Works in any message, a model's answer or your own, and
 *           |  in any content: prose, code, a formula, a link.
 * ------------------------------------------------------------------
 */

import type { SelectionKind } from '@nvx/contracts';
import { type RefObject, useEffect } from 'react';
import { type Highlight, useSelectionCheck } from '../state/selectionCheck';

/** The most characters a highlight can carry to Core (it checks up to 2,000). */
const MAX = 4_000;

function kindOf(range: Range, text: string): SelectionKind | undefined {
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (el?.closest('pre, code')) return 'code';
  if (el?.closest('.katex, .math')) return 'math';
  const link = el?.closest('a[href]');
  if (link && link.textContent?.trim() === text) return 'link';
  return undefined;
}

/** The highlight inside this message's body, or null. */
export function readHighlight(
  root: HTMLElement,
  ids: { messageId: string; threadId: string },
): Omit<Highlight, 'via' | 'at'> | null {
  const sel = typeof window === 'undefined' ? null : window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const body = root.querySelector('.msg__body');
  if (!body?.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().replace(/\r/g, '').trim().slice(0, MAX);
  if (text.length < 3) return null;
  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return {
    ...ids,
    text,
    kind: kindOf(range, text),
    box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    range: range.cloneRange(),
  };
}

export function useHighlight(
  ref: RefObject<HTMLElement | null>,
  o: { messageId: string; threadId: string; enabled: boolean },
): void {
  const { messageId, threadId, enabled } = o;
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const ids = { messageId, threadId };
    const show = (via: Highlight['via'], at: Highlight['at'] = null) => {
      const h = readHighlight(root, ids);
      if (h) useSelectionCheck.getState().showToolbar({ ...h, via, at });
      return h;
    };
    // After the browser has settled the selection (a double click selects on the second mouseup).
    const later = (via: Highlight['via'] = 'select') => setTimeout(() => show(via), 0);
    const onUp = () => void later();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return useSelectionCheck.getState().hideToolbar(messageId);
      if (e.shiftKey || e.key === 'Shift') void later();
    };
    const onMenu = (e: MouseEvent) => {
      const h = readHighlight(root, ids);
      if (!h) return;
      // The browser's own menu has no Fact-check: ours stands in for it on a highlight.
      e.preventDefault();
      useSelectionCheck.getState().showToolbar({ ...h, via: 'menu', at: { x: e.clientX, y: e.clientY } });
    };
    const onChange = () => {
      const s = useSelectionCheck.getState();
      if (s.toolbar?.messageId !== messageId) return;
      if (!readHighlight(root, ids)) s.hideToolbar(messageId);
    };
    root.addEventListener('mouseup', onUp);
    root.addEventListener('touchend', onUp);
    root.addEventListener('keyup', onKey);
    root.addEventListener('contextmenu', onMenu);
    document.addEventListener('selectionchange', onChange);
    return () => {
      root.removeEventListener('mouseup', onUp);
      root.removeEventListener('touchend', onUp);
      root.removeEventListener('keyup', onKey);
      root.removeEventListener('contextmenu', onMenu);
      document.removeEventListener('selectionchange', onChange);
      useSelectionCheck.getState().hideToolbar(messageId);
    };
  }, [ref, messageId, threadId, enabled]);
}
