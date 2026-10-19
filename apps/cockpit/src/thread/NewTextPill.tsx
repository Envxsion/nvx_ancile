/**
 * ------------------------------------------------------------------
 *  Title    |  New text below
 *  Ref      |  ROADMAP TC1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Scroll up while an answer is being written and nothing
 *           |  says more is arriving below. This pill does: a small
 *           |  "New text below" with the live dot, and a press brings
 *           |  you to the end.
 *  How      |  It watches the scroller. While you are within 80 px of
 *           |  the end it records how much text there is; once you
 *           |  are further up, any growth in text or steps (not a
 *           |  step opening, which adds none) shows the pill. It
 *           |  appears once per time you scroll away, not per token,
 *           |  so a very fast stream does not flicker it, and a
 *           |  polite live region says "New text below" once.
 *  Note     |  The catch-up scrolls smoothly, or jumps when motion is
 *           |  reduced. The dot is the live dot: it means "arriving".
 * ------------------------------------------------------------------
 */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { useRuns } from '../lib/run';
import { Icon } from '../ui/Icon';

/** Closer than this to the end counts as being at the end (the same line ThreadView follows by). */
export const AT_END_PX = 80;

/** How far from the end the scroller is. */
export const gapBelow = (el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): number =>
  el.scrollHeight - el.scrollTop - el.clientHeight;

/** Text characters plus one per other part: what grows while an answer is written. */
export function streamedSize(parts: readonly { type: string; text?: string }[] | undefined): number {
  return (parts ?? []).reduce((n, p) => n + (p.type === 'text' ? (p.text?.length ?? 0) : 1), 0);
}

export function NewTextPill({
  scroller,
  following,
  lastId,
  messageCount,
  threadId,
  ready,
}: {
  scroller: RefObject<HTMLElement | null>;
  following: RefObject<boolean>;
  lastId: string | undefined;
  messageCount: number;
  threadId: string;
  /** The list is mounted (the thread has loaded). */
  ready: boolean;
}) {
  const size = useRuns((s) => (lastId ? streamedSize(s.turns[lastId]?.parts) : 0));
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const seen = useRef({ size, messageCount });

  // Where you are: at the end, or scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach when the thread or its list changes
  useEffect(() => {
    const el = scroller.current;
    setAway(false);
    setFresh(false);
    if (!el) return;
    const on = () => setAway(gapBelow(el) >= AT_END_PX);
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, [scroller, threadId, ready]);

  // At the end: remember how much there is. Further up: growth is new text.
  useEffect(() => {
    if (!away) {
      seen.current = { size, messageCount };
      setFresh(false);
      return;
    }
    if (size > seen.current.size || messageCount > seen.current.messageCount) setFresh(true);
  }, [away, size, messageCount]);

  const catchUp = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = true;
    const reduced = document.documentElement.dataset.motion === 'reduced';
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <div className="newtext">
      <p className="sr-only" role="status" aria-live="polite">
        {fresh ? 'New text below.' : ''}
      </p>
      {fresh ? (
        <button type="button" className="newtext__pill" onClick={catchUp}>
          <span className="live-dot" aria-hidden="true" />
          New text below
          <Icon name="arrowDown" size={12} />
        </button>
      ) : null}
    </div>
  );
}
