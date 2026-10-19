/**
 * ------------------------------------------------------------------
 *  Title    |  Find in this thread
 *  Ref      |  roadmap TS2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A find bar for the thread: a count, Enter for the next
 *           |  match and Shift+Enter for the one before, Escape to
 *           |  close. It finds words in folded tool steps, in thinking
 *           |  and in messages the list has not drawn.
 *  How      |  lib/threadFind.ts searches the messages' data. For the
 *           |  match you are on, the thread scrolls to its message
 *           |  (ThreadView), then this bar opens the fold that holds
 *           |  it and marks the words with the browser's highlight
 *           |  (CSS.highlights) where it has one. The count is read
 *           |  out politely; motion is never added, so reduced motion
 *           |  needs nothing.
 * ------------------------------------------------------------------
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFind } from '../lib/findStore';
import { FIND_MAX, type FindHit, findInThread, keepActive, stepIndex } from '../lib/threadFind';
import type { MessageView } from '../lib/types';
import { Icon } from '../ui/Icon';
import { applyFindMarks, clearFindMarks, revealHit } from './findDom';

export function FindBar({ messages }: { messages: MessageView[] }) {
  const hide = useFind((s) => s.hide);
  const goTo = useFind((s) => s.goTo);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(-1);
  const hits = useMemo(() => findInThread(messages, q), [messages, q]);
  const prev = useRef<FindHit | undefined>(undefined);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    return clearFindMarks;
  }, []);

  // The list changed (typing, or an answer streaming): keep the match you were on where it still is.
  useEffect(() => {
    const i = q.trim() ? keepActive(prev.current, hits) : -1;
    setAt(i);
  }, [hits, q]);

  const active = at >= 0 ? hits[at] : undefined;
  useEffect(() => {
    prev.current = active;
  }, [active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chosen match changes
  useEffect(() => {
    if (!active) return clearFindMarks();
    goTo(active);
  }, [at, q]);

  // The thread has scrolled to the message: open the fold and mark the words.
  const jump = useFind((s) => s.jump);
  useEffect(() => {
    if (!jump || jump.step || !q.trim()) return;
    let tries = 0;
    let raf = 0;
    const settle = () => {
      const done = revealHit(jump.hit, q.trim());
      if (!done && tries++ < 20) raf = requestAnimationFrame(settle);
      else applyFindMarks(jump.hit, q.trim());
    };
    raf = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(raf);
  }, [jump, q]);

  const step = (dir: 1 | -1) => setAt((i) => stepIndex(i, hits.length, dir));
  const many = hits.length >= FIND_MAX;
  const status = !q.trim()
    ? ''
    : hits.length
      ? `${at + 1} of ${hits.length.toLocaleString('en-GB')}${many ? '+' : ''}`
      : 'No matches';

  return (
    <search className="findbar" aria-label="Find in this thread">
      <Icon name="search" size={13} />
      <input
        ref={input}
        className="findbar__input"
        type="text"
        value={q}
        placeholder="Find in this thread"
        aria-label="Find in this thread"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            hide();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="findbar__count mute" data-num role="status" aria-live="polite">
        {status}
      </span>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Previous match"
        disabled={!hits.length}
        onClick={() => step(-1)}
      >
        <Icon name="chevronDown" size={13} className="findbar__up" />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Next match"
        disabled={!hits.length}
        onClick={() => step(1)}
      >
        <Icon name="chevronDown" size={13} />
      </button>
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Close find" onClick={hide}>
        <Icon name="close" size={13} />
      </button>
    </search>
  );
}
