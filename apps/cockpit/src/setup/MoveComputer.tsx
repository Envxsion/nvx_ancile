/**
 * ------------------------------------------------------------------
 *  Title    |  First run: moving from another computer
 *  Ref      |  ROADMAP SU1 · docs/runbooks/restore-backup.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Say how to bring a whole NVX Ancile over from another
 *           |  computer, and show the backups already in this one's
 *           |  backups folder, ready to restore.
 *  How      |  GET /system/backups lists what is in the folder (a
 *           |  backup copied over from the old computer shows up
 *           |  here). Restoring replaces the database, so it is done
 *           |  from the start-up screen or with the command shown,
 *           |  never from a running window.
 *  Note     |  TODO(phase-0.1.1): restore from this step without
 *           |  leaving it (a restart that applies the chosen backup).
 *           |  TODO(phase-0.1.1): Pro "Join my synced computers"
 *           |  (pairing code) and a team invite code field, at this
 *           |  step, from the Pro slot.
 * ------------------------------------------------------------------
 */

import type { system } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Kbd } from '../ui/primitives';

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
          Restore it from the start-up screen NVX Ancile shows, or run <code>pnpm db:restore</code> followed
          by the backup&apos;s name, then start again.
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
        </>
      ) : (
        <p className="mute">No backups are in this computer&apos;s folder yet.</p>
      )}
      <p className="mute">
        Restoring replaces what is here, so it is safest on a fresh install like this one. You can{' '}
        <Kbd keys="mod+k" /> find &ldquo;Run setup again&rdquo; later.
      </p>
    </div>
  );
}
