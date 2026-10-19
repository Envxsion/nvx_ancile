/**
 * ------------------------------------------------------------------
 *  Title    |  Drafting an AGENTS.md: the shared part
 *  Ref      |  ROADMAP LB2, CH5 · docs/notebooks.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The draft, its words and the one write, used by
 *           |  Settings → Coding lab (lab/InitAgents.tsx) and by the
 *           |  composer's /init (lab/InitDialog.tsx).
 *  How      |  POST /lab/init drafts and writes nothing. Saving is the
 *           |  ordinary file save (PUT /files), so the permission gate
 *           |  and path checks apply, and a file that already exists
 *           |  is shown as a diff and never replaced.
 * ------------------------------------------------------------------
 */

import type { FileWriteResult, LabInitDraft } from '@nvx/contracts';
import { useMutation } from '@tanstack/react-query';
import { ApiCallError, api } from '../lib/api';
import { notify } from '../state/notify';

export const problemText = (e: unknown) =>
  e instanceof ApiCallError
    ? `${e.body.error.title}. ${e.body.error.hint}`
    : 'NVX Ancile did not answer. Check that it is running, then try again.';

/** The draft and the write, shared by Settings → Coding lab and the composer's /init. */
export function useInitDraft() {
  const draft = useMutation({
    mutationFn: (id: string) => api.post<LabInitDraft>('/lab/init', { repo_id: id }),
  });
  const save = useMutation({
    mutationFn: (d: LabInitDraft) =>
      api.put<FileWriteResult>('/files', {
        path: d.path,
        content: d.content,
        base_sha256: null,
        confirmed: true,
      }),
    onSuccess: () => notify({ level: 'success', title: 'AGENTS.md written' }),
  });
  return { draft, save };
}

/** What a draft says, and the one button that writes it (never over a file that exists). */
export function DraftView({ d, save }: { d: LabInitDraft; save: ReturnType<typeof useInitDraft>['save'] }) {
  return (
    <div className="setting" data-stack>
      <div className="setting__words">
        {d.exists ? (
          <p className="setting__desc">
            This repository already has an AGENTS.md, so nothing will be written. Here is how the draft
            differs from it.
          </p>
        ) : (
          <p className="setting__desc">
            This would be saved as <code>{d.path}</code>.
          </p>
        )}
        <pre className="rcheck__facts">{d.exists ? d.diff : d.content}</pre>
        {!d.exists ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={save.isPending || save.isSuccess}
            onClick={() => save.mutate(d)}
          >
            Write AGENTS.md
          </button>
        ) : null}
      </div>
    </div>
  );
}
