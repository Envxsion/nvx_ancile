/**
 * ------------------------------------------------------------------
 *  Title    |  Licence
 *  Ref      |  DESIGN.md §9 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Which edition this is, what Pro adds (everything in the
 *           |  brief works on free), and turning Pro on with a key from
 *           |  nvx.sh. Pro is "owned", so it wears the gilt.
 *  How      |  The key field formats as you type (NVX-XXXX-XXXX-XXXX);
 *           |  a pasted signed token is accepted as it is. A key in
 *           |  use on another computer offers "Move it here". A free
 *           |  build (no pro/) says so and links to nvx.sh instead of
 *           |  asking for a key it could never use.
 * ------------------------------------------------------------------
 */

import type { license } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { CopyButton, LoadFailed, reportFailure } from './common';

type Details = license.LicenseDetails;

const KEY = ['ops', 'licence'] as const;

/** NVX-XXXX-XXXX-XXXX as you type; anything longer is a token and left alone. */
export function formatKey(raw: string): string {
  if (raw.includes('.') || raw.length > 40) return raw.trim();
  const body = raw
    .toUpperCase()
    .replace(/^NVX-?/, '')
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 12);
  const groups = body.match(/.{1,4}/g) ?? [];
  return body ? `NVX-${groups.join('-')}` : raw.toUpperCase().startsWith('N') ? raw.toUpperCase() : '';
}

export function LicenceScreen() {
  const details = useQuery({ queryKey: KEY, queryFn: () => api.get<Details>('/license/details') });
  const [key, setKey] = useState('');
  /** The key is in use elsewhere: offer to move the seat here. */
  const [seatTaken, setSeatTaken] = useState<string[] | null>(null);
  const activate = useMutation({
    mutationFn: (transfer: boolean) =>
      api.post<Details>('/license/activate', { key, ...(transfer && { transfer: true }) }),
    onSuccess: (d) => {
      queryClient.setQueryData(KEY, d);
      void queryClient.invalidateQueries({ queryKey: ['license'] });
      setKey('');
      setSeatTaken(null);
      notify({ level: 'success', title: 'Pro is on', body: 'Thank you. Everything it adds is ready now.' });
    },
    onError: (e) => {
      if (e instanceof ApiCallError && e.body.error.code === 'license.seat_taken') {
        const ctx = (e.body.error as { context?: { devices?: { label: string }[] } }).context;
        setSeatTaken((ctx?.devices ?? []).map((x) => x.label));
        return;
      }
      reportFailure(e, 'Activation');
    },
  });
  const refresh = useMutation({
    mutationFn: () => api.post<Details>('/license/refresh', {}),
    onSuccess: (d) => queryClient.setQueryData(KEY, d),
    onError: (e) => reportFailure(e, 'Checking'),
  });
  const deactivate = useMutation({
    mutationFn: () => api.post<Details>('/license/deactivate', {}),
    onSuccess: (d) => {
      queryClient.setQueryData(KEY, d);
      notify({
        level: 'info',
        title: 'Back on the free edition',
        body: 'Your key can be used on another computer now.',
      });
    },
    onError: (e) => reportFailure(e, 'Deactivating'),
  });

  if (details.isPending) return <Skeleton lines={5} label="Loading the licence" />;
  if (details.isError && !details.data)
    return <LoadFailed error={details.error} what="The licence" onRetry={() => void details.refetch()} />;
  const d = details.data;
  const pro = d.status.tier !== 'free';
  const tester = d.status.tier === 'max_access';
  const lapse = d.status.lapse;
  const until = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const valid =
    /^NVX-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(key) || (key.includes('.') && key.length > 40);

  return (
    <div className="ops licence">
      <section className="edition" data-pro={pro || undefined}>
        <div className="edition__seal" aria-hidden="true">
          <Icon name={pro ? 'seal' : 'key'} size={22} />
        </div>
        <div className="edition__text">
          <h2 className="edition__title">
            {pro ? 'NVX Ancile Pro' : 'NVX Ancile'}
            {pro ? <span className="edition__badge">{tester ? 'Tester' : 'Pro'}</span> : null}
          </h2>
          <p className="mute">
            {pro
              ? d.status.expires_at
                ? `Checked with nvx.sh every day. Works offline until ${until(d.status.expires_at)}.`
                : 'Yours to keep.'
              : 'The free edition. Everything for working with your own models, sources and memory is here, and stays free.'}
          </p>
          {lapse ? (
            <p className="edition__lapse" data-lapse={lapse}>
              {lapse === 'offline'
                ? `nvx.sh could not be reached. Pro keeps working until ${d.status.expires_at ? until(d.status.expires_at) : 'it is checked again'}.`
                : lapse === 'renewal_due'
                  ? 'Pro has not been renewed yet. Connect to the internet so it can be checked.'
                  : lapse === 'paused'
                    ? 'This licence is paused, so Pro is off. Your key is kept: Pro comes back when it is resumed.'
                    : 'This licence has ended, so Pro is off. Renew it in your nvx.sh account, then check again.'}
            </p>
          ) : null}
          {d.checked_at ? <p className="mute edition__checked">Checked {relative(d.checked_at)}</p> : null}
        </div>
        {pro || d.key_held ? (
          <div className="edition__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => refresh.mutate()}
              data-busy={refresh.isPending || undefined}
            >
              Check now
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => deactivate.mutate()}>
              Move to another computer
            </button>
          </div>
        ) : null}
      </section>

      {d.problem ? <p className="licence__problem">{d.problem}</p> : null}

      <ul className="feature-grid">
        {d.features.map((f, i) => (
          <li
            key={f.id}
            className="feature"
            data-unlocked={f.unlocked || undefined}
            style={{ animationDelay: `${i * 35}ms` }}
          >
            <Icon name={f.unlocked ? 'check' : 'lock'} size={14} />
            <div>
              <strong>{f.title}</strong>
              <span className="mute">{f.body}</span>
            </div>
          </li>
        ))}
      </ul>

      {!pro && d.build === 'free' ? (
        <p className="licence__free-build">
          This copy of NVX Ancile was built without Pro, so a key cannot turn it on. Download NVX Ancile from{' '}
          <a href="https://ancile.nvx.sh" target="_blank" rel="noreferrer">
            ancile.nvx.sh
          </a>{' '}
          to use Pro; your notebooks, threads and memory stay as they are.
        </p>
      ) : null}

      {seatTaken ? (
        <div className="licence__seat m-glass" role="alert">
          <p>
            <strong>This key is in use on another computer</strong>
            {seatTaken.length ? ` (${seatTaken.join(', ')})` : ''}. Move it here, and that computer goes back
            to the free edition.
          </p>
          <div className="licence__seat-actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => activate.mutate(true)}
              data-busy={activate.isPending || undefined}
            >
              Move it here
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setSeatTaken(null)}>
              Keep it there
            </button>
          </div>
        </div>
      ) : null}

      {!pro && d.build === 'pro' ? (
        <form
          className="activate m-glass"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) activate.mutate(false);
          }}
        >
          <label className="field">
            <span>Licence key</span>
            <input
              className="input input--mono activate__input"
              value={key}
              onChange={(e) => setKey(formatKey(e.target.value))}
              placeholder="NVX-XXXX-XXXX-XXXX"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={key.length > 0 && !valid ? true : undefined}
            />
            <span className="field__hint">
              From your nvx.sh account. A signed token pasted from there works too.
            </span>
          </label>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!valid || activate.isPending}
            data-busy={activate.isPending || undefined}
          >
            Turn on Pro
          </button>
        </form>
      ) : null}

      <p className="mute licence__device">
        This computer: <code>{d.device_id}</code> <CopyButton text={d.device_id} small />
      </p>
    </div>
  );
}
