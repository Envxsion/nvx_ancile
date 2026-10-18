/**
 * ------------------------------------------------------------------
 *  Title    |  Step by step
 *  Ref      |  roadmap WY1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The ordered steps of one answer: context gathered,
 *           |  each model call, each tool, with the time or cost on
 *           |  the right. Folded inside the receipt's cost section.
 *  How      |  Built by buildSteps (figures.ts) from the per-call
 *           |  records, the answer's tool parts and the retries that
 *           |  worked. A step whose time was not recorded shows no
 *           |  time rather than a guess.
 *  Note     |  A model call's dot takes the signal colour only while
 *           |  the answer is still being written (live state).
 * ------------------------------------------------------------------
 */

import { useId, useState } from 'react';
import { Icon } from '../ui/Icon';
import { money, type Step, secondsWords } from './figures';

export function Timeline({ steps, live = false }: { steps: Step[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!steps.length) return null;
  return (
    <div className="rc-fold">
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
          {steps.map((s, i) => (
            <li
              key={s.id}
              className="rc-step"
              data-kind={s.kind}
              data-live={(live && s.kind === 'model' && i === steps.length - 1) || undefined}
            >
              <span className="rc-step__dot" aria-hidden="true" />
              <span className="rc-step__label">{s.label}</span>
              <span className="rc-step__detail mute">
                {s.detail ?? ''}
                {s.note ? `${s.detail ? ', ' : ''}${s.note}` : ''}
              </span>
              <span className="rc-step__end" data-num>
                {s.costUsd !== null ? `${money(s.costUsd)} · ` : ''}
                {s.ms !== null ? secondsWords(s.ms) : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
