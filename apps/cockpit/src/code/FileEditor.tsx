/**
 * ------------------------------------------------------------------
 *  Title    |  File editor
 *  Ref      |  docs/api.md (Files) · DESIGN.md §13
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Open a file a thread refers to (a Claude Code edit, a
 *           |  lab file, a repository file), read it highlighted, see
 *           |  what an agent changed, and, when you choose to, edit
 *           |  and save it.
 *  How      |  Read-only until "Edit". Save (or Ctrl/Cmd S) goes to
 *           |  PUT /files, which runs the permission gate on the real
 *           |  path: a save the gate would ask about comes back as a
 *           |  one-line question ("Save anyway"); a file changed on
 *           |  disk since it was opened offers Reload or Keep editing.
 *           |  The Changes tab compares before and after an agent's
 *           |  edit (before.ts). Markdown reads rendered or raw.
 *  Note     |  Closing with unsaved changes asks first.
 * ------------------------------------------------------------------
 */

import type { FileContent } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Streamdown } from 'streamdown';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, localError } from '../lib/api';
import { useMediaQuery } from '../lib/useMediaQuery';
import { REMARK_PLUGINS } from '../thread/mdPlugins';
import { Segmented } from '../ui/controls';
import { ErrorState } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { fileKey, readFile, saveFile, useFile } from './api';
import { type AgentEdit, editDiff } from './before';

/** 1,234 bytes, 12 KB, 1.4 MB. */
export function sizeLabel(n: number): string {
  if (n < 1024) return `${n.toLocaleString('en-GB')} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024).toLocaleString('en-GB')} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

import { CodeDiff, CodeView } from './CodeView';
import { isMarkdownPath } from './lang';
import type { OpenFile } from './store';

type Tab = 'file' | 'changes';
type Look = 'rendered' | 'raw';

type Banner =
  | { kind: 'confirm'; reason: string }
  | { kind: 'changed' }
  | { kind: 'failed'; title: string; hint: string }
  | { kind: 'discard' }
  | null;

export function FileEditor({ file, onClose }: { file: OpenFile; onClose: () => void }) {
  useLayer(true);
  const q = useFile(file.path, file.threadId);
  const name = q.data?.name ?? file.path.replaceAll('\\', '/').split('/').pop() ?? file.path;
  const [dirty, setDirty] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);

  const close = () => (dirty ? setAskDiscard(true) : onClose());

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content
          className="file-ed"
          aria-describedby="file-ed-where"
          onEscapeKeyDown={(e) => {
            // Esc inside CodeMirror closes its search panel first.
            if ((e.target as HTMLElement | null)?.closest?.('.cm-panels')) e.preventDefault();
          }}
        >
          <header className="file-ed__head">
            <span className="file-ed__icon" aria-hidden="true">
              <Icon name="file" size={15} />
            </span>
            <div className="file-ed__titles">
              <Dialog.Title className="file-ed__title" dir="auto">
                {name}
              </Dialog.Title>
              <p id="file-ed-where" className="file-ed__where" title={q.data?.path ?? file.path}>
                {q.data ? (
                  <>
                    <span className="file-ed__root">{q.data.root.label}</span>
                    <span className="file-ed__path" data-mono>
                      {q.data.path}
                    </span>
                  </>
                ) : (
                  <span className="file-ed__path" data-mono>
                    {file.path}
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Close the file"
              onClick={close}
            >
              <Icon name="close" size={14} />
            </button>
          </header>
          {q.isPending ? (
            <div className="file-ed__state">
              <Skeleton lines={10} label={`Opening ${name}`} />
            </div>
          ) : q.isError ? (
            <div className="file-ed__state">
              <ErrorState
                error={
                  q.error instanceof ApiCallError
                    ? q.error.body
                    : localError(
                        'files.unreachable',
                        'The file could not be read',
                        'NVX Ancile is not answering. Check it is running, then open the file again.',
                        '',
                      )
                }
                onRetry={() => void q.refetch()}
              />
            </div>
          ) : (
            <Body
              key={q.data.sha256}
              file={file}
              data={q.data}
              onDirty={setDirty}
              askDiscard={askDiscard}
              onDiscard={(yes) => {
                setAskDiscard(false);
                if (yes) onClose();
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({
  file,
  data,
  onDirty,
  askDiscard,
  onDiscard,
}: {
  file: OpenFile;
  data: FileContent;
  onDirty: (d: boolean) => void;
  askDiscard: boolean;
  onDiscard: (yes: boolean) => void;
}) {
  const qc = useQueryClient();
  const narrow = useMediaQuery('(max-width: 760px)');
  const markdown = isMarkdownPath(data.path);
  const hasEdit = Boolean(file.edit);
  const [tab, setTab] = useState<Tab>(hasEdit ? 'changes' : 'file');
  const [look, setLook] = useState<Look>(markdown ? 'rendered' : 'raw');
  const [editing, setEditing] = useState(Boolean(file.editing) && !data.binary);
  const [draft, setDraft] = useState(data.content);
  const [base, setBase] = useState(data.sha256);
  const [savedContent, setSavedContent] = useState(data.content);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const dirty = draft !== savedContent;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (askDiscard) setBanner({ kind: 'discard' });
  }, [askDiscard]);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1_600);
    return () => clearTimeout(t);
  }, [saved]);

  const diff = useMemo(
    () => (file.edit ? editDiff(data.content, file.edit as AgentEdit) : null),
    [file.edit, data.content],
  );

  const save = async (confirmed = false) => {
    if (saving || !editing) return;
    setSaving(true);
    setBanner(null);
    const r = await saveFile({
      path: data.path,
      content: draft,
      base_sha256: base,
      thread_id: file.threadId,
      confirmed,
    });
    setSaving(false);
    if (r.kind === 'saved') {
      setSaved(true);
      setBase(r.sha256);
      setSavedContent(draft);
      // The next opening reads the file again; never trust a cached copy.
      void qc.invalidateQueries({ queryKey: fileKey(file.path, file.threadId), refetchType: 'none' });
    } else if (r.kind === 'confirm') setBanner({ kind: 'confirm', reason: r.reason });
    else if (r.kind === 'changed') setBanner({ kind: 'changed' });
    else setBanner({ kind: 'failed', title: r.title, hint: r.hint });
  };

  const reload = () => {
    setBanner(null);
    void qc.invalidateQueries({ queryKey: fileKey(file.path, file.threadId) });
  };

  /** Keep the draft, and take the file on disk now as the one to replace. */
  const keepEditing = async () => {
    setBanner(null);
    try {
      setBase((await readFile(file.path, file.threadId)).sha256);
    } catch {
      setBanner({
        kind: 'failed',
        title: 'The file could not be read again',
        hint: 'Check NVX Ancile is running, then save again.',
      });
    }
  };

  const status = saving
    ? 'Saving'
    : saved
      ? 'Saved'
      : editing
        ? dirty
          ? 'Unsaved changes'
          : 'Editing'
        : data.binary
          ? 'Not text, so it is shown read-only'
          : 'Read-only';

  return (
    <>
      <div className="file-ed__bar">
        {hasEdit ? (
          <Segmented<Tab>
            label="View"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'changes', label: 'Changes', icon: 'compare' },
              { value: 'file', label: 'File', icon: 'file' },
            ]}
          />
        ) : null}
        {markdown && tab === 'file' && !editing ? (
          <Segmented<Look>
            label="Markdown"
            size="sm"
            value={look}
            onChange={setLook}
            options={[
              { value: 'rendered', label: 'Rendered', icon: 'eye' },
              { value: 'raw', label: 'Raw', icon: 'text' },
            ]}
          />
        ) : null}
        <span
          className="file-ed__status"
          role="status"
          data-state={saved ? 'saved' : dirty ? 'dirty' : undefined}
        >
          {saved ? (
            <Icon name="check" size={12} />
          ) : dirty ? (
            <span className="file-ed__dot" aria-hidden="true" />
          ) : null}
          {status}
          <span className="file-ed__size mute" data-num>
            {' · '}
            {sizeLabel(data.bytes)}
          </span>
        </span>
        <span className="file-ed__grow" />
        {data.binary ? null : (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            aria-pressed={editing}
            onClick={() => {
              setEditing((e) => !e);
              setTab('file');
              setLook('raw');
            }}
          >
            <Icon name={editing ? 'lock' : 'edit'} size={13} />
            {editing ? 'Stop editing' : 'Edit'}
          </button>
        )}
        {editing ? (
          <button
            type="button"
            className="btn btn--primary btn--sm file-ed__save"
            disabled={!dirty || saving}
            data-saved={saved || undefined}
            onClick={() => void save()}
          >
            <Icon name={saved ? 'check' : 'download'} size={13} />
            {saving ? 'Saving' : saved ? 'Saved' : 'Save file'}
          </button>
        ) : null}
      </div>

      {banner ? (
        <BannerRow
          banner={banner}
          onConfirm={() => void save(true)}
          onReload={reload}
          onKeep={() => void keepEditing()}
          onDismiss={() => setBanner(null)}
          onDiscard={onDiscard}
        />
      ) : null}

      <div className="file-ed__body" data-scrollable>
        {tab === 'changes' && diff ? (
          <>
            {diff.whole ? null : (
              <p className="file-ed__note">
                {file.edit?.written !== null
                  ? 'The agent wrote the whole file. What was there before was not recorded.'
                  : 'The file has changed since this edit, so only the edited lines are compared.'}
              </p>
            )}
            <CodeDiff
              before={diff.before}
              after={diff.after}
              language={data.path}
              unified={narrow}
              label={`Changes to ${data.name}`}
            />
          </>
        ) : data.binary ? (
          <p className="file-ed__note">
            This file is not text, so the editor cannot show it. Open it in another app.
          </p>
        ) : markdown && look === 'rendered' && !editing ? (
          savedContent.trim() ? (
            <div className="file-ed__md">
              <Streamdown className="md" mode="static" controls={false} remarkPlugins={REMARK_PLUGINS}>
                {savedContent}
              </Streamdown>
            </div>
          ) : (
            <p className="file-ed__note">This file is empty.</p>
          )
        ) : !editing && !savedContent ? (
          <p className="file-ed__note">This file is empty. Choose Edit to write in it.</p>
        ) : (
          <CodeView
            value={editing ? draft : savedContent}
            language={data.path}
            readOnly={!editing}
            label={`Contents of ${data.name}`}
            onChange={setDraft}
            onSave={() => void save()}
          />
        )}
      </div>
    </>
  );
}

function BannerRow({
  banner,
  onConfirm,
  onReload,
  onKeep,
  onDismiss,
  onDiscard,
}: {
  banner: Exclude<Banner, null>;
  onConfirm: () => void;
  onReload: () => void;
  onKeep: () => void;
  onDismiss: () => void;
  onDiscard: (yes: boolean) => void;
}) {
  const kind = banner.kind;
  return (
    <div className="file-ed__banner" role={kind === 'failed' ? 'alert' : 'status'} data-kind={kind}>
      <Icon name={kind === 'confirm' ? 'shield' : 'warn'} size={14} />
      <p className="file-ed__banner-text">
        {kind === 'confirm'
          ? `${banner.reason}.`
          : kind === 'changed'
            ? 'This file changed on disk since you opened it.'
            : kind === 'discard'
              ? 'You have unsaved changes.'
              : `${banner.title}. ${banner.hint}`}
      </p>
      <div className="file-ed__banner-acts">
        {kind === 'confirm' ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary btn--sm" onClick={onConfirm}>
              Save anyway
            </button>
          </>
        ) : kind === 'changed' ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onReload}>
              Reload
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onKeep}>
              Keep editing
            </button>
          </>
        ) : kind === 'discard' ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDiscard(false)}>
              Keep editing
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={() => onDiscard(true)}>
              Discard changes
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
