/**
 * ------------------------------------------------------------------
 *  Title    |  Live run footer
 *  Ref      |  docs/events.md (activity, tool.call title)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  While an answer is written, one quiet line under it says
 *           |  what is happening now, for how long, and how much has
 *           |  come back: "Reading the data models · 1m 27s · ↓ 2.1k
 *           |  tokens", then Stop.
 *  How      |  livePhase() reads the live turn (lib/run.ts): an approval
 *           |  first, then an engine's own activity (hooks, compaction),
 *           |  a GPU node waking, the step running (its title from
 *           |  contracts steps.ts), and otherwise thinking or writing.
 *           |  Tokens are what the engine reported, or about one per
 *           |  four characters streamed.
 *  Note     |  The same for every engine: it needs only the run's events.
 * ------------------------------------------------------------------
 */

import { stepTitle } from '@nvx/contracts';
import { type LiveTurn, useRuns } from '../lib/run';
import { Icon } from '../ui/Icon';
import { elapsed, useNow } from './ToolSteps';

/** What the run is doing now, in a few words. */
export function livePhase(t: LiveTurn | undefined, waiting: boolean): string {
  if (waiting || t?.approvalId || t?.status === 'waiting_approval') return 'Waiting for your decision';
  if (!t) return 'Thinking';
  if (t.activity)
    return (
      t.activity.detail ?? (t.activity.phase === 'hooks' ? 'Running hooks' : 'Compacting the conversation')
    );
  if (t.waking) return 'Waking the GPU node';
  const done = new Set(t.parts.flatMap((p) => (p.type === 'tool_result' ? [p.call_id] : [])));
  const running = t.parts.findLast((p) => p.type === 'tool_call' && !done.has(p.call_id));
  if (running?.type === 'tool_call') return stepTitle(running.tool, running.args);
  const last = t.parts.at(-1);
  if (last?.type === 'text') return 'Writing';
  if (t.status === 'queued') return 'Starting';
  return 'Thinking';
}

/** Tokens so far: what the engine reported, or about four characters to a token. */
export function liveTokens(t: LiveTurn | undefined): number {
  if (!t) return 0;
  return t.reportedTokens ?? Math.round(t.streamedChars / 4);
}

/** "2.1k", "830". */
export function shortCount(n: number): string {
  if (n < 1000) return n.toLocaleString('en-GB');
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000).toLocaleString('en-GB')}k`;
}

export function LiveFooter({
  messageId,
  waiting,
  onStop,
}: {
  messageId: string;
  waiting: boolean;
  /** Absent while the answer waits on you: the approval card has the actions then. */
  onStop?: (() => void) | undefined;
}) {
  const t = useRuns((s) => s.turns[messageId]);
  const now = useNow(true);
  const phase = livePhase(t, waiting);
  const start = t?.startedAt ? Date.parse(t.startedAt) : Number.NaN;
  const tokens = liveTokens(t);
  return (
    <div className="msg__live">
      <span className="live-foot" data-phase={waiting ? 'waiting' : undefined}>
        <span className="live-foot__phase">{phase}</span>
        {Number.isFinite(start) ? (
          <span className="live-foot__time" data-num>
            {elapsed(now - start)}
          </span>
        ) : null}
        {tokens > 0 ? (
          <span className="live-foot__tokens" data-num title="Tokens streamed so far">
            ↓ {shortCount(tokens)} tokens
          </span>
        ) : null}
      </span>
      {onStop ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onStop}>
          <Icon name="close" size={12} />
          Stop
        </button>
      ) : null}
    </div>
  );
}
