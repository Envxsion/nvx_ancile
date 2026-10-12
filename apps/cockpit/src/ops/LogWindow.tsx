/**
 * ------------------------------------------------------------------
 *  Title    |  A long list drawn a window at a time
 *  Ref      |  thread/LazyRow.tsx (the same idea for messages)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Fifty thousand log lines cost what is on screen: lines
 *           |  are drawn in blocks of a hundred, and only the blocks
 *           |  within a couple of screens of the viewport hold rows.
 *           |  The rest are empty boxes of the right height, so the
 *           |  scrollbar and your place in the list stay true.
 *  How      |  Blocks are counted from the oldest line, so new lines
 *           |  arriving at the top only ever change the first block:
 *           |  the others keep their keys and their drawn rows. One
 *           |  IntersectionObserver on the scroller draws a block when
 *           |  it comes near and empties it when it moves away,
 *           |  keeping its measured height for the empty box. The
 *           |  newest block is always drawn. Drawn blocks also carry
 *           |  content-visibility: auto, so the browser skips painting
 *           |  the ones off screen. Without IntersectionObserver every
 *           |  block is drawn, as before.
 *  Note     |  Lines in an empty block are not in the page, so the
 *           |  browser's own find does not see them; the screen's
 *           |  search box asks the server instead. Give the window a
 *           |  new `key` when the list is replaced (a new filter), so
 *           |  remembered heights start again.
 * ------------------------------------------------------------------
 */

import { Fragment, type ReactNode, type RefObject, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** Lines per block. */
export const LOG_BLOCK = 100;
/** A collapsed line's height before a block has been measured, in pixels. */
export const LOG_ROW_ESTIMATE = 27;
/** How far outside the viewport a block is drawn ahead of time. */
export const LOG_WINDOW_MARGIN = '1200px 0px';

export interface Block<T> {
  /** Stable while lines arrive at the top: its index counted from the oldest block. */
  key: number;
  items: T[];
}

/** Split newest-first items into blocks counted from the oldest, so a prepend only touches the first. */
export function blocksOf<T>(items: readonly T[], size = LOG_BLOCK): Block<T>[] {
  const n = items.length;
  if (n === 0) return [];
  const first = n % size || size;
  const count = Math.ceil(n / size);
  const out: Block<T>[] = [{ key: count - 1, items: items.slice(0, first) }];
  for (let start = first, key = count - 2; start < n; start += size, key--)
    out.push({ key, items: items.slice(start, start + size) });
  return out;
}

export function LogWindow<T>({
  items,
  scroller,
  keyOf,
  render,
  rowEstimate = LOG_ROW_ESTIMATE,
}: {
  /** Newest first. */
  items: readonly T[];
  scroller: RefObject<HTMLElement | null>;
  keyOf: (item: T) => string | number;
  render: (item: T) => ReactNode;
  rowEstimate?: number;
}) {
  const blocks = useMemo(() => blocksOf(items), [items]);
  const newest = blocks[0]?.key ?? 0;
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set());
  const heights = useRef(new Map<number, number>());
  const io = useRef<IntersectionObserver | null>(null);
  /** Each block's element, by key, whether or not the observer exists yet. */
  const elements = useRef(new Map<number, Element>());
  const keys = useRef(new WeakMap<Element, number>());
  const refs = useRef(new Map<number, (el: HTMLDivElement | null) => void>());
  const windowed = typeof IntersectionObserver !== 'undefined';

  useLayoutEffect(() => {
    if (!windowed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setNear((prev) => {
          let next: Set<number> | null = null;
          for (const e of entries) {
            const key = keys.current.get(e.target);
            if (key === undefined) continue;
            const has = (next ?? prev).has(key);
            if (e.isIntersecting && !has) {
              next ??= new Set(prev);
              next.add(key);
            } else if (!e.isIntersecting && has) {
              // Leaving: remember how tall it was, so the empty box keeps your place.
              if (e.boundingClientRect.height > 0) heights.current.set(key, e.boundingClientRect.height);
              next ??= new Set(prev);
              next.delete(key);
            }
          }
          return next ?? prev;
        });
      },
      { root: scroller.current, rootMargin: LOG_WINDOW_MARGIN },
    );
    io.current = observer;
    // Blocks attached their elements before this ran: watch them now.
    for (const el of elements.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      io.current = null;
    };
  }, [scroller, windowed]);

  /** One stable ref per block, so a re-render never re-observes. */
  const refFor = (key: number) => {
    let fn = refs.current.get(key);
    if (!fn) {
      fn = (el) => {
        const prev = elements.current.get(key);
        if (prev && prev !== el) {
          io.current?.unobserve(prev);
          elements.current.delete(key);
        }
        if (el && prev !== el) {
          elements.current.set(key, el);
          keys.current.set(el, key);
          io.current?.observe(el);
        }
      };
      refs.current.set(key, fn);
    }
    return fn;
  };

  return (
    <>
      {blocks.map((b) => {
        const drawn = !windowed || b.key === newest || near.has(b.key);
        // The same element either way, so the observer keeps watching it.
        return drawn ? (
          <div key={b.key} ref={refFor(b.key)} className="logblock">
            {b.items.map((item) => (
              <Fragment key={keyOf(item)}>{render(item)}</Fragment>
            ))}
          </div>
        ) : (
          <div
            key={b.key}
            ref={refFor(b.key)}
            className="logblock"
            data-idle
            aria-hidden
            style={{ height: heights.current.get(b.key) ?? b.items.length * rowEstimate }}
          />
        );
      })}
    </>
  );
}
