/**
 * ------------------------------------------------------------------
 *  Title    |  Start-up screen
 *  Ref      |  ROADMAP.md track G · docs/desktop.md (Updates and your data)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When Core stopped before opening the database (it was
 *           |  updated by a newer NVX Ancile, the backup before an
 *           |  update failed, the disk is full, an update was undone),
 *           |  say what happened and offer what can be done: restore
 *           |  the backup from before the update, try again, continue
 *           |  without a backup, or install the newer version again.
 *  How      |  StartupGate asks GET /system/startup once. Running: the
 *           |  app renders as usual. Stopped: this screen replaces it.
 *           |  After an action the desktop app starts every service
 *           |  again; the screen waits for Core, then reloads.
 *  Note     |  Restoring replaces the database: it asks once more, and
 *           |  what is there now is kept as a safety backup first.
 * ------------------------------------------------------------------
 */

import type { system } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { reportFailure } from '../ops/common';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';

type Status = system.StartupStatus;
export const STARTUP_KEY = ['startup'] as const;
/** Where an older NVX Ancile's user gets the newer version back. */
const DOWNLOAD = 'https://github.com/Envxsion/nvx_ancile/releases';

const size = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;

/** Core is up again after a restart: load the app afresh. */
async function waitForCore(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const s = await api.get<Status>('/system/startup');
      if (s.state === 'running') {
        window.location.assign('/');
        return;
      }
    } catch {
      // Core is restarting.
    }
  }
}

export function StartupGate({ children }: { children: ReactNode }) {
  const q = useQuery({
    queryKey: STARTUP_KEY,
    queryFn: () => api.get<Status>('/system/startup'),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  if (q.data?.state === 'stopped') return <StartupScreen status={q.data} />;
  return <>{children}</>;
}

export function StartupScreen({ status }: { status: Status }) {
  const [chosen, setChosen] = useState<string | null>(status.suggested);
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const after = (r: { restarting: boolean }, done: string) => {
    if (r.restarting) {
      setRestarting(done);
      void waitForCore();
    } else setRestarting(`${done} Restart NVX Ancile to carry on.`);
  };
  const restore = useMutation({
    mutationFn: (backup: string) =>
      api.post<{ restarting: boolean }>('/system/startup/restore', {
        backup,
      } satisfies system.RestoreRequest),
    onSuccess: (r) => after(r, 'The backup was restored. NVX Ancile is starting again.'),
    onError: (e) => reportFailure(e, 'Restoring the backup'),
  });
  const retry = useMutation({
    mutationFn: () => api.post<{ restarting: boolean }>('/system/startup/retry', {}),
    onSuccess: (r) => after(r, 'Trying again.'),
    onError: (e) => reportFailure(e, 'Trying again'),
  });
  const skip = useMutation({
    mutationFn: () => api.post<{ restarting: boolean }>('/system/startup/continue-without-backup', {}),
    onSuccess: (r) => after(r, 'Updating without a backup.'),
    onError: (e) => reportFailure(e, 'Continuing'),
  });
  const busy = restore.isPending || retry.isPending || skip.isPending || !!restarting;
  const can = (a: system.StartupAction) => status.actions.includes(a);
  const error = status.error;
  const pick = status.backups.find((b) => b.name === chosen) ?? null;

  return (
    <main className="startup" aria-labelledby="startup-title">
      <section className="startup__card m-glass">
        <span className="startup__icon" aria-hidden="true">
          <Icon name={error?.code === 'system.disk_full' ? 'archive' : 'shield'} size={22} />
        </span>
        <h1 id="startup-title" className="startup__title">
          NVX Ancile stopped before opening your data
        </h1>
        <p className="mute startup__lede">Nothing was changed. This is NVX Ancile {status.version}.</p>

        {error ? <ErrorState error={{ error }} compact /> : null}

        {restarting ? (
          <p className="startup__status" role="status">
            <Icon name="clock" size={14} /> {restarting}
          </p>
        ) : null}

        {can('restore') && status.backups.length ? (
          <fieldset className="startup__backups" disabled={busy}>
            <legend>Backups on this computer</legend>
            <ul>
              {status.backups.map((b) => (
                <li key={b.name}>
                  <label data-chosen={b.name === chosen || undefined}>
                    <input
                      type="radio"
                      name="backup"
                      value={b.name}
                      checked={b.name === chosen}
                      onChange={() => {
                        setChosen(b.name);
                        setConfirming(false);
                      }}
                    />
                    <span className="startup__backup-name">
                      {new Date(b.created_at).toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'long',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {b.name === status.suggested ? <em> Before the update</em> : null}
                    </span>
                    <span className="mute">
                      {b.app_version ? `NVX Ancile ${b.app_version} · ` : ''}
                      {size(b.bytes)} · {relative(b.created_at)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mute startup__folder">
              In <code>{status.folder}</code>
            </p>
          </fieldset>
        ) : null}

        <div className="startup__actions">
          {can('restore') && pick ? (
            confirming ? (
              <>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  data-busy={restore.isPending || undefined}
                  onClick={() => restore.mutate(pick.name)}
                >
                  Replace my data with this backup
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => setConfirming(false)}>
                  Keep it as it is
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Restore this backup
              </button>
            )
          ) : null}
          {can('retry') ? (
            <button
              type="button"
              className={can('restore') ? 'btn btn--ghost' : 'btn btn--primary'}
              disabled={busy}
              data-busy={retry.isPending || undefined}
              onClick={() => retry.mutate()}
            >
              <Icon name="regenerate" size={14} /> Try again
            </button>
          ) : null}
          {can('continue_without_backup') ? (
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              data-busy={skip.isPending || undefined}
              onClick={() => skip.mutate()}
            >
              Update without a backup
            </button>
          ) : null}
          {can('reinstall') ? (
            <a className="btn btn--ghost" href={DOWNLOAD} target="_blank" rel="noreferrer">
              <Icon name="download" size={14} /> Get the newer NVX Ancile
            </a>
          ) : null}
        </div>
        {confirming && pick ? (
          <p className="mute startup__note">
            Your data goes back to how it was on{' '}
            {new Date(pick.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'long' })}. What is
            there now is kept as a backup first, so this can be undone.
          </p>
        ) : null}
        {can('reinstall') ? (
          <p className="mute startup__note">
            Or reinstall the newer version from the tray menu. Everything opens as you left it.
          </p>
        ) : null}
      </section>
    </main>
  );
}
