/**
 * ------------------------------------------------------------------
 *  Title    |  Why it was learned
 *  Ref      |  ROADMAP M3 · DESIGN.md §6.3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Under a suggestion: how sure NVX Ancile is, the words
 *           |  it learned from, and a link to the turn. If the thread
 *           |  has since been deleted, it says so instead of linking.
 *  How      |  Reads the proposal's evidence and the `source` Core
 *           |  resolves when it lists proposals. Used by the inbox card
 *           |  and the answer tray.
 * ------------------------------------------------------------------
 */

import type { MemoryProposal } from '@nvx/contracts';
import { useNavigate } from '@tanstack/react-router';
import { openTurn } from './api';

export const percent = (c: number) => `${Math.round(c * 100)}%`;

/** The wording for where it came from: a thread's name, or that it is gone. */
export function sourceWords(source: MemoryProposal['source']): string | null {
  if (!source) return null;
  if (source.thread_deleted) return 'Learned from a thread that was deleted';
  return source.thread_title ? `Learned in “${source.thread_title}”` : 'Learned in an untitled thread';
}

export function Evidence({ p }: { p: MemoryProposal }) {
  const navigate = useNavigate();
  const quote = p.evidence.find((e) => e.quote)?.quote;
  const words = sourceWords(p.source);
  const source = p.source && !p.source.thread_deleted ? p.source : null;
  const runOnly = !p.source && p.evidence.some((e) => e.run_id);

  return (
    <div className="mem-evidence">
      <div className="mem-evidence__row">
        <span className="mem-conf" title={`Confidence ${percent(p.confidence)}`}>
          <span className="mem-conf__fill" style={{ width: percent(p.confidence) }} />
        </span>
        <span className="mem-evidence__conf" data-num>
          {percent(p.confidence)} sure
        </span>
        {words ? (
          <span className="mute">{words}</span>
        ) : runOnly ? (
          <span className="mute">Learned from a run</span>
        ) : null}
        {source ? (
          <button
            type="button"
            className="link-btn link-btn--quiet"
            onClick={() =>
              openTurn(
                source,
                (t) =>
                  void navigate({
                    to: '/t/$threadId',
                    params: { threadId: t.threadId },
                    ...(t.hash && { hash: t.hash }),
                  }),
              )
            }
          >
            Open this turn
          </button>
        ) : null}
      </div>
      {quote ? (
        <blockquote className="mem-card__quote" aria-label="What it learned from">
          {quote}
        </blockquote>
      ) : null}
    </div>
  );
}
