/**
 * ------------------------------------------------------------------
 *  Title    |  Rows drawn when they come near
 *  Ref      |  ROADMAP P3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A long thread costs only what is near the screen, in
 *           |  time and in memory. A message far from the viewport is
 *           |  its plain text (so the page's own find still finds it);
 *           |  within a couple of screens it is the full message
 *           |  (markdown, highlighted code, tool steps); and once it
 *           |  is several screens away again it goes back to its text,
 *           |  held at the height it measured, so nothing shifts and
 *           |  a read-through of 1,000 messages never holds more than a
 *           |  few dozen drawn.
 *  How      |  Two IntersectionObservers per thread scroller
 *           |  (LazyRoot): one with a small margin that says "draw
 *           |  this", one with a wide margin that says "this has gone
 *           |  far" (the gap between them stops a row near the edge
 *           |  from flapping). The row is the <li>, so it can measure
 *           |  itself. Rows marked eager (the last few, a streaming
 *           |  answer, one waiting on an approval, the selected one,
 *           |  the one jumped to) are always drawn, and a row holding
 *           |  keyboard focus is never taken down under it. Without
 *           |  IntersectionObserver everything is drawn.
 * ------------------------------------------------------------------
 */

import {
  createContext,
  memo,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { partsText } from '../lib/mappers';
import type { MessageView } from '../lib/types';

/** How far outside the viewport a row is drawn in full ahead of time. */
export const LAZY_MARGIN = '1600px 0px';
/** How far away a drawn row has to be before it goes back to its text (more than LAZY_MARGIN). */
export const KEEP_MARGIN = '5000px 0px';

interface Handlers {
  near: () => void;
  far: () => void;
}
type Watch = (el: Element, h: Handlers) => () => void;
const LazyContext = createContext<Watch | null>(null);

/** Two observers for all rows in `scroller`: one says a row came near, one that it went far. */
export function LazyRoot({
  scroller,
  children,
}: {
  scroller: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [watch, setWatch] = useState<Watch | null>(null);
  useLayoutEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const rows = new Map<Element, Handlers>();
    const root = scroller.current;
    const nearIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) rows.get(e.target)?.near();
      },
      { root, rootMargin: LAZY_MARGIN },
    );
    const keepIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (!e.isIntersecting) rows.get(e.target)?.far();
      },
      { root, rootMargin: KEEP_MARGIN },
    );
    setWatch(() => (el: Element, h: Handlers) => {
      rows.set(el, h);
      nearIo.observe(el);
      keepIo.observe(el);
      return () => {
        rows.delete(el);
        nearIo.unobserve(el);
        keepIo.unobserve(el);
      };
    });
    return () => {
      nearIo.disconnect();
      keepIo.disconnect();
    };
  }, [scroller]);
  return <LazyContext.Provider value={watch}>{children}</LazyContext.Provider>;
}

/** What a row shows before it is drawn: its words, at reading measure. Long enough for find to reach. */
export function placeholderText(m: MessageView, max = 8_000): string {
  const text = m.parts?.length
    ? partsText(m.parts)
    : m.blocks
        .map((b) =>
          b.kind === 'h'
            ? b.text
            : b.kind === 'ul'
              ? b.items.map((i) => i.map((s) => s.text).join('')).join('\n')
              : b.spans.map((s) => s.text).join(''),
        )
        .join('\n');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const LazyRow = memo(function LazyRow({
  m,
  eager,
  children,
}: {
  m: MessageView;
  eager: boolean;
  /** The full row; only called while the row is drawn. */
  children: () => ReactNode;
}) {
  const watch = useContext(LazyContext);
  const [near, setNear] = useState(false);
  // The row's height when it was last drawn, kept while it is only its words.
  const [held, setHeld] = useState<number | null>(null);
  const ref = useRef<HTMLLIElement>(null);
  // Without IntersectionObserver at all, draw in full, as before. With it, a
  // row waits for the observer rather than drawing everything on first paint.
  const drawn = eager || near || typeof IntersectionObserver === 'undefined';
  const isDrawn = useRef(drawn);
  isDrawn.current = drawn;
  // A row that was drawn for being eager stays drawn when it stops being eager (it is on
  // screen); the far observer decides when it goes back to its words.
  useEffect(() => {
    if (eager) setNear(true);
  }, [eager]);
  useEffect(() => {
    const li = ref.current;
    if (eager || !watch || !li) return;
    return watch(li, {
      near: () => setNear(true),
      far: () => {
        // Words already: nothing to take down. Focus inside: never take a row from under the keyboard.
        if (!isDrawn.current || li.contains(document.activeElement)) return;
        setHeld(li.offsetHeight);
        setNear(false);
      },
    });
  }, [eager, watch]);
  const text = useMemo(() => (drawn ? '' : placeholderText(m)), [drawn, m]);
  return (
    <li ref={ref} data-mid={m.id}>
      {drawn ? (
        children()
      ) : (
        <div
          className="msg-lazy"
          data-role={m.role}
          data-lazy
          style={held ? { height: held, maxHeight: 'none', boxSizing: 'border-box' } : undefined}
        >
          {text}
        </div>
      )}
    </li>
  );
});
