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
 *           |  use on another computer offers "Move it here". Pro
 *           |  arrives and leaves only by update: a free build takes
 *           |  the key too, then says Pro is on its way; the update
 *           |  the desktop app offers (GET /system/update-offer) says
 *           |  when Pro is ready, or that Pro ended and the free
 *           |  edition is coming. Installing is the tray menu's click.
 * ------------------------------------------------------------------
 */

import type { license, system } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { CopyButton, LoadFailed, reportFailure } from './common';

type Details = license.LicenseDetails;
type Offer = license.UpdateOffer['offer'];

const KEY = ['ops', 'licence'] as const;
export const UPDATE_OFFER_KEY = ['system', 'update-offer'] as const;
const PRO_DATA_KEY = ['system', 'pro-data'] as const;
/** Every row Pro keeps, as one JSON file (works in every edition). */
export const PRO_DATA_EXPORT = '/api/v1/system/pro-data/export';

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

/** Where a key holder gets the Pro installer (current licences get short-lived links). */
const PRO_DOWNLOAD = 'https://ancile.nvx.sh/pro/download';
const RENEW = 'https://ancile.nvx.sh';
const TOASTED = 'ancile.update-offer.toasted';

/** The toast for an offer, once per offer (not on every visit). */
function toastOnce(offer: Offer): void {
  if (!offer || offer.kind === 'update') return;
  const mark = `${offer.kind}:${offer.version}`;
  try {
    if (localStorage.getItem(TOASTED) === mark) return;
    localStorage.setItem(TOASTED, mark);
  } catch {
    // No storage (a private window): a toast per visit is fine.
  }
  notify(
    offer.kind === 'pro'
      ? {
          id: `update-offer-${mark}`,
          level: 'success',
          title: 'Pro is ready',
          body: `Install NVX Ancile Pro ${offer.version} from the tray menu.`,
        }
      : {
          id: `update-offer-${mark}`,
          level: 'info',
          title: 'Pro ended',
          body: 'Switching to the free edition: choose it in the tray menu. Your data stays.',
        },
  );
}

export function LicenceScreen() {
  const details = useQuery({ queryKey: KEY, queryFn: () => api.get<Details>('/license/details') });
  // An ancile://activate link (desktop app) opens this screen with ?key=…
  // filled in; activating is still the person's own press.
  const [key, setKey] = useState(() =>
    formatKey(new URLSearchParams(window.location.search).get('key') ?? ''),
  );
  // What the desktop app's tray is offering: Pro arriving, or Pro ended.
  const offerQ = useQuery({
    queryKey: UPDATE_OFFER_KEY,
    queryFn: () => api.get<license.UpdateOffer>('/system/update-offer'),
    refetchInterval: 60_000,
  });
  const offer = offerQ.data?.offer ?? null;
  useEffect(() => toastOnce(offer), [offer]);
  // What Pro made here: kept, readable and exportable whatever the licence says.
  const proData = useQuery({
    queryKey: PRO_DATA_KEY,
    queryFn: () => api.get<system.ProDataSummary>('/system/pro-data'),
    retry: false,
  });
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
      notify(
        d.build === 'free'
          ? {
              level: 'success',
              title: 'Pro is on its way',
              body: 'It arrives as an update: choose Check for updates in the NVX Ancile tray menu, then Install.',
            }
          : { level: 'success', title: 'Pro is on', body: 'Thank you. Everything it adds is ready now.' },
      );
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
  const freeBuild = d.build === 'free';
  const ended = lapse === 'paused' || lapse === 'expired';
  const onItsWay = freeBuild && d.key_held && !ended && offer?.kind !== 'pro';
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
          {ended && offer?.kind !== 'downgrade' ? (
            <p className="edition__lapse" data-lapse="renew">
              Pro licence lapsed: renew to keep updates.{' '}
              <a href={RENEW} target="_blank" rel="noreferrer">
                Renew
              </a>
            </p>
          ) : null}
          {offer?.kind === 'downgrade' ? (
            <p className="edition__lapse" data-lapse="downgrade" role="status">
              Pro ended 90 days ago; switching to the free edition. Your data stays. Choose it in the NVX
              Ancile tray menu.
            </p>
          ) : null}
          {offer?.kind === 'pro' ? (
            <p className="edition__lapse" data-lapse="ready" role="status">
              Pro is ready. Install it from the tray menu (NVX Ancile Pro {offer.version}).
            </p>
          ) : null}
          {offer?.older ? (
            <p className="edition__lapse" data-lapse="older" role="status">
              NVX Ancile {offer.version} on offer is older than this version. Installing it from the tray
              backs up your data first; the older version then offers to restore the backup from before your
              last update.
            </p>
          ) : null}
          {onItsWay ? (
            <p className="edition__lapse" data-lapse="on-its-way" role="status">
              Pro is on its way. It arrives as an update: choose Check for updates in the NVX Ancile tray
              menu, then Install.
            </p>
          ) : null}
          {d.checked_at ? <p className="mute edition__checked">Checked {relative(d.checked_at)}</p> : null}
        </div>
        {pro || d.key_held ? (
          <div className="edition__actions">
            {freeBuild ? null : (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => refresh.mutate()}
                data-busy={refresh.isPending || undefined}
              >
                Check now
              </button>
            )}
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => deactivate.mutate()}>
              Move to another computer
            </button>
          </div>
        ) : null}
      </section>

      {d.problem ? <p className="licence__problem">{d.problem}</p> : null}

      {(proData.data?.total_rows ?? 0) > 0 && (!pro || ended) ? (
        <section className="licence__prodata m-glass" aria-label="Your Pro data">
          <p>
            <strong>Your Pro data is kept.</strong>{' '}
            <span className="mute">
              {proData.data?.total_rows} {proData.data?.total_rows === 1 ? 'item' : 'items'} that Pro made are
              still on this computer. Nothing is deleted when Pro ends, and turning Pro on again brings them
              back.
            </span>
          </p>
          <a className="btn btn--ghost btn--sm" href={PRO_DATA_EXPORT} download>
            <Icon name="download" size={14} /> Export Pro data
          </a>
        </section>
      ) : null}

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

      {seatTaken ? (
        <div className="licence__seat m-glass" role="alert">
          <p>
            <strong>This key is already on as many computers as it allows</strong>
            {seatTaken.length ? ` (${seatTaken.join(', ')})` : ''}. Move it here, and the one used least
            recently goes back to the free edition.
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

      {!pro && (d.build === 'pro' || !d.key_held) ? (
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
              {freeBuild
                ? 'From your nvx.sh account. Pro then arrives as an update, and your data stays as it is.'
                : 'From your nvx.sh account. A signed token pasted from there works too.'}
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
      <p className="mute licence__reinstall">
        <a href={PRO_DOWNLOAD} target="_blank" rel="noreferrer">
          Reinstalling on a new computer? Get the Pro installer
        </a>
      </p>
    </div>
  );
}
