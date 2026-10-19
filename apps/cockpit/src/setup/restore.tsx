/**
 * ------------------------------------------------------------------
 *  Title    |  Restore from the setup step
 *  Ref      |  ROADMAP SU1 · docs/runbooks/restore-backup.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Choose a backup in setup, restart, and have it put
 *           |  back without leaving setup: a staged restore, with its
 *           |  progress shown, that carries on if NVX Ancile is
 *           |  closed part-way.
 *  How      |  GET /system/restore says what is staged. Choosing only
 *           |  stages it (POST /system/restore/stage); "Restart and
 *           |  restore" asks for the restart (POST .../apply). Core
 *           |  applies it before it opens the database and shows
 *           |  RestoreProgress on the start-up screen; the desktop app
 *           |  then starts again by itself, elsewhere you restart it.
 *  Note     |  Restoring replaces what is here, so the panel says so
 *           |  before the button, and a safety copy is kept. Backups
 *           |  are not passphrase-protected, so the only error here is
 *           |  a backup that cannot be read, which names the safety
 *           |  copy. Every part can be skipped: setup carries on.
 * ------------------------------------------------------------------
 */

import type { system } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { reportFailure } from '../ops/common';
import { Icon } from '../ui/Icon';

export const RESTORE_KEY = ['system', 'restore'] as const;

export const sizeOf = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;

const dateOf = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** Where a restore is, in words, and how far along (a restore is three steps, so it is coarse and honest). */
export function stepWords(m: system.StagedRestore): { words: string; at: number } {
  switch (m.step) {
    case 'safety':
      return { words: 'Keeping a copy of what is here first', at: 1 };
    case 'clearing':
      return { words: 'Clearing what is here', at: 2 };
    case 'restoring':
      return { words: 'Putting your backup back', at: 3 };
    case 'done':
      return { words: 'Restored', at: 4 };
    default:
      return { words: 'Waiting to start', at: 0 };
  }
}

/**
 * After "Restart and restore": wait for Core to come back as the progress screen (or as the
 * app again) and load it, so the person sees the progress rather than a dead window.
 */
export async function followRestart(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const s = await api.get<system.StartupStatus>('/system/startup');
      if (s.state === 'stopped' || s.restore?.state === 'done') {
        window.location.assign('/');
        return;
      }
    } catch {
      // Core is restarting.
    }
  }
}

/** The staged restore in the setup step: choose, confirm, restart. */
export function StagedRestorePanel({ backups }: { backups: system.Backup[] }) {
  const q = useQuery({
    queryKey: RESTORE_KEY,
    queryFn: () => api.get<system.StagedRestoreState>('/system/restore'),
    retry: false,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const done = () => void q.refetch();
  const stage = useMutation({
    mutationFn: (backup: string) =>
      api.post<system.StagedRestore>('/system/restore/stage', {
        backup,
      } satisfies system.StageRestoreRequest),
    onSuccess: done,
    onError: (e) => reportFailure(e, 'Choosing the backup'),
  });
  const drop = useMutation({
    mutationFn: () => api.del('/system/restore'),
    onSuccess: () => {
      setNote(null);
      done();
    },
    onError: (e) => reportFailure(e, 'Dropping the choice'),
  });
  const apply = useMutation({
    mutationFn: () => api.post<{ restarting: boolean }>('/system/restore/apply', {}),
    onSuccess: (r) => {
      if (r.restarting) {
        setNote('NVX Ancile is restarting to restore your backup. This window follows it.');
        void followRestart();
      } else {
        setNote(
          'Restart NVX Ancile now. It restores your backup as it starts, and shows how far it has got.',
        );
      }
      done();
    },
    onError: (e) => reportFailure(e, 'Restarting to restore'),
  });

  const staged = q.data?.restore ?? null;
  const busy = stage.isPending || drop.isPending || apply.isPending;

  if (staged && (staged.state === 'restarting' || staged.state === 'running')) {
    return (
      <div className="restore" role="status">
        <p className="restore__line">
          <Icon name="clock" size={14} />{' '}
          {note ?? 'Waiting for NVX Ancile to restart and restore your backup.'}
        </p>
        <p className="mute restore__small">
          It carries on by itself if NVX Ancile is closed before it finishes.
        </p>
      </div>
    );
  }
  if (staged?.state === 'done') {
    return (
      <div className="restore" role="status">
        <p className="restore__line">
          <Icon name="check" size={14} /> Restored from <code>{staged.backup}</code>.
          {staged.attempts > 1 ? ' It carried on after a restart.' : ''}
        </p>
        <div className="restore__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => drop.mutate()}
          >
            Done
          </button>
        </div>
      </div>
    );
  }
  if (staged?.state === 'failed') {
    return (
      <div className="restore">
        <p className="restore__fail" role="alert">
          <strong>{staged.error?.title ?? 'The backup could not be restored'}.</strong>{' '}
          {staged.error?.hint ?? 'Choose another backup, or skip this step.'}
        </p>
        {staged.safety ? (
          <p className="mute restore__small">
            What was here before is kept in <code>{staged.safety}</code>.
          </p>
        ) : null}
        <div className="restore__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy}
            data-busy={apply.isPending || undefined}
            onClick={() => apply.mutate()}
          >
            Try again
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => drop.mutate()}
          >
            Choose another
          </button>
        </div>
      </div>
    );
  }
  if (staged?.state === 'staged') {
    const b = backups.find((x) => x.name === staged.backup);
    return (
      <div className="restore">
        <p className="restore__line">
          Ready to restore <code>{staged.backup}</code> ({sizeOf(staged.bytes)}
          {b ? `, from ${dateOf(b.created_at)}` : ''}).
        </p>
        <p className="mute restore__small">
          NVX Ancile restarts, replaces what is here with this backup, then opens again. What is here now is
          kept as a backup first. A large backup takes a while, and it carries on if NVX Ancile is closed.
        </p>
        <div className="restore__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy}
            data-busy={apply.isPending || undefined}
            onClick={() => apply.mutate()}
          >
            Restart and restore
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => drop.mutate()}
          >
            Choose another
          </button>
        </div>
        {note ? (
          <p className="restore__line" role="status">
            {note}
          </p>
        ) : null}
      </div>
    );
  }
  if (!backups.length) return null;
  return (
    <fieldset className="restore restore__pick" disabled={busy}>
      <legend>Restore a backup here</legend>
      <ul className="move__list">
        {backups.map((b) => (
          <li key={b.name}>
            <label className="restore__option">
              <input
                type="radio"
                name="restore-backup"
                value={b.name}
                checked={chosen === b.name}
                onChange={() => setChosen(b.name)}
              />
              <span>{dateOf(b.created_at)}</span>
              <span className="mute">{sizeOf(b.bytes)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="restore__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!chosen || busy}
          data-busy={stage.isPending || undefined}
          onClick={() => chosen && stage.mutate(chosen)}
        >
          Choose this backup
        </button>
        <span className="mute restore__small">Nothing changes until you restart. You can skip this.</span>
      </div>
    </fieldset>
  );
}

/** The start-up screen while Core applies a staged restore (the status polls until it ends). */
export function RestoreProgress({ status }: { status: system.StartupStatus }) {
  const m = status.restore;
  if (!m) return null;
  const { words, at } = stepWords(m);
  const failed = m.state === 'failed';
  return (
    <div className="restore" role="status" aria-live="polite">
      <p className="restore__line">
        {failed ? (
          <>
            <strong>{m.error?.title ?? 'The backup could not be restored'}.</strong>{' '}
            {m.error?.hint ?? 'Try again.'}
          </>
        ) : (
          <>
            {words}: <code>{m.backup}</code> ({sizeOf(m.bytes)})
          </>
        )}
      </p>
      {failed ? null : (
        <div
          className="restore__bar"
          role="progressbar"
          aria-label="Restoring your backup"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={at}
        >
          <span style={{ transform: `scaleX(${at / 4})` }} />
        </div>
      )}
      <p className="mute restore__small">
        {m.state === 'done'
          ? 'Restored. NVX Ancile opens again in a moment; if it does not, restart it.'
          : failed
            ? m.safety
              ? `What was here before is kept in ${m.safety}.`
              : 'Nothing was changed.'
            : `Step ${Math.min(at + 1, 3)} of 3. A large backup takes a while. If NVX Ancile is closed, it carries on the next time it starts.${m.attempts > 1 ? ' It has carried on after a restart.' : ''}`}
      </p>
    </div>
  );
}
