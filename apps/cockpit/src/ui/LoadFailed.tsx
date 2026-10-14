/**
 * ------------------------------------------------------------------
 *  Title    |  Load failed
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What a panel shows when a read fails: the failure in
 *           |  its own words with Try again. Never an empty list, and
 *           |  never a "create one" action, in place of data that did
 *           |  not load. StaleNotice is the slim line for a refresh
 *           |  that failed while the last answer is still on screen.
 *  How      |  Core's ApiError as it came. A Core that never answered
 *           |  (OfflineError) or an answer the Cockpit could not read
 *           |  gets the Cockpit's own words in the same shape. Try
 *           |  again refetches, which is harmless, so a read always
 *           |  offers it (ErrorState retry="always").
 *  Note     |  Lent to Pro's screens through proKit.ui (pro/slot.tsx).
 * ------------------------------------------------------------------
 */

import type { ApiError } from '@nvx/contracts';
import { ApiCallError, OfflineError } from '../lib/api';
import { ErrorState } from './ErrorState';
import { Icon } from './Icon';

/** Any failed read as an ApiError to show: Core's words when it answered, the Cockpit's when not. */
export function loadError(error: unknown, what: string): ApiError {
  if (error instanceof ApiCallError) return error.body;
  const offline = error instanceof OfflineError;
  return {
    error: {
      code: offline ? 'cockpit.offline' : 'cockpit.load_failed',
      title: `${what} could not be loaded`,
      hint: offline
        ? 'NVX Ancile is not answering. Check that it is running, then try again.'
        : 'Try again. If it keeps failing, copy the debug info and report it.',
      retryable: true,
      // Never reached Core, so there is no trace to name.
      trace_id: '',
      attempts: [],
      context: {
        service: 'cockpit',
        ...(offline ? {} : { message: error instanceof Error ? error.message : String(error) }),
      },
    },
  };
}

/** A read that failed with nothing to show: what went wrong, and Try again. */
export function LoadFailed({
  error,
  what,
  onRetry,
  compact = false,
}: {
  error: unknown;
  /** What was being loaded, as the start of a sentence: "Sources", "The licence". */
  what: string;
  /** Usually the query's refetch; a returned promise keeps the button busy until it settles. */
  onRetry: () => unknown;
  compact?: boolean;
}) {
  return <ErrorState error={loadError(error, what)} onRetry={onRetry} retry="always" compact={compact} />;
}

/**
 * A refresh failed and the last answer is still on screen: keep it, and
 * say so in one slim line with Try again. Core being down is the
 * connection banner's to say, so an OfflineError shows nothing here.
 */
export function StaleNotice({
  error,
  what,
  onRetry,
  note = 'What you see was loaded earlier.',
}: {
  error: unknown;
  what: string;
  onRetry: () => unknown;
  /** What is on screen instead, in one sentence. */
  note?: string;
}) {
  if (!error || error instanceof OfflineError) return null;
  const reason = error instanceof ApiCallError ? error.body.error.title.replace(/\.$/, '') : null;
  return (
    <p className="load-stale" role="status">
      <Icon name="alert" size={13} />
      <span>
        {what} could not be loaded{reason ? `: ${reason}` : ''}. {note}
      </span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onRetry()}>
        Try again
      </button>
    </p>
  );
}
