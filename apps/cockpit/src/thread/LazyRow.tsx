/**
 * ------------------------------------------------------------------
 *  Title    |  Rows drawn when they come near
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A long thread costs only what is on screen: a message
 *           |  far from the viewport is its plain text (so the page's
 *           |  own find still finds it), and becomes the full message
 *           |  (markdown, highlighted code, tool steps) the first time
 *           |  it comes within a couple of screens. It stays drawn
 *           |  after that, so scrolling back is instant.
 *  How      |  One IntersectionObserver per thread scroller (LazyRoot)
 *           |  watches every row. Rows marked eager (the last few, a
 *           |  streaming answer, one waiting on an approval, the one
 *           |  you jumped to) are drawn at once. Without
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

type Watch = (el: Element, onNear: () => void) => () => void;
const LazyContext = createContext<Watch | null>(null);

/** One observer for all rows in `scroller`. */
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
    const waiting = new Map<Element, () => void>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const cb = waiting.get(e.target);
          if (!cb) continue;
          waiting.delete(e.target);
          io.unobserve(e.target);
          cb();
        }
      },
      { root: scroller.current, rootMargin: LAZY_MARGIN },
    );
    setWatch(() => (el: Element, onNear: () => void) => {
      waiting.set(el, onNear);
      io.observe(el);
      return () => {
        waiting.delete(el);
        io.unobserve(el);
      };
    });
    return () => io.disconnect();
  }, [scroller]);
  return <LazyContext.Provider value={watch}>{children}</LazyContext.Provider>;
}

/** What a row shows before it is drawn in full: its words, at reading measure. */
export function placeholderText(m: MessageView, max = 1_200): string {
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
  /** The full row; only called once the row is drawn. */
  children: () => ReactNode;
}) {
  const watch = useContext(LazyContext);
  const [near, setNear] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Without IntersectionObserver at all, draw in full, as before. With it, a
  // row waits for the observer rather than drawing everything on first paint.
  const drawn = eager || near || typeof IntersectionObserver === 'undefined';
  useEffect(() => {
    if (drawn || !watch || !ref.current) return;
    return watch(ref.current, () => setNear(true));
  }, [drawn, watch]);
  const text = useMemo(() => (drawn ? '' : placeholderText(m)), [drawn, m]);
  if (drawn) return <>{children()}</>;
  return (
    <div ref={ref} className="msg-lazy" data-role={m.role} data-lazy>
      {text}
    </div>
  );
});
