/**
 * ------------------------------------------------------------------
 *  Title    |  Notes panel
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Your own writing beside the sources: answers you kept
 *           |  (Save as note) and notes you wrote, in markdown.
 *  How      |  Edits save themselves 800 ms after you stop typing.
 *           |  A kept answer links back to the message it came from.
 * ------------------------------------------------------------------
 */

import type { Note } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { useNotes } from '../lib/data';
import { relative } from '../lib/format';
import { createNote, deleteNote, saveNote } from '../lib/notebooks';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { DropMenu } from '../ui/Menu';
import { EmptyState, Skeleton } from '../ui/primitives';
import { useContextNotebook } from './SourcesPanel';

function NoteEditor({ note, notebookId, onClose }: { note: Note; notebookId: string; onClose: () => void }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.content_md);
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState<'saved' | 'saving' | 'idle'>('idle');
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaved('saving');
    const t = setTimeout(async () => {
      const ok = await saveNote(notebookId, note.id, {
        title: title.trim() || 'Untitled note',
        content_md: body,
      });
      setSaved(ok ? 'saved' : 'idle');
    }, 800);
    return () => clearTimeout(t);
  }, [title, body, notebookId, note.id]);

  return (
    <div className="note-editor">
      <header className="note-editor__head">
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Back to notes" onClick={onClose}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <input
          className="note-editor__title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Note title"
          placeholder="Untitled note"
        />
        <span className="note-editor__state mute" aria-live="polite">
          {saved === 'saving' ? 'Saving' : saved === 'saved' ? 'Saved' : ''}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-pressed={preview}
          aria-label={preview ? 'Edit' : 'Preview'}
          onClick={() => setPreview((p) => !p)}
        >
          <Icon name={preview ? 'edit' : 'eye'} size={14} />
        </button>
      </header>
      {note.from_message_id ? (
        <p className="note-editor__from mute">
          <Icon name="quote" size={12} /> Kept from an answer
        </p>
      ) : null}
      {preview ? (
        <Streamdown className="md note-editor__preview" controls={false} mode="static">
          {body || '*Nothing written yet.*'}
        </Streamdown>
      ) : (
        <textarea
          className="note-editor__body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write in markdown. Headings, lists and links all work."
          aria-label="Note"
          // biome-ignore lint/a11y/noAutofocus: the person just opened this note to write in it
          autoFocus={!note.content_md}
        />
      )}
    </div>
  );
}

export function NotesPanel() {
  const notebookId = useContextNotebook();
  const notes = useNotes(notebookId);
  // In the store, so a note card elsewhere (the notebook page) can open one.
  const open = useUi((s) => s.noteOpen);
  const setOpen = useUi((s) => s.openNote);

  if (!notebookId)
    return (
      <EmptyState
        icon="note"
        title="Notes live in notebooks"
        body="Put this thread in a notebook to keep notes beside its sources."
      />
    );
  if (notes.isPending) return <Skeleton lines={5} label="Loading notes" />;
  const list = [...(notes.data ?? [])].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at),
  );
  const current = list.find((n) => n.id === open);
  if (current) return <NoteEditor note={current} notebookId={notebookId} onClose={() => setOpen(null)} />;

  const add = async () => {
    const n = await createNote(notebookId, 'Untitled note');
    if (n) setOpen(n.id);
  };

  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="mute">
          <span data-num>{list.length}</span> {list.length === 1 ? 'note' : 'notes'}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void add()}>
          <Icon name="plus" size={14} />
          New note
        </button>
      </div>
      {list.length === 0 ? (
        <EmptyState
          icon="note"
          title="No notes yet"
          body="Keep an answer with Save as note, or write your own."
          action={{ label: 'Write a note', onClick: () => void add() }}
        />
      ) : (
        <ul className="notes">
          {list.map((n) => (
            <li key={n.id} className="note-row" data-pinned={n.pinned || undefined}>
              <button type="button" className="note-row__main" onClick={() => setOpen(n.id)}>
                <span className="note-row__title">
                  {n.pinned ? <Icon name="pin" size={11} className="gilt-ink" /> : null}
                  {n.title}
                </span>
                <span className="note-row__preview mute">
                  {n.content_md.replace(/[#*_>`-]/g, '').slice(0, 140) || 'Empty'}
                </span>
                <span className="note-row__meta mute">
                  {n.kind === 'ai' ? 'Kept answer · ' : ''}
                  {relative(n.updated_at)}
                </span>
              </button>
              <DropMenu
                items={[
                  {
                    label: n.pinned ? 'Unpin' : 'Pin',
                    icon: 'pin',
                    onSelect: () => void saveNote(notebookId, n.id, { pinned: !n.pinned }),
                  },
                  ...(n.from_message_id
                    ? [
                        {
                          label: 'Copy',
                          icon: 'copy' as const,
                          onSelect: () => void navigator.clipboard?.writeText(n.content_md),
                        },
                      ]
                    : []),
                  { kind: 'separator' },
                  {
                    label: 'Delete',
                    icon: 'trash',
                    danger: true,
                    onSelect: () => void deleteNote(notebookId, n.id),
                  },
                ]}
                trigger={
                  <button
                    type="button"
                    className="icon-btn icon-btn--xs note-row__more"
                    aria-label={`More for ${n.title}`}
                  >
                    <Icon name="more" size={14} />
                  </button>
                }
              />
            </li>
          ))}
        </ul>
      )}
      <p className="panel__foot mute">
        Notes are yours; questions cite sources, not notes.{' '}
        <Link to="/" className="link-btn link-btn--quiet">
          Start a thread
        </Link>
      </p>
    </div>
  );
}
