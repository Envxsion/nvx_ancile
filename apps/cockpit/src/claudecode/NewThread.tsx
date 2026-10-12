/**
 * ------------------------------------------------------------------
 *  Title    |  New Claude Code thread in a folder
 *  Ref      |  docs/claude-code.md (A new session in a folder)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Start a Claude Code session in a folder on this
 *           |  computer, from NVX Ancile: pick a folder Claude Code
 *           |  already knows, or type a full path.
 *  How      |  GET /claude-code/projects lists the known folders.
 *           |  POST /claude-code/threads {cwd, notebook_id?} answers
 *           |  the thread; the session itself starts with the first
 *           |  message (sent with parent_id null). Refusals (not a
 *           |  folder, an excluded one, the notebook's scope) show
 *           |  inline and the dialog stays open.
 * ------------------------------------------------------------------
 */

import type { CreateClaudeCodeThreadResult } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { keys, useNotebooks } from '../lib/data';
import { queryClient } from '../lib/query';
import { Icon } from '../ui/Icon';
import { folderOf, useClaudeCodeProjects } from './api';

export async function createClaudeCodeThread(
  cwd: string,
  notebookId: string | null,
): Promise<CreateClaudeCodeThreadResult> {
  const r = await api.post<CreateClaudeCodeThreadResult>('/claude-code/threads', {
    cwd,
    ...(notebookId && { notebook_id: notebookId }),
  });
  void queryClient.invalidateQueries({ queryKey: keys.threads });
  void queryClient.invalidateQueries({ queryKey: keys.notebooks });
  return r;
}

export function NewClaudeCodeThread({
  notebookId,
  cwd: initialCwd,
  onClose,
}: {
  notebookId: string | null;
  cwd: string | null;
  onClose: () => void;
}) {
  const projects = useClaudeCodeProjects().data ?? [];
  const notebooks = useNotebooks().data;
  const navigate = useNavigate();
  // From a notebook's menu, its own folders first.
  const known = [...projects].sort(
    (a, b) => Number(b.notebook_id === notebookId) - Number(a.notebook_id === notebookId),
  );
  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ title: string; hint: string } | null>(null);
  const pathId = useId();
  useLayer(true);
  const nbTitle = notebookId ? notebooks?.find((n) => n.id === notebookId)?.title : null;

  const start = async () => {
    const path = cwd.trim();
    if (!path) return;
    setBusy(true);
    setFail(null);
    try {
      const r = await createClaudeCodeThread(path, notebookId);
      onClose();
      await navigate({ to: '/t/$threadId', params: { threadId: r.thread_id } });
    } catch (error) {
      setFail(
        error instanceof ApiCallError
          ? { title: error.body.error.title, hint: error.body.error.hint }
          : { title: "This didn't reach Core", hint: 'Check that NVX Ancile is running, then try again.' },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog cc-new" aria-describedby="cc-new-lede">
          <Dialog.Title className="dialog__title">New Claude Code thread</Dialog.Title>
          <p id="cc-new-lede" className="dialog__lede">
            Claude Code works in the folder you choose. The session starts with your first message
            {nbTitle ? `, in ${nbTitle}` : ", in that folder's notebook"}.
          </p>
          {known.length ? (
            <div className="cc-new__known" role="radiogroup" aria-label="Folders Claude Code knows">
              {known.slice(0, 8).map((p) => (
                <button
                  key={p.cwd}
                  type="button"
                  role="radio"
                  aria-checked={cwd === p.cwd}
                  className="cc-new__folder"
                  onClick={() => setCwd(p.cwd)}
                  onDoubleClick={() => {
                    setCwd(p.cwd);
                    void start();
                  }}
                >
                  <Icon name="folder" size={14} />
                  <span className="cc-new__name">{folderOf(p.cwd)}</span>
                  <span className="cc-new__path" data-mono>
                    {p.cwd}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="field" htmlFor={pathId}>
            <span>{known.length ? 'Or another folder' : 'Folder'}</span>
            <input
              id={pathId}
              className="input input--mono"
              value={cwd}
              placeholder="/home/you/projects/app"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={fail ? true : undefined}
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void start();
              }}
            />
            <span className="field__hint">The full path to a folder that exists on this computer.</span>
          </label>
          {fail ? (
            <p className="field__error" role="alert">
              <strong>{fail.title}.</strong> {fail.hint}
            </p>
          ) : null}
          <div className="dialog__actions">
            <Dialog.Close className="btn btn--ghost" type="button">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !cwd.trim()}
              onClick={() => void start()}
            >
              {busy ? 'Starting' : 'Start in this folder'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
