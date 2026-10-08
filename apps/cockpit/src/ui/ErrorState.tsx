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
 * ------------------------------------------------------------------
 */

import type { ApiError } from '@nvx/contracts';
import { useState } from 'react';
import { notify } from '../state/notify';
import { Icon } from './Icon';

export function ErrorState({
  error,
  onRetry,
  compact = false,
}: {
  error: ApiError;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const e = error.error;

  const copy = async () => {
    const debug = {
      error: e,
      app: { name: 'NVX Ancile Cockpit', version: '0.1.0' },
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
          {onRetry && e.retryable ? (
            <button type="button" className="btn btn--primary btn--sm" onClick={onRetry}>
              <Icon name="regenerate" size={14} /> Try again
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>
            <Icon name={copied ? 'check' : 'copyDebug'} size={14} />
            {copied ? 'Copied' : 'Copy debug info'}
          </button>
          <span className="error-state__trace" data-num title="Trace id">
            {e.trace_id.slice(0, 12)}
          </span>
        </div>
      </div>
    </div>
  );
}
