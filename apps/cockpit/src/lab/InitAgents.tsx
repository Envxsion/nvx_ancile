/**
 * ------------------------------------------------------------------
 *  Title    |  Settings, Coding lab: write an AGENTS.md
 *  Ref      |  ROADMAP LB2 · docs/notebooks.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The lab's /init: draft a starter AGENTS.md for a
 *           |  repository, show it, and write it only when you say so.
 *  How      |  POST /lab/init drafts (writes nothing). The button that
 *           |  saves is the editor's ordinary save (PUT /files), so the
 *           |  permission gate and path checks apply. If an AGENTS.md
 *           |  already exists, the diff is shown and nothing is offered
 *           |  to overwrite it.
 * ------------------------------------------------------------------
 */

import type { FileWriteResult, LabInitDraft, RepoInfo } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';

const KEYWORDS = 'agents.md claude.md init project instructions repository';

export const problemText = (e: unknown) =>
  e instanceof ApiCallError
    ? `${e.body.error.title}. ${e.body.error.hint}`
    : 'NVX Ancile did not answer. Check that it is running, then try again.';

export function InitAgents() {
  const q = useContext(SearchContext);
  const [repoId, setRepoId] = useState('');
  const repos = useQuery({
    queryKey: ['repos'],
    queryFn: () => api.get<{ items: RepoInfo[] }>('/repos').then((r) => r.items),
  });
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
  if (!matches(q, 'write an agents.md', KEYWORDS)) return null;
  const items = repos.data ?? [];
  const d = draft.data;
  const error = draft.error ?? save.error;
  return (
    <Block
      title="Project instructions"
      lede="The lab reads AGENTS.md or CLAUDE.md from a repository you registered. Draft one from what the repository shows."
    >
      <div className="setting" data-stack>
        <div className="setting__words">
          <p className="setting__desc">
            You see the draft first. Nothing is written until you choose Write AGENTS.md, and a file that is
            already there is never replaced.
          </p>
        </div>
        <div className="setting__control">
          <select
            aria-label="Repository"
            value={repoId}
            onChange={(e) => {
              setRepoId(e.target.value);
              draft.reset();
              save.reset();
            }}
          >
            <option value="">Choose a repository</option>
            {items.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!repoId || draft.isPending}
            onClick={() => draft.mutate(repoId)}
          >
            Draft AGENTS.md
          </button>
        </div>
      </div>
      {error ? (
        <p className="setting__desc" role="alert">
          {problemText(error)}
        </p>
      ) : null}
      {d ? (
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
      ) : null}
    </Block>
  );
}
