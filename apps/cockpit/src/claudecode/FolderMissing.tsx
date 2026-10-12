/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: the session's folder went away
 *  Ref      |  docs/claude-code.md (Live sessions) · POST
 *           |  /claude-code/threads/:id/folder
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When a Claude Code thread's folder was moved, renamed or
 *           |  deleted, the notice above the composer offers the two
 *           |  ways on: "Point to new folder" (a path Core checks: it
 *           |  exists, and the notebook's scope allows it) or "Continue
 *           |  without files" (a new session with no folder access).
 *  How      |  Either choice is kept on the thread by Core; the next
 *           |  turn starts a new session given the thread so far. The
 *           |  message that was refused is sent again by itself.
 *  Note     |  Copy says what happened and what each button does.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodeFolderRequest, ClaudeCodeFolderResult } from '@nvx/contracts';
import { useId, useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { refreshLive, sendClaudeCode } from './live';
import { type CcRetry, patchCc, useCcThread } from './store';

/** Point the thread at a folder, or go on without files. Throws an ApiCallError Core refused with. */
export async function setClaudeCodeFolder(
  threadId: string,
  req: ClaudeCodeFolderRequest,
): Promise<ClaudeCodeFolderResult> {
  const r = await api.post<ClaudeCodeFolderResult>(`/claude-code/threads/${threadId}/folder`, req);
  void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
  refreshLive(threadId);
  return r;
}

export function FolderMissingNotice({
  threadId,
  cwd,
  retry,
}: {
  threadId: string;
  cwd: string | null;
  retry: CcRetry | null;
}) {
  const st = useCcThread(threadId);
  const [pointing, setPointing] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ title: string; hint: string } | null>(null);
  const pathId = useId();

  const choose = async (req: ClaudeCodeFolderRequest) => {
    setBusy(true);
    setFail(null);
    try {
      const r = await setClaudeCodeFolder(threadId, req);
      patchCc(threadId, { notice: null });
      notify({
        level: 'success',
        title: r.no_files ? 'Carrying on without files' : 'Folder updated',
        body: r.no_files
          ? 'Your next message starts a new Claude Code session that cannot see any folder.'
          : 'Your next message starts a new Claude Code session there, given this thread so far.',
      });
      if (retry)
        await sendClaudeCode({ threadId, ...retry, model: st.model, effort: st.effort, other: st.other });
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
    <div className="cc-notice cc-folder" data-kind="folder_missing" role="alert">
      <Icon name="folder" size={14} className="cc-notice__icon" />
      <div className="cc-notice__text">
        <p>
          <strong>This session's folder has moved or been deleted.</strong> Point NVX Ancile to where it is
          now, or continue without files.
          {retry ? ' Your message is kept and goes once you choose.' : ''}
        </p>
        {cwd ? (
          <p className="cc-folder__was" data-mono>
            {cwd}
          </p>
        ) : null}
        {pointing ? (
          <form
            className="cc-folder__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) void choose({ cwd: path.trim() });
            }}
          >
            <label className="field" htmlFor={pathId}>
              <span>New folder</span>
              <input
                id={pathId}
                className="input input--mono"
                value={path}
                placeholder="/home/you/projects/app"
                spellCheck={false}
                autoComplete="off"
                // biome-ignore lint/a11y/noAutofocus: the person just asked to type a path
                autoFocus
                aria-invalid={fail ? true : undefined}
                onChange={(e) => setPath(e.target.value)}
              />
              <span className="field__hint">
                The full path. It must exist on this computer and be a folder this notebook allows.
              </span>
            </label>
          </form>
        ) : null}
        {fail ? (
          <p className="field__error" role="alert">
            <strong>{fail.title}.</strong> {fail.hint}
          </p>
        ) : null}
      </div>
      <div className="cc-notice__acts">
        {pointing ? (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy || !path.trim()}
              onClick={() => void choose({ cwd: path.trim() })}
            >
              Use this folder
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPointing(false)}>
              Back
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => setPointing(true)}
            >
              Point to new folder
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => void choose({ without_files: true })}
            >
              Continue without files
            </button>
          </>
        )}
      </div>
    </div>
  );
}
