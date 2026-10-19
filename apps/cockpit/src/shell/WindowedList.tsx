/**
 * ------------------------------------------------------------------
 *  Title    |  A long list that draws only what is near
 *  Ref      |  ROADMAP P7
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The rail used to draw every thread it had loaded. Past a
 *           |  few hundred that is thousands of nodes for rows nobody
 *           |  is looking at. Here a long list draws the rows in view
 *           |  and a screen either side, and stands in for the rest
 *           |  with empty space of the right height.
 *  How      |  Rows have one fixed height (the rail's 30 px), measured
 *           |  from the first row drawn, so a row's place is plain
 *           |  arithmetic: no per-row measuring. The window follows the
 *           |  scroller. Two kinds of row are drawn wherever they are:
 *           |  the one holding focus (renaming, a tabbed-to link) and
 *           |  the keyboard cursor, so j and k walk through rows that
 *           |  would otherwise be hidden, and scrolling to the cursor
 *           |  finds it. Each drawn row says where it sits in the whole
 *           |  list (aria-posinset of aria-setsize) for screen readers.
 *           |  A list shorter than `from` is drawn whole, as a plain
 *           |  list, so the common case is unchanged.
 *  Note     |  Grouping headings, pinned rows and notebook rows are not
 *           |  in a windowed list; they are always drawn.
 * ------------------------------------------------------------------
 */

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/** Rail rows that stand in the window either side of the visible ones. */
export const OVERSCAN = 14;
/** A rail row is 30 px with a 1 px gap (shell.css). Measured once rows are drawn. */
export const DEFAULT_PITCH = 31;

export interface Segment {
  from: number;
  to: number;
}

/**
 * The runs of rows to draw: the window, plus each extra row on its own, merged where they touch.
 * Pure, so the arithmetic is tested without a browser.
 */
export function segmentsFor(count: number, from: number, to: number, extra: readonly number[]): Segment[] {
  const clamp = (n: number) => Math.max(0, Math.min(count, n));
  const runs: Segment[] = [];
  if (to > from) runs.push({ from: clamp(from), to: clamp(to) });
  for (const i of extra) if (i >= 0 && i < count) runs.push({ from: i, to: i + 1 });
  runs.sort((a, b) => a.from - b.from);
  const merged: Segment[] = [];
  for (const r of runs) {
    if (r.to <= r.from) continue;
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

/** The rows in view, widened by `overscan` rows each way, for a list whose top is `listTop` in the scroller. */
export function windowFor(
  count: number,
  scrollTop: number,
  viewHeight: number,
  listTop: number,
  pitch: number,
  overscan = OVERSCAN,
): Segment {
  const first = Math.floor((scrollTop - listTop) / pitch) - overscan;
  const last = Math.ceil((scrollTop + viewHeight - listTop) / pitch) + overscan;
  return { from: Math.max(0, Math.min(count, first)), to: Math.max(0, Math.min(count, last)) };
}

export function WindowedList<T>({
  items,
  keyOf,
  children,
  scroller,
  from,
  cursorKey = null,
  className = 'rail__list',
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The inside of one row's <li>. */
  children: (item: T) => ReactNode;
  scroller: RefObject<HTMLElement | null>;
  /** Lists shorter than this are drawn whole. */
  from: number;
  /** The row the keyboard cursor is on, drawn wherever it is. */
  cursorKey?: string | null;
  className?: string;
}) {
  const windowed = items.length >= from;
  const ref = useRef<HTMLUListElement>(null);
  const [view, setView] = useState<Segment>({ from: 0, to: 40 });
  const [held, setHeld] = useState<number | null>(null);
  const pitch = useRef(DEFAULT_PITCH);
  const gapPx = useRef(1);

  const update = useCallback(() => {
    const sc = scroller.current;
    const ul = ref.current;
    if (!sc || !ul) return;
    const first = ul.querySelector<HTMLElement>('li[data-i]');
    if (first?.offsetHeight) {
      gapPx.current = Number.parseFloat(getComputedStyle(ul).rowGap) || 0;
      pitch.current = first.offsetHeight + gapPx.current;
    }
    const listTop = ul.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const next = windowFor(items.length, sc.scrollTop, sc.clientHeight, listTop, pitch.current);
    setView((v) => (v.from === next.from && v.to === next.to ? v : next));
    // A row holding focus stays drawn until focus leaves it.
    const focus = ul.querySelector<HTMLElement>('li[data-i]:focus-within');
    const at = focus ? Number(focus.dataset.i) : null;
    setHeld((h) => (h === at ? h : at));
  }, [items.length, scroller]);

  // The scroller moving, resizing, or this list's length changing, redraws the window (once a frame).
  useEffect(() => {
    if (!windowed) return;
    const sc = scroller.current;
    if (!sc) return;
    let frame = 0;
    const soon = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    sc.addEventListener('scroll', soon, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(soon) : null;
    ro?.observe(sc);
    const ul = ref.current;
    ul?.addEventListener('focusin', soon);
    ul?.addEventListener('focusout', soon);
    soon();
    return () => {
      cancelAnimationFrame(frame);
      sc.removeEventListener('scroll', soon);
      ro?.disconnect();
      ul?.removeEventListener('focusin', soon);
      ul?.removeEventListener('focusout', soon);
    };
  }, [windowed, scroller, update]);

  // The first draw already knows the real row height: re-measure before paint.
  useLayoutEffect(() => {
    if (windowed) update();
  }, [windowed, update]);

  if (!windowed)
    return (
      <ul className={className}>
        {items.map((item) => (
          <li key={keyOf(item)}>{children(item)}</li>
        ))}
      </ul>
    );

  const cursorAt = cursorKey === null ? -1 : items.findIndex((it) => keyOf(it) === cursorKey);
  const segs = segmentsFor(items.length, view.from, view.to, [cursorAt, held ?? -1]);
  const gap = (rows: number) => Math.max(0, rows * pitch.current - gapPx.current);
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of segs) {
    if (s.from > at)
      out.push(<li key={`gap-${at}`} aria-hidden="true" data-gap="" style={{ height: gap(s.from - at) }} />);
    for (let i = s.from; i < s.to; i++) {
      const item = items[i] as T;
      out.push(
        <li key={keyOf(item)} data-i={i} aria-posinset={i + 1} aria-setsize={items.length}>
          {children(item)}
        </li>,
      );
    }
    at = s.to;
  }
  if (at < items.length)
    out.push(
      <li key={`gap-${at}`} aria-hidden="true" data-gap="" style={{ height: gap(items.length - at) }} />,
    );
  return (
    <ul ref={ref} className={className} data-windowed="">
      {out}
    </ul>
  );
}
