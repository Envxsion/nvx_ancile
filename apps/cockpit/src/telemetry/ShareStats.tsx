/**
 * ------------------------------------------------------------------
 *  Title    |  Share anonymous usage stats
 *  Ref      |  docs/telemetry.md · Settings → Privacy
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Ask once, plainly, whether NVX Ancile may send counts
 *           |  and timings, and let you change your mind at any time.
 *  How      |  ShareStatsCard shows only while the answer is unset
 *           |  (setup's last step, then Home). PrivacyGroup is the
 *           |  Settings section: the switch, what was sent when, and
 *           |  the exact next batch, as JSON.
 *  Note     |  Off by default. Saying no erases the install id, the
 *           |  queue and every counter in Core.
 * ------------------------------------------------------------------
 */

import type { telemetry } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { refreshConsent } from '../lib/telemetry';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import '../styles/telemetry.css';

const KEY = ['telemetry'] as const;

type Preview = {
  batch: telemetry.TelemetryBatch | null;
  today: Record<string, unknown>;
  active: Record<string, unknown>;
};

function useStatus() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<telemetry.TelemetryStatus>('/telemetry'),
    staleTime: 60_000,
  });
}

function useConsent() {
  return useMutation({
    mutationFn: (share: boolean) => api.put<telemetry.TelemetryStatus>('/telemetry/consent', { share }),
    onSuccess: (s) => {
      queryClient.setQueryData(KEY, s);
      void queryClient.invalidateQueries({ queryKey: ['telemetry', 'preview'] });
      void refreshConsent();
    },
    onError: () =>
      notify({
        level: 'error',
        title: 'Not saved',
        body: 'Check that NVX Ancile is running, then try again.',
      }),
  });
}

const WHAT =
  'Counts and timings only: which features get used, how fast answers start, which errors happen. Never your words, files, names, links or answers.';

/** The one-time question. Renders nothing once you have answered. */
export function ShareStatsCard({ place }: { place: 'setup' | 'home' }) {
  const status = useStatus();
  const consent = useConsent();
  if (status.data?.consent !== 'unset') return null;
  return (
    <section className="share-stats" data-place={place} aria-labelledby="share-stats-title">
      <div className="share-stats__text">
        <h2 id="share-stats-title" className="share-stats__title">
          Share anonymous usage stats?
        </h2>
        <p className="mute">
          {WHAT} It helps decide what to fix and build next. You can change this in Settings → Privacy.
        </p>
      </div>
      <div className="share-stats__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => consent.mutate(true)}
          data-busy={consent.isPending || undefined}
        >
          Share stats
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => consent.mutate(false)}>
          No thanks
        </button>
      </div>
    </section>
  );
}

/** Settings → Privacy. */
export function PrivacyGroup() {
  const q = useContext(SearchContext);
  const status = useStatus();
  const consent = useConsent();
  const [showing, setShowing] = useState(false);
  const preview = useQuery({
    queryKey: ['telemetry', 'preview'],
    queryFn: () => api.get<Preview>('/telemetry/preview'),
    enabled: showing,
  });
  const s = status.data;
  const on = s?.consent === 'granted';
  if (
    !matches(q, 'Share anonymous usage stats', WHAT, 'privacy telemetry statistics analytics what is shared')
  )
    return null;
  return (
    <>
      <Block title="Usage statistics">
        <div className="setting">
          <div className="setting__words">
            <div className="setting__label">
              <span>Share anonymous usage stats</span>
            </div>
            <p className="setting__desc">{WHAT}</p>
          </div>
          <div className="setting__control">
            <Switch
              label="Share anonymous usage stats"
              checked={on}
              onChange={(share) => consent.mutate(share)}
            />
          </div>
        </div>
        <div className="setting" data-stack>
          <ul className="privacy__facts mute">
            <li>
              A random id is made when you turn this on, and erased when you turn it off, with everything
              waiting to be sent.
            </li>
            <li>
              Your licence, email and account are never linked to it. Only the edition (free or Pro) is sent.
            </li>
            <li>
              {s?.endpoint
                ? on
                  ? s.last_sent_at
                    ? `Last sent ${relative(s.last_sent_at)}. ${s.queued} waiting.`
                    : `${s.queued} waiting to be sent.`
                  : 'Nothing is sent while this is off.'
                : 'This build has no statistics address, so nothing is ever sent from it.'}
            </li>
          </ul>
        </div>
      </Block>

      <Block
        title="What is shared"
        lede="The exact batch that would be sent next, and today's counts so far. The full list of what can and can never be sent is in docs/telemetry.md; the server refuses anything not on it."
      >
        <div className="setting privacy__preview" data-stack>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowing((v) => !v)}>
            <Icon name={showing ? 'chevronDown' : 'chevronRight'} size={13} />
            {showing ? 'Hide' : 'Show the next batch'}
          </button>
          {showing ? (
            <pre className="privacy__json" data-scrollable>
              {preview.isPending
                ? 'Loading…'
                : JSON.stringify(
                    {
                      next_batch: preview.data?.batch ?? (on ? 'nothing queued' : 'sharing is off'),
                      today_so_far: preview.data?.today ?? {},
                      active_would_say: preview.data?.active ?? {},
                    },
                    null,
                    2,
                  )}
            </pre>
          ) : null}
        </div>
      </Block>
    </>
  );
}
