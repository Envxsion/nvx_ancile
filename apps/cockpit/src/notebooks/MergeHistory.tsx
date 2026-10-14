/**
 * ------------------------------------------------------------------
 *  Title    |  Merge history on a notebook
 *  Ref      |  docs/notebooks.md (Merging notebooks)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Say which notebooks were merged into this one, when and
 *           |  what came with them, with Undo while it is still open.
 *  How      |  Hidden when there is no history (and in demo data),
 *           |  and so while it loads: most notebooks have none, so a
 *           |  placeholder would flash on every page. A read that
 *           |  failed says so with Try again, since Undo may be in it.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { relative } from '../lib/format';
import { Icon } from '../ui/Icon';
import { LoadFailed } from '../ui/LoadFailed';
import { undoMerge, useMergeHistory } from './api';
import '../styles/notebooks.css';

export function MergeHistory({ notebookId }: { notebookId: string }) {
  const history = useMergeHistory(notebookId);
  const [busy, setBusy] = useState<string | null>(null);
  if (history.isError && !history.data)
    return (
      <section className="page__section" aria-labelledby="nbm-history-h">
        <div className="page__section-head">
          <h2 id="nbm-history-h">Merge history</h2>
        </div>
        <LoadFailed compact error={history.error} what="Merge history" onRetry={() => history.refetch()} />
      </section>
    );
  const items = (history.data ?? []).filter((m) => m.into_id === notebookId);
  if (!items.length) return null;
  return (
    <section className="page__section" aria-labelledby="nbm-history-h">
      <div className="page__section-head">
        <h2 id="nbm-history-h">Merged here</h2>
      </div>
      <ul className="nbm-history">
        {items.map((m) => (
          <li key={m.id}>
            <Icon name="merge" size={13} />
            <span className="nbm-history__what" dir="auto">
              {m.from_title}
              <span className="mute">
                {' '}
                · {m.counts.threads} threads, {m.counts.sources_moved + m.counts.sources_deduplicated}{' '}
                sources, {m.counts.notes} notes · {relative(m.merged_at)}
                {m.undone_at ? ' · undone' : ''}
                {m.scope_narrowed.length ? ' · scope narrowed' : ''}
              </span>
            </span>
            {m.can_undo ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                data-busy={busy === m.id || undefined}
                onClick={async () => {
                  setBusy(m.id);
                  await undoMerge(m);
                  setBusy(null);
                }}
              >
                <Icon name="undo" size={13} />
                Undo merge
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
