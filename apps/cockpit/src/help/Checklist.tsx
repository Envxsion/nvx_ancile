/**
 * ------------------------------------------------------------------
 *  Title    |  Getting started
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The first steps (steps.ts), ticked off by doing them,
 *           |  never by clicking a box. It folds into one line in the
 *           |  rail's foot, and leaves for good once it is done.
 *  How      |  Steps are marked from where the action happens
 *           |  (helpDone in turns.ts, models.ts, branching.ts, the
 *           |  flows API, Palette, notebooks), or read from the
 *           |  workspace itself. Clicking a step does it, or walks you
 *           |  through it. Finishing earns one quiet gilt moment.
 * ------------------------------------------------------------------
 */

import { useEffect, useRef, useState } from 'react';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { useRunStep } from './FirstSteps';
import { STEPS, useFirstSteps } from './steps';
import { useHelp } from './store';

function Ring({ value }: { value: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className="checklist__ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} className="checklist__track" />
      <circle
        cx="9"
        cy="9"
        r={r}
        className="checklist__fill"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

export function Checklist() {
  const steps = useFirstSteps();
  const dismiss = useHelp((s) => s.dismissChecklist);
  const run = useRunStep();
  const [open, setOpen] = useState(false);
  const celebrated = useRef(steps.complete);

  useEffect(() => {
    if (steps.complete && !celebrated.current) {
      celebrated.current = true;
      notify({
        level: 'success',
        title: 'You know your way around',
        body: 'Every first step done. The guide is always one key away: G H.',
      });
    }
  }, [steps.complete]);

  if (steps.dismissed || steps.complete) return null;

  return (
    <div className="checklist" data-open={open || undefined}>
      <button
        type="button"
        className="checklist__head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Ring value={steps.done / steps.total} />
        <span className="checklist__title">Getting started</span>
        <span className="checklist__count" data-num>
          {steps.done}/{steps.total}
        </span>
        <Icon name="chevronDown" size={12} className="checklist__caret" />
      </button>
      {open ? (
        <div className="checklist__body">
          <ul>
            {STEPS.map((s) => {
              const done = steps.isDone(s.id);
              return (
                <li key={s.id} data-done={done || undefined}>
                  <button type="button" className="checklist__step" title={s.why} onClick={() => void run(s)}>
                    <span className="checklist__tick">{done ? <Icon name="check" size={11} /> : null}</span>
                    <span>{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="link-btn link-btn--quiet" onClick={dismiss}>
            Hide this list
          </button>
        </div>
      ) : null}
    </div>
  );
}
