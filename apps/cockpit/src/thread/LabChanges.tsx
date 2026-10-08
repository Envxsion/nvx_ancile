/**
 * ------------------------------------------------------------------
 *  Title    |  What the lab changed
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Under a lab answer: every file it added, changed or
 *           |  deleted, with the diff one click away, and Undo, which
 *           |  puts the lab folder back as it was before the run.
 *  How      |  GET /runs/:id/diff compares the folder with Core's copy
 *           |  taken before the run; POST /runs/:id/undo restores it.
 *           |  Diff lines are coloured by their first character only:
 *           |  plain, readable, no syntax engine needed.
 *  Note     |  TODO(phase-3): side-by-side review with @pierre/diffs
 *           |  and a terminal view (xterm.js) for long shell output.
 * ------------------------------------------------------------------
 */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { type LabChange, labChanges, undoLab } from '../lib/turns';
import { Icon } from '../ui/Icon';

function Patch({ patch }: { patch: string }) {
  const lines = patch
    .split('\n')
    .filter(
      (l) => !l.startsWith('===') && !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('\\'),
    )
    // A patch's lines never reorder, so their position is a stable identity.
    .map((text, line) => ({ text, line }));
  return (
    <pre className="lab-diff" data-num>
      {lines.map(({ text: l, line }) => (
        <span
          key={line}
          data-line={
            l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'
          }
        >
          {l || ' '}
        </span>
      ))}
    </pre>
  );
}

const STATUS_WORD: Record<NonNullable<LabChange['status']>, string> = {
  added: 'Added',
  modified: 'Changed',
  deleted: 'Deleted',
};

export function LabChanges({
  runId,
  undone,
  threadId,
}: {
  runId: string;
  undone: boolean;
  threadId: string;
}) {
  const changes = useQuery({
    queryKey: ['lab-changes', runId],
    queryFn: () => labChanges(runId),
    staleTime: 10_000,
  });
  const [busy, setBusy] = useState(false);
  const items = changes.data?.items ?? [];
  if (changes.isPending || (items.length === 0 && !undone)) return null;

  const undo = async () => {
    setBusy(true);
    if (await undoLab(runId)) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['lab-changes', runId] }),
        queryClient.invalidateQueries({ queryKey: keys.thread(threadId) }),
      ]);
    }
    setBusy(false);
  };

  return (
    <section className="lab-changes" aria-label="Files the lab changed">
      <header className="lab-changes__head">
        <Icon name="node" size={13} />
        <span>
          {undone ? 'Undone. ' : ''}
          {items.length === 0
            ? 'No files differ from before this run'
            : `${items.length} ${items.length === 1 ? 'file' : 'files'} changed`}
        </span>
        {changes.data?.undo && items.length > 0 ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void undo()}
            disabled={busy}
          >
            {busy ? 'Undoing' : 'Undo these changes'}
          </button>
        ) : null}
      </header>
      <ul className="lab-changes__list">
        {items.map((f) => (
          <li key={f.file}>
            <details>
              <summary>
                <span className="lab-changes__status" data-status={f.status}>
                  {STATUS_WORD[f.status ?? 'modified']}
                </span>
                <span className="lab-changes__file" data-num>
                  {f.file}
                </span>
                <span className="mute" data-num>
                  +{f.additions} −{f.deletions}
                </span>
              </summary>
              {f.patch ? <Patch patch={f.patch} /> : null}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
