/**
 * ------------------------------------------------------------------
 *  Title    |  Step by step
 *  Ref      |  roadmap WY1 · CH4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The ordered steps of one answer: context gathered,
 *           |  each model call, each tool, with when it started, how
 *           |  long it took, how it ended, and its tokens or cost.
 *           |  A click on a step finds it in the thread. Above the
 *           |  list, one line sums the turn up.
 *  How      |  Built by buildSteps (figures.ts) from the per-call
 *           |  records, the answer's tool parts and the retries that
 *           |  worked. A step whose time was not recorded shows no
 *           |  time rather than a guess. Picking a step hands its
 *           |  message and tool call to the thread (lib/findStore),
 *           |  which scrolls to it and opens it.
 *  Note     |  A model call's dot takes the signal colour only while
 *           |  the answer is still being written (live state). The
 *           |  status is a word as well as a mark, never colour alone.
 *           |  TODO(phase-3): flows and subagents join the same list
 *           |  as their own rows when a run spans nodes.
 * ------------------------------------------------------------------
 */

import { useId, useState } from 'react';
import { useFind } from '../lib/findStore';
import { Icon } from '../ui/Icon';
import { money, type Step, secondsWords, spanWords } from './figures';

const STATUS_WORD: Record<NonNullable<Step['status']>, string> = {
  ok: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  waiting: 'No result recorded',
};

export function Timeline({
  steps,
  live = false,
  messageId,
  summary = null,
}: {
  steps: Step[];
  live?: boolean;
  /** The answer these steps belong to; with it, a step can be found in the thread. */
  messageId?: string;
  /** "Ran 12 steps in 1m 40s, changed 3 files, 41k tokens". */
  summary?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!steps.length) return null;
  const find = (s: Step) => {
    if (!messageId) return;
    useFind
      .getState()
      .goTo(
        s.callId
          ? { messageId, where: 'tool', callId: s.callId, nth: 0 }
          : { messageId, where: 'text', nth: 0 },
        { step: true },
      );
  };
  return (
    <div className="rc-fold">
      {summary ? (
        <p className="rc-summary" data-num>
          {summary}
        </p>
      ) : null}
      <button
        type="button"
        className="rc-fold__btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chevronRight" size={12} className="rc-fold__chev" />
        Step by step
      </button>
      {open ? (
        <ol className="rc-steps" id={id} aria-label="Steps in order">
          {steps.map((s, i) => {
            const body = (
              <>
                <span className="rc-step__dot" aria-hidden="true" />
                <span className="rc-step__at mute" data-num>
                  {s.atMs !== null ? `+${spanWords(s.atMs)}` : ''}
                </span>
                <span className="rc-step__label">{s.label}</span>
                <span className="rc-step__detail mute">
                  {s.detail ?? ''}
                  {s.note ? `${s.detail ? ', ' : ''}${s.note}` : ''}
                </span>
                <span className="rc-step__status" data-status={s.status ?? undefined}>
                  {s.status && s.status !== 'ok' ? STATUS_WORD[s.status] : ''}
                </span>
                <span className="rc-step__end" data-num>
                  {s.costUsd !== null ? `${money(s.costUsd)} · ` : ''}
                  {s.ms !== null ? secondsWords(s.ms) : ''}
                </span>
              </>
            );
            const liveStep = (live && s.kind === 'model' && i === steps.length - 1) || undefined;
            return (
              <li key={s.id} className="rc-step" data-kind={s.kind} data-live={liveStep}>
                {messageId && s.kind !== 'context' ? (
                  <button
                    type="button"
                    className="rc-step__row"
                    aria-label={`Show ${s.label} in the thread`}
                    onClick={() => find(s)}
                  >
                    {body}
                  </button>
                ) : (
                  <span className="rc-step__row">{body}</span>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
