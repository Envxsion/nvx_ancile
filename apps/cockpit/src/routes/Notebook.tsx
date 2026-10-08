/**
 * ------------------------------------------------------------------
 *  Title    |  Notebook
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A notebook's front page: ask it something, see what it
 *           |  knows (its sources, and how far each one has been
 *           |  read), the threads asked in it, and the notes kept.
 *  How      |  The ask box starts a thread in this notebook and opens
 *           |  it with the answer streaming. Files dropped anywhere on
 *           |  the page join the upload queue. The title edits in
 *           |  place; Enter keeps it, Esc puts it back.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type CSSProperties, type DragEvent, useMemo, useState } from 'react';
import { UploadQueue } from '../drawer/SourcesPanel';
import { useLayer } from '../keys/dispatch';
import { api } from '../lib/api';
import { useNotebooks, useNotes, useSources, useThreads } from '../lib/data';
import { hueVar, relative } from '../lib/format';
import { useCurrentModel } from '../lib/models';
import { deleteNotebook, patchNotebook } from '../lib/notebooks';
import { createThread, sendMessage } from '../lib/turns';
import type { Hue } from '../lib/types';
import { NOTEBOOK_HUES } from '../shell/NewNotebook';
import { AddSources } from '../sources/AddSources';
import { SourceCard } from '../sources/SourceCard';
import { useUploads } from '../sources/uploads';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Composer, type SendExtras } from '../thread/Composer';
import { useFlowList } from '../thread/flowActions';
import { Ticker } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { EmptyState, Skeleton } from '../ui/primitives';

const SOURCES_SHOWN = 9;

/** A note's first words as reading text: no list markers, headings or emphasis. */
function notePreview(md: string): string {
  return md
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, '').trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/[*_`]|\[(.*?)\]\([^)]*\)/g, (_m, link) => link ?? '')
    .slice(0, 180);
}

export function NotebookScreen() {
  const { notebookId } = useParams({ strict: false }) as { notebookId?: string };
  const notebooks = useNotebooks();
  const threads = useThreads();
  const sources = useSources(notebookId);
  const notes = useNotes(notebookId);
  const openPalette = useUi((s) => s.openPalette);
  const openDrawer = useUi((s) => s.openDrawer);
  const demo = useUi((s) => s.demo);
  const addUploads = useUploads((s) => s.add);
  const model = useCurrentModel();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nb = notebooks.data?.find((n) => n.id === notebookId);

  const own = useMemo(
    () => (threads.data ?? []).filter((t) => t.notebookId === notebookId),
    [threads.data, notebookId],
  );
  const items = sources.data ?? [];
  const ready = items.filter((s) => s.status === 'ready').length;
  const reading = items.filter((s) => !['ready', 'failed', 'stale'].includes(s.status)).length;

  if (notebooks.isPending)
    return (
      <div className="page">
        <div className="page__measure">
          <Skeleton lines={8} label="Loading notebook" />
        </div>
      </div>
    );
  if (!nb || !notebookId)
    return (
      <div className="page page--center">
        <EmptyState
          icon="notebook"
          title="This notebook isn't here"
          body="It may have been deleted, or the link is from another workspace."
          action={{
            label: 'Find a notebook',
            onClick: () => openPalette('notebooks'),
            binding: 'palette.open',
          }}
        />
      </div>
    );

  const ask = async (text: string, extras: SendExtras): Promise<boolean> => {
    if (demo) {
      notify({
        level: 'info',
        title: 'Not sent: Core is not running',
        body: 'Start NVX Ancile with pnpm start. Your draft is kept.',
      });
      return false;
    }
    const threadId = await createThread(model?.id ?? null, nb.id);
    if (!threadId) return false;
    const ok = await sendMessage({
      threadId,
      parentId: null,
      text,
      model: extras.model ?? null,
      defaultModel: model?.id ?? null,
      mentions: extras.mentions,
      flowId: extras.flowId ?? null,
    });
    if (!ok) {
      void api.del(`/threads/${threadId}`).catch(() => undefined);
      return false;
    }
    await navigate({ to: '/t/$threadId', params: { threadId } });
    return true;
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setOver(false);
    addUploads(nb.id, Array.from(e.dataTransfer.files));
  };

  const more: MenuEntry[] = [
    { label: 'Rename', icon: 'edit', onSelect: () => setEditing(true) },
    {
      kind: 'sub',
      label: 'Colour',
      icon: 'paint',
      items: NOTEBOOK_HUES.map((h) => ({
        label: h[0]?.toUpperCase() + h.slice(1),
        onSelect: () => void patchNotebook(nb.id, { color: h }),
      })),
    },
    {
      label: nb.pinned ? 'Unpin' : 'Pin to the top',
      icon: 'pin',
      onSelect: () => void patchNotebook(nb.id, { pinned: !nb.pinned }),
    },
    { kind: 'separator' },
    {
      label: 'Delete notebook',
      icon: 'trash',
      danger: true,
      // Says what happens to the threads, sources, notes and flows first.
      onSelect: () => setDeleting(true),
    },
  ];

  const shown = allSources ? items : items.slice(0, SOURCES_SHOWN);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole page accepts dropped files; the controls inside are the interactive parts
    <div
      className="page nbk"
      data-scrollable
      data-over={over || undefined}
      style={nb.color ? ({ '--hue': hueVar(nb.color as Hue) } as CSSProperties) : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="page__measure nbk__measure">
        <header className="nbk__head">
          <span className="nbk__swatch" aria-hidden="true" />
          <div className="nbk__titles">
            {editing ? (
              <TitleEdit
                value={nb.title}
                onDone={(t) => {
                  setEditing(false);
                  if (t && t !== nb.title) void patchNotebook(nb.id, { title: t });
                }}
              />
            ) : (
              <h1 className="page__title nbk__title" data-display dir="auto">
                <button
                  type="button"
                  className="nbk__title-btn"
                  onClick={() => setEditing(true)}
                  title="Rename"
                >
                  {nb.title}
                </button>
              </h1>
            )}
            {nb.description ? (
              <p className="nbk__desc" dir="auto">
                {nb.description}
              </p>
            ) : null}
            <dl className="nbk__stats">
              <div>
                <dt>Sources</dt>
                <dd>
                  <Ticker value={items.length || nb.sources} />
                </dd>
              </div>
              <div>
                <dt>Threads</dt>
                <dd>
                  <Ticker value={own.length || nb.threads} />
                </dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd>
                  <Ticker value={notes.data?.length ?? nb.notes ?? 0} />
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{relative(nb.updatedAt)}</dd>
              </div>
            </dl>
          </div>
          <div className="nbk__actions">
            <Link
              to="/n/$notebookId/flow"
              params={{ notebookId: nb.id }}
              className="btn btn--ghost btn--sm"
              title="How this notebook's messages are answered"
              data-tour="notebook-flow"
            >
              <Icon name="branch" size={14} />
              Flow
            </Link>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              Add sources
            </button>
            <DropMenu
              items={more}
              trigger={
                <button type="button" className="icon-btn" aria-label="More for this notebook">
                  <Icon name="more" size={16} />
                </button>
              }
            />
          </div>
        </header>

        <section className="nbk__ask" data-tour="notebook-ask" aria-label="Ask this notebook">
          <Composer
            threadId={`nb-${nb.id}`}
            parentId={null}
            onSend={ask}
            notebookId={nb.id}
            placeholder={
              ready
                ? `Ask across ${ready === 1 ? 'one source' : `${ready} sources`}. @ to focus on one`
                : 'Ask anything. Add sources and answers will cite them'
            }
          />
          {reading ? (
            <p className="nbk__reading mute" aria-live="polite">
              <span className="nbk__pulse" aria-hidden="true" />
              Reading <span data-num>{reading}</span> {reading === 1 ? 'source' : 'sources'}. Answers use each
              one as soon as it is ready.
            </p>
          ) : null}
        </section>

        <section className="page__section">
          <div className="page__section-head">
            <h2>Sources</h2>
            {items.length > 0 ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => openDrawer('sources')}>
                <Icon name="panelRight" size={14} />
                Open in panel
              </button>
            ) : null}
          </div>
          <UploadQueue notebookId={nb.id} />
          {sources.isPending ? (
            <Skeleton lines={4} label="Loading sources" />
          ) : items.length === 0 ? (
            <button type="button" className="nbk__dropzone" onClick={() => setAdding(true)}>
              <Icon name="upload" size={22} />
              <span className="nbk__dropzone-title">Drop files anywhere on this page</span>
              <span className="mute">
                PDFs, documents, slides, spreadsheets and code. Or add a link, pasted text, or a past thread.
              </span>
            </button>
          ) : (
            <>
              <div className="nbk__sources">
                {shown.map((s) => (
                  <SourceCard key={s.id} s={s} notebookId={nb.id} />
                ))}
              </div>
              {items.length > SOURCES_SHOWN ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm nbk__more"
                  onClick={() => setAllSources((v) => !v)}
                >
                  {allSources ? 'Show fewer' : `Show all ${items.length}`}
                </button>
              ) : null}
            </>
          )}
        </section>

        <div className="nbk__cols">
          <section className="page__section">
            <div className="page__section-head">
              <h2>Threads</h2>
              <Link to="/" search={{ notebook: nb.id }} className="btn btn--ghost btn--sm">
                <Icon name="plus" size={14} />
                New thread here
              </Link>
            </div>
            {own.length === 0 ? (
              <p className="mute nbk__empty">No threads yet. Ask something above and it starts one here.</p>
            ) : (
              <ul className="rows">
                {own.slice(0, 12).map((t) => (
                  <li key={t.id}>
                    <Link to="/t/$threadId" params={{ threadId: t.id }} className="row row--link">
                      <Icon name={t.pinned ? 'pin' : 'thread'} size={14} />
                      <span className="row__title" dir="auto">
                        {t.title}
                      </span>
                      {t.live ? <span className="recent__live">Waiting on you</span> : null}
                      <span className="row__meta mute">{relative(t.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="page__section">
            <div className="page__section-head">
              <h2>Notes</h2>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => openDrawer('notes')}>
                <Icon name="note" size={14} />
                Open notes
              </button>
            </div>
            {(notes.data ?? []).length === 0 ? (
              <p className="mute nbk__empty">
                Keep what matters: save an answer as a note from its menu, or write one in the notes panel.
              </p>
            ) : (
              <ul className="nbk__notes">
                {(notes.data ?? []).slice(0, 6).map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="note-card"
                      data-kind={n.kind}
                      onClick={() => useUi.getState().openNote(n.id)}
                    >
                      <span className="note-card__title" dir="auto">
                        {n.pinned ? <Icon name="pin" size={12} /> : null}
                        {n.title || 'Untitled note'}
                      </span>
                      <span className="note-card__body mute" dir="auto">
                        {notePreview(n.content_md)}
                      </span>
                      <span className="note-card__meta mute">
                        {n.kind === 'ai' ? 'From an answer · ' : ''}
                        {relative(n.updated_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {over ? (
        <div className="nbk__drop" aria-hidden="true">
          <Icon name="upload" size={26} />
          <span>Drop to add to {nb.title}</span>
        </div>
      ) : null}

      <AddSources notebookId={nb.id} open={adding} onOpenChange={setAdding} />
      <DeleteNotebookDialog
        open={deleting}
        onOpenChange={setDeleting}
        notebook={{
          id: nb.id,
          title: nb.title,
          threads: own.length,
          sources: items.length,
          notes: nb.notes ?? 0,
        }}
        onDeleted={() => void navigate({ to: '/' })}
      />
    </div>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function DeleteNotebookDialog({
  open,
  onOpenChange,
  notebook,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  notebook: { id: string; title: string; threads: number; sources: number; notes: number };
  onDeleted: () => void;
}) {
  useLayer(open);
  const [busy, setBusy] = useState(false);
  const flows = (useFlowList(open).data ?? []).filter(
    (f) => f.scope === 'notebook' && f.scope_ref === notebook.id,
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="nbk-del-desc">
          <Dialog.Title className="dialog__title">Delete {notebook.title}?</Dialog.Title>
          <div id="nbk-del-desc" className="dialog__lede">
            <ul className="nbk-del__list">
              <li>
                {notebook.threads
                  ? `${count(notebook.threads, 'thread stays', 'threads stay')} in your sidebar, outside any notebook.`
                  : 'It has no threads.'}
              </li>
              <li>
                {notebook.sources
                  ? `${count(notebook.sources, 'source stays', 'sources stay')} in your workspace for other notebooks.`
                  : 'It has no sources.'}
              </li>
              {notebook.notes ? (
                <li>
                  {count(notebook.notes, 'note goes', 'notes go')} with it. Save any you want to keep first.
                </li>
              ) : null}
              {flows.length ? (
                <li>
                  {flows.map((f) => f.name).join(', ')} {flows.length === 1 ? 'is' : 'are'} kept as{' '}
                  {flows.length === 1 ? 'a workspace draft' : 'workspace drafts'}, switched off.
                </li>
              ) : null}
            </ul>
          </div>
          <div className="dialog__actions">
            <Dialog.Close className="btn btn--ghost">Keep it</Dialog.Close>
            <button
              type="button"
              className="btn btn--danger"
              data-busy={busy || undefined}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                const ok = await deleteNotebook(notebook.id);
                setBusy(false);
                if (!ok) return;
                onOpenChange(false);
                notify({ level: 'info', title: `Deleted ${notebook.title}` });
                onDeleted();
              }}
            >
              <Icon name="trash" size={14} />
              Delete notebook
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TitleEdit({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <input
      className="page__title nbk__title-input"
      data-display
      // biome-ignore lint/a11y/noAutofocus: the user just asked to rename it
      autoFocus
      value={v}
      maxLength={200}
      aria-label="Notebook name"
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onDone(v.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone(null);
        }
      }}
    />
  );
}
