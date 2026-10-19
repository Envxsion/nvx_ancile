/**
 * ------------------------------------------------------------------
 *  Title    |  First run: moving from another computer
 *  Ref      |  ROADMAP SU1 · docs/runbooks/restore-backup.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Bring a whole NVX Ancile over from another computer:
 *           |  restore a backup from the backups folder without
 *           |  leaving setup (free), and for Pro join the computers
 *           |  you already sync, or a team.
 *  How      |  GET /system/backups lists what is in the folder (a
 *           |  backup copied over from the old computer shows up
 *           |  here). Restoring replaces the database, so it is
 *           |  staged (setup/restore.tsx): choose, restart, and Core
 *           |  applies it before opening the database, showing
 *           |  progress, and carrying on after a restart. "Join my
 *           |  synced computers" (Pro, sync) is the pairing code of
 *           |  Settings, Sync; the team invite code (Pro, team) is a
 *           |  seam. Locked, each is a gilt card, never a broken
 *           |  control.
 *  Note     |  Every part is optional: setup has its own Continue.
 *           |  TODO(phase-0.2.0): join a team from here. Core has no
 *           |  API for this computer to join a team on another
 *           |  server (the invitation link is accepted by the team's
 *           |  server), so Pro draws no field for it yet and setup
 *           |  says so instead of faking one.
 * ------------------------------------------------------------------
 */

import type { system } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ProUpsell, useProFeature } from '../pro/slot';
import { Kbd } from '../ui/primitives';
import { StagedRestorePanel } from './restore';

export const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export function MoveComputer() {
  const q = useQuery({
    queryKey: ['system', 'backups'],
    queryFn: () => api.get<system.BackupList>('/system/backups'),
    retry: false,
  });
  const items = q.data?.items ?? [];
  return (
    <div className="move">
      <ol className="move__steps">
        <li>
          On the old computer, open NVX Ancile and take a backup now (Admin, then Health). It is a file ending
          in <code>.dump</code>.
        </li>
        <li>
          Copy it into this computer&apos;s backups folder
          {q.data?.folder ? (
            <>
              : <code>{q.data.folder}</code>
            </>
          ) : null}
          . Your notes in <code>data/memory</code> and files in <code>data/files</code> can be copied the same
          way.
        </li>
        <li>
          Choose it below to restore it here, without leaving setup. Or run <code>pnpm db:restore</code>{' '}
          followed by the backup&apos;s name, then start again.
        </li>
      </ol>
      {items.length ? (
        <>
          <p>
            <strong>Backups on this computer</strong>
          </p>
          <ul className="move__list">
            {items.map((b) => (
              <li key={b.name}>
                <span>{when(b.created_at)}</span> <code>{b.name}</code>
              </li>
            ))}
          </ul>
          <StagedRestorePanel backups={items} />
        </>
      ) : (
        <p className="mute">No backups are in this computer&apos;s folder yet.</p>
      )}
      <JoinSynced />
      <JoinTeam />
      <p className="mute">
        Restoring replaces what is here, so it is safest on a fresh install like this one. You can{' '}
        <Kbd keys="mod+k" /> find &ldquo;Run setup again&rdquo; later.
      </p>
    </div>
  );
}

/** Pro, sync: the pairing code from a computer that already syncs (the same one as Settings, Sync). */
function JoinSynced() {
  const { ui, unlocked, build, loading } = useProFeature('sync');
  if (loading) return null;
  const Part = ui?.parts?.SetupSyncJoin;
  if (unlocked && Part) return <Part />;
  return (
    <ProUpsell
      feature="sync"
      build={build}
      words={{
        title: 'Join my synced computers',
        body: 'Pair this computer with the ones you already sync, using a one-time code from one of them.',
      }}
    />
  );
}

/** Pro, team: an invite code. Locked, the card; unlocked, the Pro field when there is one. */
function JoinTeam() {
  const { ui, unlocked, build, loading } = useProFeature('team');
  if (loading) return null;
  const Part = ui?.parts?.SetupTeamInvite;
  if (unlocked && Part) return <Part />;
  if (unlocked)
    return (
      <p className="mute move__team">
        <strong>Join a team.</strong> Joining from this step is not ready yet. Open the invitation link you
        were sent instead.
      </p>
    );
  return (
    <ProUpsell
      feature="team"
      build={build}
      words={{
        title: 'Join my team',
        body: 'Use the invite code your admin sent to join their workspace.',
      }}
    />
  );
}
