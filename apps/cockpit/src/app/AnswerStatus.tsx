/**
 * ------------------------------------------------------------------
 *  Title    |  Answer status for screen readers
 *  Ref      |  ROADMAP D9
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Streaming has a busy signal for assistive technology:
 *           |  "Answering" when a reply starts, "Answer finished"
 *           |  when it ends, never the streamed words themselves.
 *  How      |  A polite live region that re-renders only when "is
 *           |  any answer running" flips, so the composer and the
 *           |  message list are not touched per token (P2).
 * ------------------------------------------------------------------
 */

import { useRef } from 'react';
import { useRuns } from '../lib/run';

export function AnswerStatus() {
  const busy = useRuns((s) => Object.values(s.turns).some((t) => !t.done));
  const was = useRef(false);
  const text = busy ? 'Answering' : was.current ? 'Answer finished' : '';
  was.current = busy;
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
