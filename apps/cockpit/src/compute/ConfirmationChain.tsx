/**
 * ------------------------------------------------------------------
 *  Title    |  Confirmation chain
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Anything that touches infrastructure shows each link
 *           |  as it is confirmed: requested, acknowledged, in
 *           |  progress, confirmed. In the UI, not just the logs.
 *  How      |  A four-node rail. Reached links light in signal, the
 *           |  current one pulses, a failed link turns fail and the
 *           |  provider's own message and our suggested fix appear
 *           |  beneath it (DESIGN.md §13.3).
 *  Note     |  Fed by node.operation events or /operations/:id/stream.
 * ------------------------------------------------------------------
 */

import { Icon } from '../ui/Icon';

export const CHAIN = ['Requested', 'Acknowledged', 'In progress', 'Confirmed'] as const;

export interface ChainProps {
  title: string;
  /** Index of the last link reached, 0..3 */
  reached: number;
  failed?: boolean;
  timeline: string[];
  detail: string;
  suggestion?: string;
}

export function ConfirmationChain({
  title,
  reached,
  failed = false,
  timeline,
  detail,
  suggestion,
}: ChainProps) {
  const done = reached >= CHAIN.length - 1 && !failed;
  return (
    <section
      className="chain"
      data-failed={failed || undefined}
      data-done={done || undefined}
      aria-label={title}
    >
      <header className="chain__head">
        <span className="chain__title">{title}</span>
        <span className="chain__state">{failed ? 'Failed' : done ? 'Confirmed' : 'Working'}</span>
      </header>
      <ol className="chain__links">
        {CHAIN.map((label, i) => {
          const state =
            failed && i === reached + 1
              ? 'failed'
              : i < reached || (i === reached && (done || failed))
                ? 'done'
                : i === reached
                  ? 'current'
                  : 'todo';
          return (
            <li
              key={label}
              className="chain__link"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="chain__node" aria-hidden="true">
                {state === 'done' ? (
                  <Icon name="check" size={10} />
                ) : state === 'failed' ? (
                  <Icon name="close" size={10} />
                ) : null}
              </span>
              <span className="chain__label">{label}</span>
              <span className="chain__time" data-num>
                {timeline[i] ?? ''}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="chain__detail">{detail}</p>
      {failed && suggestion ? (
        <p className="chain__fix">
          <Icon name="why" size={14} />
          <span>{suggestion}</span>
        </p>
      ) : null}
    </section>
  );
}
