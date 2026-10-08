/**
 * ------------------------------------------------------------------
 *  Title    |  Memory history
 *  Ref      |  DESIGN.md §6.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When did it learn this, who changed it, and what did it
 *           |  believe before? Every change to memory is a commit; this
 *           |  is the readable timeline of them, with Undo on each.
 *  How      |  A list of commits (one file, or all of memory). Opening
 *           |  one shows its diff. Undo is a revert commit, asked for
 *           |  twice: the first press arms it, the second does it.
 * ------------------------------------------------------------------
 */

import type { MemoryCommit } from '@nvx/contracts';
import { useEffect, useState } from 'react';
import { relative } from '../lib/format';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';
import { useMemoryDiff, useMemoryHistory, useRevert } from './api';
import { DiffView } from './DiffView';
import { parsePatch } from './linediff';

/** "memory(user): prefer British spelling" → scope and summary. */
function split(summary: string): { scope: string | null; text: string } {
  const m = /^memory\(([^)]+)\):\s*(.*)$/.exec(summary);
  if (!m) return { scope: null, text: summary };
  const scope = m[1] as string;
  const label =
    scope === 'user'
      ? 'About you'
      : scope === 'agents'
        ? 'House rules'
        : scope === 'failures'
          ? 'Lessons'
          : scope.startsWith('project:')
            ? scope.slice(8)
            : scope.startsWith('model:')
              ? scope.slice(6).replace(/__/g, '/')
              : scope;
  const text = m[2] ?? '';
  return { scope: label, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

function Commit({ c, path, first }: { c: MemoryCommit; path: string | null; first: boolean }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const diff = useMemoryDiff(open ? c.sha : null, null, path);
  const revert = useRevert();
  const { scope, text } = split(c.summary);
  const reverted = /^Revert /.test(c.summary);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <li className="mem-commit" data-auto={c.automatic || undefined} data-open={open || undefined}>
      <span className="mem-commit__rail" aria-hidden="true">
        <span className="mem-commit__node">
          <Icon name={c.automatic ? 'seal' : reverted ? 'undo' : 'user'} size={11} />
        </span>
      </span>
      <div className="mem-commit__body">
        <button
          type="button"
          className="mem-commit__head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="mem-commit__text">{text}</span>
          {scope ? <span className="mem-commit__scope">{scope}</span> : null}
          <span className="mem-commit__who mute">
            {c.automatic ? 'NVX Ancile' : c.author} · <time dateTime={c.at}>{relative(c.at)}</time>
          </span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="mem-commit__chev" />
        </button>
        {open ? (
          <div className="mem-commit__detail">
            {c.body ? (
              <p className="mem-commit__why mute">{c.body.replace(/\n?Ancile-Proposal: \S+/, '').trim()}</p>
            ) : null}
            {diff.isPending ? <Skeleton lines={3} label="Loading the change" /> : null}
            {diff.data ? (
              <DiffView rows={parsePatch(diff.data.patch)} label={`What ${text} changed`} />
            ) : null}
            {!first || !c.summary.startsWith('memory: start') ? (
              <div className="mem-commit__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  data-armed={armed || undefined}
                  data-busy={revert.isPending || undefined}
                  disabled={revert.isPending}
                  onClick={() => {
                    if (!armed) return setArmed(true);
                    setArmed(false);
                    revert.mutate(c.sha);
                  }}
                >
                  <Icon name="undo" size={13} />
                  {armed ? 'Press again to undo' : 'Undo this change'}
                </button>
                <span className="mute" data-num>
                  {c.sha.slice(0, 8)}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function Timeline({ path }: { path: string | null }) {
  const history = useMemoryHistory(path);
  if (history.isPending) return <Skeleton lines={5} label="Loading history" />;
  const items = history.data ?? [];
  if (!items.length)
    return (
      <EmptyState icon="clock" title="No history yet" body="Every change to memory will be listed here." />
    );
  return (
    <ol className="mem-timeline">
      {items.map((c, i) => (
        <Commit key={c.sha} c={c} path={path} first={i === items.length - 1} />
      ))}
    </ol>
  );
}

export function FileHistory({ path }: { path: string }) {
  return <Timeline path={path} />;
}
