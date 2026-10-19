/**
 * ------------------------------------------------------------------
 *  Title    |  Working now
 *  Ref      |  docs/events.md (tool.call title) · lib/run.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  While an answer is written, a short strip under it lists
 *           |  every step running right now, parallel calls too: each
 *           |  with its family's rule and icon, what it is doing, and
 *           |  its seconds ticking. A step waiting on you says so.
 *  How      |  workingNow() reads the live turn: every tool call with
 *           |  no result yet, its words from its tool.call (Core makes
 *           |  them from the full arguments) or contracts stepTitle().
 *           |  The same for every engine, Claude Code included: it
 *           |  needs only the run's events. Rows are memoised and only
 *           |  their timers tick, on the one shared clock (ToolSteps).
 *  Note     |  A list, not a live region: the ticking seconds are never
 *           |  announced.
 * ------------------------------------------------------------------
 */

import { stepTitle } from '@nvx/contracts/steps';
import { memo } from 'react';
import type { LiveTurn } from '../lib/run';
import { Icon } from '../ui/Icon';
import { FAMILY_WORD, familyOf, kindOf, Since, stepIcon } from './ToolSteps';
import '../styles/tools.css';

/** One step running now. */
export interface NowStep {
  callId: string;
  tool: string;
  title: string;
  /** When it was called (server time); null when the stream was joined after it. */
  start: string | null;
  /** It waits on your decision. */
  waiting: boolean;
}

/** Every step of the live turn still without a result, in the order they were called. */
export function workingNow(t: LiveTurn | undefined): NowStep[] {
  if (!t || t.done) return [];
  const settled = new Set<string>();
  for (const p of t.parts) if (p.type === 'tool_result') settled.add(p.call_id);
  const out: NowStep[] = [];
  for (const p of t.parts) {
    if (p.type !== 'tool_call' || settled.has(p.call_id)) continue;
    const clock = t.calls[p.call_id];
    out.push({
      callId: p.call_id,
      tool: p.tool,
      title: clock?.title || stepTitle(p.tool, p.args),
      start: clock?.start ?? null,
      waiting: !!t.approvals[p.call_id],
    });
  }
  return out;
}

/** "Running pnpm test", "Running pnpm test and 2 more"; null when nothing runs. */
export function nowWords(steps: NowStep[]): string | null {
  const first = steps[0];
  if (!first) return null;
  return steps.length > 1 ? `${first.title} and ${steps.length - 1} more` : first.title;
}

/** Rows shown before the rest are counted. */
export const NOW_ROWS = 4;

const NowRow = memo(function NowRow({
  tool,
  title,
  start,
  waiting,
}: Pick<NowStep, 'tool' | 'title' | 'start' | 'waiting'>) {
  const kind = kindOf(tool);
  const family = familyOf(kind);
  return (
    <li className="working-now__step" data-family={family} data-state={waiting ? 'waiting' : 'running'}>
      <Icon name={stepIcon(kind)} size={12} className="working-now__icon" label={FAMILY_WORD[family]} />
      <span className="working-now__title" title={title}>
        {title}
      </span>
      {waiting ? (
        <span className="working-now__wait">Waiting</span>
      ) : start ? (
        <Since start={start} className="working-now__time" label="Running for" />
      ) : null}
    </li>
  );
});

export function WorkingNow({ steps }: { steps: NowStep[] }) {
  if (!steps.length) return null;
  const more = steps.length - NOW_ROWS;
  return (
    <ul className="working-now" aria-label="Working now">
      {steps.slice(0, NOW_ROWS).map((s) => (
        <NowRow key={s.callId} tool={s.tool} title={s.title} start={s.start} waiting={s.waiting} />
      ))}
      {more > 0 ? <li className="working-now__more">and {more} more</li> : null}
    </ul>
  );
}
