/**
 * ------------------------------------------------------------------
 *  Title    |  Tidy storage
 *  Ref      |  ROADMAP MT1 · docs/storage.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Admin → Diagnostics: give back the space that pile-up
 *           |  wastes. Duplicate chunks and identical old versions of
 *           |  sources go, then the database is vacuumed.
 *  How      |  "See what would change" counts and changes nothing.
 *           |  "Tidy storage" backs the database up first, and Core
 *           |  refuses while anything is running or the disk is too
 *           |  full, saying so in words. The same job can run on a
 *           |  schedule (Admin → Automations → Tidy storage).
 * ------------------------------------------------------------------
 */

import type { system } from '@nvx/contracts';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon } from '../ui/Icon';
import { reportFailure } from './common';

export function TidyStorage() {
  const run = useMutation({
    mutationFn: (dry_run: boolean) => api.post<system.TidyReport>('/system/tidy', { dry_run }),
    onError: (e) => reportFailure(e, 'Tidying storage'),
  });
  const r = run.data;

  return (
    <section className="tidy m-glass" aria-label="Tidy storage">
      <div className="tidy__head">
        <h3 className="tidy__title">
          <Icon name="grid" size={14} /> Tidy storage
        </h3>
        <div className="tidy__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={run.isPending}
            onClick={() => run.mutate(true)}
          >
            See what would change
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={run.isPending}
            data-busy={run.isPending || undefined}
            onClick={() => run.mutate(false)}
          >
            Tidy storage
          </button>
        </div>
      </div>
      <p className="mute">
        Removes duplicate chunks and identical old versions of sources, then vacuums the database. It takes a
        backup first, and waits if anything is running or the disk is nearly full. Nothing you can see or
        search changes.
      </p>
      {r ? (
        <p className="tidy__result" role="status">
          {r.summary}
        </p>
      ) : null}
    </section>
  );
}
