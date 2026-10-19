/**
 * ------------------------------------------------------------------
 *  Title    |  Live run footer
 *  Ref      |  docs/events.md (activity, tool.call title)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  While an answer is written, one quiet line under it says
 *           |  what is happening now, for how long, and how much has
 *           |  come back: "Reading the data models · 1m 27s · ↓ 2.1k
 *           |  tokens", then Stop. While steps run, the line reads
 *           |  "Working now" and the strip under it lists every one
 *           |  (WorkingNow.tsx), parallel calls too.
 *  How      |  livePhase() reads the live turn (lib/run.ts): an approval
 *           |  first, then an engine's own activity (hooks, compaction),
 *           |  a GPU node waking, the steps running (a step's title
 *           |  from contracts steps.ts), and otherwise thinking or
 *           |  writing. Tokens are what the engine reported, or about
 *           |  one per four characters streamed. Only the seconds tick,
 *           |  on the one shared clock (ToolSteps).
 *           |  Once the notebook's sources have been searched, a quiet
 *           |  "Searched 3 sources" line opens to the query and each
 *           |  passage's source with its score (EV2), not only the count.
 *  Note     |  The same for every engine: it needs only the run's events.
 * ------------------------------------------------------------------
 */

import { stepTitle } from '@nvx/contracts';
import { useMemo } from 'react';
import { type LiveTurn, useRuns } from '../lib/run';
import { searchedLabel } from '../receipt/figures';
import { Icon } from '../ui/Icon';
import { Since } from './ToolSteps';
import { WorkingNow, workingNow } from './WorkingNow';

/** What the run is doing now, and whether that is its steps (which the strip then lists). */
export function phaseOf(t: LiveTurn | undefined, waiting: boolean): { words: string; steps: boolean } {
  if (waiting || t?.approvalId || t?.status === 'waiting_approval')
    return { words: 'Waiting for your decision', steps: false };
  if (!t) return { words: 'Thinking', steps: false };
  if (t.activity)
    return {
      words:
        t.activity.detail ?? (t.activity.phase === 'hooks' ? 'Running hooks' : 'Compacting the conversation'),
      steps: false,
    };
  if (t.waking) return { words: 'Waking the GPU node', steps: false };
  const done = new Set(t.parts.flatMap((p) => (p.type === 'tool_result' ? [p.call_id] : [])));
  const running = t.parts.filter((p) => p.type === 'tool_call' && !done.has(p.call_id));
  const latest = running.at(-1);
  if (latest?.type === 'tool_call')
    return {
      words:
        running.length > 1
          ? `Running ${running.length} steps at once`
          : (t.calls[latest.call_id]?.title ?? stepTitle(latest.tool, latest.args)),
      steps: true,
    };
  const last = t.parts.at(-1);
  if (last?.type === 'text') return { words: 'Writing', steps: false };
  if (t.status === 'queued') return { words: 'Starting', steps: false };
  return { words: 'Thinking', steps: false };
}

/** What the run is doing now, in a few words. */
export function livePhase(t: LiveTurn | undefined, waiting: boolean): string {
  return phaseOf(t, waiting).words;
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

/** What the search of the notebook's sources found: a line that opens to the query and the passages. */
export function SearchedLine({ r }: { r: NonNullable<LiveTurn['retrieval']> }) {
  if (!r.found.length && !r.query)
    return (
      <p className="live-search" data-none>
        {searchedLabel(r)}
      </p>
    );
  return (
    <details className="live-search">
      <summary>{searchedLabel(r)}</summary>
      {r.query ? <p className="live-search__query">“{r.query}”</p> : null}
      {r.found.length ? (
        <ul className="live-search__found">
          {r.found.slice(0, 6).map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ranked in a fixed order
            <li key={i}>
              <span>
                {f.source_title}
                {f.page != null ? `, p. ${f.page}` : ''}
              </span>
              <span data-num className="mute">
                {f.score.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
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
  const phase = phaseOf(t, waiting);
  const steps = useMemo(() => workingNow(t), [t]);
  const tokens = liveTokens(t);
  return (
    <div className="live-now">
      <div className="msg__live">
        <span className="live-foot" data-phase={waiting ? 'waiting' : undefined}>
          <span className="live-foot__phase">
            {phase.steps && steps.length ? 'Working now' : phase.words}
          </span>
          {t?.startedAt ? <Since start={t.startedAt} className="live-foot__time" /> : null}
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
      {t?.retrieval ? <SearchedLine r={t.retrieval} /> : null}
      <WorkingNow steps={steps} />
    </div>
  );
}
