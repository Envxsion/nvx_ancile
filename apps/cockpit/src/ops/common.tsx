/**
 * ------------------------------------------------------------------
 *  Title    |  Operations: shared pieces
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the Phase 5 admin screens share: error reporting
 *           |  in the product's voice, a failed-load state with retry,
 *           |  copy-to-clipboard with a tick, durations in words, and
 *           |  a tiny sparkline.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { ApiCallError } from '../lib/api';
import { notify } from '../state/notify';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';

export function reportFailure(error: unknown, what: string): void {
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : `${what} failed`,
    body:
      error instanceof ApiCallError
        ? error.body.error.hint
        : 'Check that NVX Ancile is running, then try again.',
  });
}

export function LoadFailed({ error, what, onRetry }: { error: unknown; what: string; onRetry: () => void }) {
  if (error instanceof ApiCallError) return <ErrorState error={error.body} onRetry={onRetry} />;
  return (
    <EmptyState
      icon="alert"
      title={`${what} could not be loaded`}
      body="Core did not answer. Check that NVX Ancile is running, then try again."
      action={{ label: 'Try again', onClick: onRetry }}
    />
  );
}

export function CopyButton({
  text,
  label = 'Copy',
  small,
}: {
  text: string;
  label?: string;
  small?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn--ghost ${small ? 'btn--sm' : ''} copy-btn`}
      data-done={done || undefined}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1_400);
          })
          .catch(() =>
            notify({
              level: 'error',
              title: 'Could not copy',
              body: 'Select the text and copy it yourself.',
            }),
          );
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={13} />
      {done ? 'Copied' : label}
    </button>
  );
}

/** 340 ms, 4.2 s, 3 min 10 s. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** In 4 min, in 2 h, tomorrow 03:00. */
export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Not scheduled';
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'Due now';
  if (ms < 60_000) return `In ${Math.ceil(ms / 1000)} s`;
  if (ms < 3_600_000) return `In ${Math.round(ms / 60_000)} min`;
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (ms < 86_400_000 && d.getDate() === new Date(now).getDate()) return `Today at ${time}`;
  if (ms < 2 * 86_400_000) return `Tomorrow at ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })} at ${time}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function Sparkline({ values, max }: { values: number[]; max?: number }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 60 18" aria-hidden="true" />;
  const top = Math.max(max ?? 0, ...values, 1);
  const step = 60 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(17 - (v / top) * 15).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 60 18" aria-hidden="true">
      <polyline points={`0,18 ${pts} 60,18`} className="spark__fill" />
      <polyline points={pts} className="spark__line" />
    </svg>
  );
}
