/**
 * ------------------------------------------------------------------
 *  Title    |  Diff view
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Show a change to a memory file the way a careful
 *           |  reader wants it: what went, what came, a little context,
 *           |  and the long unchanged stretches folded away.
 *  How      |  Rows from linediff.ts (an edit) or git's patch (a
 *           |  commit). Added lines carry the gilt edge: they are what
 *           |  will be kept. Removed lines are struck, never red-alarm.
 * ------------------------------------------------------------------
 */

import type { DiffLine } from './linediff';

type Row = DiffLine | { kind: 'file'; path: string };

export function DiffView({ rows, label }: { rows: Row[]; label: string }) {
  if (!rows.some((r) => r.kind === 'add' || r.kind === 'del'))
    return <p className="mute mem-diff__none">No changes.</p>;
  return (
    <div className="mem-diff" role="group" aria-label={label}>
      {rows.map((r, i) => {
        const key = `${r.kind}-${i}`;
        if (r.kind === 'file')
          return (
            <div key={key} className="mem-diff__file" data-num>
              {r.path}
            </div>
          );
        if (r.kind === 'fold')
          return (
            <div key={key} className="mem-diff__fold">
              {r.count ? `${r.count} unchanged ${r.count === 1 ? 'line' : 'lines'}` : ''}
            </div>
          );
        return (
          <div key={key} className="mem-diff__line" data-kind={r.kind}>
            <span className="mem-diff__no" data-num aria-hidden="true">
              {r.kind === 'add' ? '' : (r.a ?? '')}
            </span>
            <span className="mem-diff__no" data-num aria-hidden="true">
              {r.kind === 'del' ? '' : (r.b ?? '')}
            </span>
            <span className="mem-diff__sign" aria-hidden="true">
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
            </span>
            {r.kind !== 'same' ? (
              <span className="sr-only">{r.kind === 'add' ? 'Added: ' : 'Removed: '}</span>
            ) : null}
            <span className="mem-diff__text">{r.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
