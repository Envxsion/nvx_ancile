/**
 * ------------------------------------------------------------------
 *  Title    |  Error state
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Render any ApiError as what happened, the specifics,
 *           |  and what to do, with "Copy debug info" for the rest.
 *           |  Never a stack trace (DESIGN.md §11.3).
 *  How      |  Debug info is the error body plus environment basics,
 *           |  already redacted by the server. TODO(phase-5): append
 *           |  the trace's recent spans and log tail from /traces/:id.
 *  Note     |  Try again follows `retry`: an action's failure offers
 *           |  it only when the error says a retry can help; a read's
 *           |  failure (LoadFailed) always does, since asking again is
 *           |  harmless and Core may simply have restarted.
 * ------------------------------------------------------------------
 */

import type { ApiError } from '@nvx/contracts';
import { useState } from 'react';
import { COCKPIT_VERSION } from '../lib/build';
import { notify } from '../state/notify';
import { Icon } from './Icon';

/** When Try again is offered: 'if-retryable' (an action, the default) or 'always' (a read). */
export type RetryPolicy = 'always' | 'if-retryable';

export function ErrorState({
  error,
  onRetry,
  retry = 'if-retryable',
  compact = false,
}: {
  error: ApiError;
  /** Returning a promise keeps the button busy until it settles. */
  onRetry?: () => unknown;
  retry?: RetryPolicy;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const e = error.error;
  const canRetry = Boolean(onRetry) && (retry === 'always' || e.retryable);

  const again = () => {
    if (!onRetry || retrying) return;
    const out = onRetry();
    if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
      setRetrying(true);
      // A retry that fails again is the caller's to show (the query's new error); here it only ends the wait.
      const done = () => setRetrying(false);
      Promise.resolve(out).then(done, done);
    }
  };

  const copy = async () => {
    const debug = {
      error: e,
      app: { name: 'NVX Ancile Cockpit', version: COCKPIT_VERSION },
      url: location.pathname,
      userAgent: navigator.userAgent,
      at: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(debug, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      notify({
        level: 'warn',
        title: 'Clipboard is blocked',
        body: 'Select the trace id and copy it by hand.',
      });
    }
  };

  return (
    <div className="error-state" data-compact={compact || undefined} role="alert">
      <span className="error-state__icon">
        <Icon name="alert" />
      </span>
      <div className="error-state__text">
        <p className="error-state__title">{e.title}</p>
        {e.detail ? <p className="error-state__detail">{e.detail}</p> : null}
        <p className="error-state__hint">{e.hint}</p>
        {e.attempts.length > 0 ? (
          <ol className="error-state__attempts" aria-label="What NVX Ancile tried">
            {e.attempts.map((a) => (
              <li key={`${a.target}-${a.ms}`}>
                <span data-num>{a.target}</span> <span className="mute">{a.class ?? 'failed'}</span>{' '}
                <span data-num className="mute">
                  {a.ms} ms
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="error-state__actions">
          {canRetry ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              aria-disabled={retrying || undefined}
              data-busy={retrying || undefined}
              onClick={again}
            >
              <Icon name="regenerate" size={14} /> {retrying ? 'Trying again' : 'Try again'}
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>
            <Icon name={copied ? 'check' : 'copyDebug'} size={14} />
            {copied ? 'Copied' : 'Copy debug info'}
          </button>
          {/* A failure that never reached Core has no trace to name. */}
          {e.trace_id ? (
            <span className="error-state__trace" data-num title="Trace id">
              {e.trace_id.slice(0, 12)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
