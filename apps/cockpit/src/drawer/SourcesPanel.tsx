/**
 * ------------------------------------------------------------------
 *  Title    |  Sources panel
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The sources beside the conversation: what this
 *           |  notebook knows, what is still being read, and the
 *           |  viewer when a citation is opened.
 *  How      |  The notebook comes from the route (a notebook page, or
 *           |  a thread inside one). Without a notebook the panel
 *           |  offers to put the thread into one.
 * ------------------------------------------------------------------
 */

import { useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Term } from '../help/Term';
import { useNotebooks, useSources, useThread } from '../lib/data';
import { setGrounded } from '../lib/factcheck';
import { moveThread } from '../lib/threads';
import { AddSources } from '../sources/AddSources';
import { SourceCard } from '../sources/SourceCard';
import { SourceViewer } from '../sources/SourceViewer';
import { useUploads } from '../sources/uploads';
import { useUi } from '../state/ui';
import { Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { DropMenu } from '../ui/Menu';
import { EmptyState, Skeleton } from '../ui/primitives';

/** The notebook the screen belongs to: the notebook page, or the thread's notebook. */
export function useContextNotebook(): string | null {
  const params = useParams({ strict: false }) as { notebookId?: string; threadId?: string };
  const thread = useThread(params.threadId);
  return params.notebookId ?? thread.data?.notebookId ?? null;
}

export function UploadQueue({ notebookId }: { notebookId: string }) {
  // Select the stable list, filter outside: a fresh array from a selector re-renders for ever.
  const all = useUploads((s) => s.items);
  const items = useMemo(() => all.filter((u) => u.notebookId === notebookId), [all, notebookId]);
  const cancel = useUploads((s) => s.cancel);
  if (!items.length) return null;
  return (
    <ul className="uploads" aria-label="Uploads">
      {items.map((u) => (
        <li key={u.id} className="upload" data-state={u.state}>
          <Icon name={u.state === 'failed' ? 'warn' : u.state === 'done' ? 'check' : 'upload'} size={13} />
          <span className="upload__name">{u.name}</span>
          <span className="upload__pct mute" data-num>
            {u.state === 'waiting'
              ? 'Waiting'
              : u.state === 'failed'
                ? 'Failed'
                : u.state === 'done'
                  ? 'Sent'
                  : `${Math.round(u.progress * 100)}%`}
          </span>
          {u.state === 'waiting' || u.state === 'sending' || u.state === 'failed' ? (
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              aria-label={`Cancel ${u.name}`}
              onClick={() => cancel(u.id)}
            >
              <Icon name="close" size={10} />
            </button>
          ) : null}
          <span className="upload__bar" style={{ transform: `scaleX(${u.progress})` }} aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}

function NoNotebook() {
  const params = useParams({ strict: false }) as { threadId?: string };
  const notebooks = useNotebooks();
  const list = notebooks.data ?? [];
  return (
    <EmptyState
      icon="notebook"
      title="This thread is not in a notebook"
      body="Put it in one and its questions are answered from that notebook's sources, with citations."
      secondary={
        params.threadId && list.length ? (
          <DropMenu
            align="center"
            items={list.map((n) => ({
              label: n.title,
              onSelect: () => void moveThread(params.threadId ?? '', n.id, n.title),
            }))}
            trigger={
              <button type="button" className="btn btn--primary">
                <Icon name="notebook" size={14} />
                Move into a notebook
              </button>
            }
          />
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => window.dispatchEvent(new CustomEvent('ancile:new-notebook'))}
          >
            <Icon name="plus" size={14} />
            Start a notebook
          </button>
        )
      }
    />
  );
}

/** Grounded mode, beside the sources it checks against (DESIGN.md §10.7). */
function GroundedRow({ notebookId }: { notebookId: string }) {
  const notebooks = useNotebooks();
  const on = notebooks.data?.find((n) => n.id === notebookId)?.grounded === true;
  const [busy, setBusy] = useState(false);
  return (
    <div className="grounded-row" data-on={on || undefined}>
      <Icon name="factcheck" size={14} />
      <div className="grounded-row__text">
        <span className="grounded-row__title">Fact-check every answer</span>
        <span className="mute">
          <Term id="grounded">Grounded mode</Term> checks each claim against these sources as soon as it is
          written.
        </span>
      </div>
      <Switch
        checked={on}
        disabled={busy}
        label="Fact-check every answer in this notebook"
        onChange={async (next) => {
          setBusy(true);
          await setGrounded(notebookId, next);
          setBusy(false);
        }}
      />
    </div>
  );
}

type Filter = 'all' | 'working' | 'problems';

export function SourcesPanel() {
  const notebookId = useContextNotebook();
  const sources = useSources(notebookId);
  const viewer = useUi((s) => s.viewer);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const items = sources.data ?? [];
  const shown = useMemo(
    () =>
      items.filter((s) => {
        if (
          q &&
          !s.title.toLowerCase().includes(q.toLowerCase()) &&
          !s.tags.some((t) => t.includes(q.toLowerCase()))
        )
          return false;
        if (filter === 'working') return !['ready', 'failed', 'stale'].includes(s.status);
        if (filter === 'problems') return s.status === 'failed' || s.status === 'stale' || !!s.duplicateOf;
        return true;
      }),
    [items, q, filter],
  );

  if (viewer) return <SourceViewer {...viewer} />;
  if (!notebookId) return <NoNotebook />;
  if (sources.isPending) return <Skeleton lines={6} label="Loading sources" />;

  const working = items.filter((s) => !['ready', 'failed', 'stale'].includes(s.status)).length;
  const problems = items.filter(
    (s) => s.status === 'failed' || s.status === 'stale' || !!s.duplicateOf,
  ).length;

  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="mute">
          <span data-num>{items.length}</span> {items.length === 1 ? 'source' : 'sources'}
          {working ? (
            <>
              {' · '}
              <span data-num>{working}</span> being read
            </>
          ) : null}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setAdding(true)}
          data-tour="add-sources"
        >
          <Icon name="plus" size={14} />
          Add
        </button>
      </div>
      <UploadQueue notebookId={notebookId} />
      {items.length ? <GroundedRow notebookId={notebookId} /> : null}
      {items.length === 0 ? (
        <EmptyState
          icon="upload"
          title="No sources yet"
          body="Drop files here, paste a link or text, or add a past thread. Answers will cite them."
          action={{ label: 'Add sources', onClick: () => setAdding(true) }}
        />
      ) : (
        <>
          {items.length > 5 ? (
            <div className="panel__filters">
              <label className="panel__search">
                <Icon name="search" size={12} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter sources"
                  aria-label="Filter sources"
                />
              </label>
              {(['all', 'working', 'problems'] as const).map((f) =>
                f === 'all' || (f === 'working' ? working : problems) ? (
                  <button
                    key={f}
                    type="button"
                    className="chip"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {f === 'all'
                      ? 'All'
                      : f === 'working'
                        ? `Being read ${working}`
                        : `Need attention ${problems}`}
                  </button>
                ) : null,
              )}
            </div>
          ) : null}
          <ul className="sources">
            {shown.map((s) => (
              <li key={s.id}>
                <SourceCard s={s} notebookId={notebookId} />
              </li>
            ))}
          </ul>
        </>
      )}
      <AddSources notebookId={notebookId} open={adding} onOpenChange={setAdding} />
    </div>
  );
}
