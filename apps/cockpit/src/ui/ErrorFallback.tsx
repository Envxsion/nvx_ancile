/**
 * ------------------------------------------------------------------
 *  Title    |  Error boundary card
 *  Ref      |  ROADMAP ER1, P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The full card an ErrorBoundary shows: icon, the way
 *           |  back, and Copy debug info / Report.
 *  How      |  Split from the boundary so the first download carries
 *           |  only the boundary itself (ui/ErrorBoundary.tsx fetches
 *           |  this when something breaks, and keeps a plain card of
 *           |  the same size on screen until it arrives).
 * ------------------------------------------------------------------
 */

import { COCKPIT_VERSION } from '../lib/build';
import { notify } from '../state/notify';
import type { BoundaryScope } from './ErrorBoundary';
import { Icon } from './Icon';

export interface FallbackProps {
  scope: BoundaryScope;
  label?: string | undefined;
  quiet?: boolean | undefined;
  error: Error;
  title: string;
  hint: string;
  chunk: boolean;
  onRetry: () => void;
}

function copy(e: Error, scope: string, label: string | undefined, report: boolean) {
  const text = [
    `NVX Ancile ${COCKPIT_VERSION}`,
    `Scope: ${scope}${label ? ` (${label})` : ''}`,
    `Error: ${e.name}: ${e.message}`,
    `Page: ${location.pathname}`,
  ].join('\n');
  const out = report ? `For NVX Ancile support. Nothing has been sent.\n\n${text}` : text;
  void navigator.clipboard
    ?.writeText(out)
    .then(() =>
      notify({
        level: 'success',
        title: report ? 'Report copied' : 'Debug info copied',
        ...(report && { body: 'Nothing was sent. Paste it where you report problems.' }),
      }),
    )
    .catch(() =>
      notify({ level: 'error', title: 'Could not copy', body: 'Select the text and copy it yourself.' }),
    );
}

export function ErrorFallback({ scope, label, quiet, error, title, hint, chunk, onRetry }: FallbackProps) {
  return (
    <div className="error-state" role="alert" data-compact={quiet || undefined} data-boundary={scope}>
      <span className="error-state__icon" aria-hidden="true">
        <Icon name="alert" size={18} />
      </span>
      <div className="error-state__text">
        <p className="error-state__title">{title}</p>
        <p className="error-state__hint">{hint}</p>
        <div className="error-state__actions">
          {scope === 'shell' ? (
            <>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => location.reload()}>
                Reload
              </button>
              <a className="btn btn--ghost btn--sm" href="/?safe=1">
                Start in safe mode
              </a>
            </>
          ) : (
            <button type="button" className="btn btn--primary btn--sm" onClick={onRetry}>
              {chunk ? 'Try again' : 'Reload this panel'}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => copy(error, scope, label, false)}
          >
            Copy debug info
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => copy(error, scope, label, true)}
          >
            Report
          </button>
        </div>
      </div>
    </div>
  );
}
