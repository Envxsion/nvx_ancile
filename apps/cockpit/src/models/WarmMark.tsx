/**
 * ------------------------------------------------------------------
 *  Title    |  The warm mark
 *  Ref      |  ROADMAP.md CA12
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A small dot beside a model that has this thread cached
 *           |  right now. It fades as the cache runs out, and says so in
 *           |  words for the tooltip and for screen readers.
 *  How      |  useWarmMarks(threadId) reads the cache state and ticks
 *           |  every 30 s while the picker is open; <WarmMark> draws one.
 *           |  Alias entries ("latest") match the model they answer with.
 *  Note     |  Calm ink, never the signal colour: warm is not live state.
 * ------------------------------------------------------------------
 */

import type { ModelEntry } from '../engines/api';
import { findCacheItem, useCacheState, useNow, warmLeftMs, warmOpacity, warmWords } from './cacheState';
import '../styles/cache.css';

export interface Warm {
  words: string;
  opacity: number;
}

/** For each picker entry, its warm mark or null. Call inside the open picker, so the clock runs only then. */
/** `active`: read and tick only while the list showing the marks is open (the palette is mounted all the time). */
export function useWarmMarks(threadId: string | undefined, active = true): (e: ModelEntry) => Warm | null {
  const state = useCacheState(active ? threadId : undefined);
  const now = useNow(30_000, active && !!state?.items.length);
  return (e) => {
    const item = findCacheItem(state?.items, e);
    const left = warmLeftMs(item, now);
    if (!item || left <= 0) return null;
    return { words: warmWords(item, left), opacity: warmOpacity(left) };
  };
}

export function WarmMark({ warm }: { warm: Warm }) {
  return (
    <span
      className="warm-mark"
      role="img"
      aria-label={warm.words}
      title={warm.words}
      style={{ opacity: warm.opacity }}
    />
  );
}
