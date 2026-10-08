/**
 * ------------------------------------------------------------------
 *  Title    |  Why did the AI say this?
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The whole chain behind one answer: which model and
 *           |  what it tried first, the memory it was given, the
 *           |  sources it read, the tools and decisions, the cost.
 *  How      |  Reads GET /messages/:id/explain (DESIGN.md §11.4).
 *           |  TODO(phase-4): live data, and "Replay" opening the
 *           |  step-by-step trace view.
 * ------------------------------------------------------------------
 */

import * as demo from '../fixtures/demo';
import { modelName, usd } from '../lib/format';
import { Icon } from '../ui/Icon';

export function WhyDemo() {
  const x = demo.explain;
  return (
    <div className="panel why">
      <section className="why__section">
        <h3 className="why__h">Model</h3>
        <p>
          Answered by <strong>{modelName(x.answered)}</strong>
          {x.requested && x.requested !== x.answered ? (
            <>
              {' '}
              because <strong>{modelName(x.requested)}</strong> did not respond.
            </>
          ) : null}
        </p>
        <ol className="why__attempts">
          {x.attempts.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attempts are ordered
            <li key={i} data-outcome={a.outcome}>
              <span className="why__step" data-num>
                {i + 1}
              </span>
              <span>{modelName(a.model)}</span>
              <span className="mute">{a.reason ?? 'answered'}</span>
              <span data-num className="mute why__ms">
                {(a.ms / 1000).toFixed(1)} s
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="why__section">
        <h3 className="why__h">Memory it was given</h3>
        <ul className="why__memory">
          {x.memory.map((m) => (
            <li key={m.path}>
              <div className="why__file">
                <Icon name="memory" size={13} />
                <span>{m.path}</span>
                <span data-num className="mute">
                  {m.commit} · {m.tokens} tok
                </span>
              </div>
              <ul className="why__entries">
                {m.entries.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section className="why__section">
        <h3 className="why__h">Sources it read</h3>
        <ul className="why__retrieval">
          {x.retrieval.map((r) => (
            <li key={r.title} data-cited={r.cited || undefined}>
              <span
                className="why__bar"
                style={{ width: `${Math.round(r.rerank * 100)}%` }}
                aria-hidden="true"
              />
              <span className="why__rtitle">{r.title}</span>
              <span data-num className="mute">
                {r.rerank.toFixed(2)}
              </span>
              <span className="why__cited">{r.cited ? 'cited' : 'not used'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="why__section">
        <h3 className="why__h">Tools and decisions</h3>
        <p className="mute">{x.tools.length === 0 ? 'No tools were used for this answer.' : null}</p>
      </section>

      <section className="why__section why__usage">
        <span>
          <span data-num>{x.usage.input.toLocaleString('en-GB')}</span> in
        </span>
        <span>
          <span data-num>{x.usage.output.toLocaleString('en-GB')}</span> out
        </span>
        <span data-num>{usd(x.usage.costUsd, 3)}</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled
          title="Open one of your own answers to replay it"
        >
          Replay step by step
        </button>
      </section>
    </div>
  );
}
