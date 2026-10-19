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

import type { RepoInfo } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { api } from '../lib/api';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { DraftView, problemText, useInitDraft } from './initDraft';

const KEYWORDS = 'agents.md claude.md init project instructions repository';

export { problemText };

export function InitAgents() {
  const q = useContext(SearchContext);
  const [repoId, setRepoId] = useState('');
  const repos = useQuery({
    queryKey: ['repos'],
    queryFn: () => api.get<{ items: RepoInfo[] }>('/repos').then((r) => r.items),
  });
  const { draft, save } = useInitDraft();
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
      {d ? <DraftView d={d} save={save} /> : null}
    </Block>
  );
}
