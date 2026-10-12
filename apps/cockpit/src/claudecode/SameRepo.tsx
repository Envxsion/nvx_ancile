/**
 * ------------------------------------------------------------------
 *  Title    |  One repository in two folders
 *  Ref      |  docs/claude-code.md (One repository in two folders)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A notebook made for a folder that is the same repository
 *           |  as another notebook's folder (a worktree, a WSL and a
 *           |  Windows path, a link) shows one line saying so, with
 *           |  "Show together" (the sidebar keeps them side by side)
 *           |  and "Keep apart" (remembered). Where Core can merge
 *           |  notebooks (can_merge), "Merge notebooks" opens the
 *           |  merge preview with the other notebook chosen. Nothing
 *           |  is merged by itself.
 *  How      |  GET/POST /claude-code/notebooks/:id/same-repo, and
 *           |  GET /claude-code/notebook-links for the sidebar.
 * ------------------------------------------------------------------
 */

import type { NotebookLinks, SameRepoChoice, SameRepoList, SameRepoMatch } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { openEditor } from '../editors/store';
import { ApiCallError, api } from '../lib/api';
import { useNotebooks } from '../lib/data';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import '../styles/claudecode.css';

export const SAME_REPO_KEYS = {
  matches: (notebookId: string) => ['claude-code', 'same-repo', notebookId] as const,
  links: ['claude-code', 'notebook-links'] as const,
};

export function useSameRepo(notebookId: string | undefined) {
  return useQuery({
    queryKey: SAME_REPO_KEYS.matches(notebookId ?? ''),
    queryFn: () => api.get<SameRepoList>(`/claude-code/notebooks/${notebookId}/same-repo`),
    enabled: !!notebookId,
    staleTime: 5 * 60_000,
  });
}

export function useNotebookLinks(enabled = true) {
  return useQuery({
    queryKey: SAME_REPO_KEYS.links,
    queryFn: () => api.get<NotebookLinks>('/claude-code/notebook-links'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

const REASON: Record<SameRepoMatch['reason'], string> = {
  same_folder: 'the same folder',
  worktree: 'a worktree',
  same_history: 'the same history',
};

/** "Same repository as app (a worktree)". */
export const sameRepoLine = (m: Pick<SameRepoMatch, 'title' | 'reason'>) =>
  `Same repository as ${m.title} (${REASON[m.reason]})`;

/**
 * The sidebar's notebooks with each group shown together kept side by side,
 * in the order of the group's first notebook. Returns which ones follow a
 * notebook of their own repository.
 */
export function groupTogether<T extends { id: string }>(
  items: T[],
  groups: string[][],
): { items: T[]; joined: Set<string> } {
  const groupOf = new Map<string, string[]>();
  for (const g of groups) for (const id of g) groupOf.set(id, g);
  const out: T[] = [];
  const done = new Set<string>();
  const joined = new Set<string>();
  for (const n of items) {
    if (done.has(n.id)) continue;
    out.push(n);
    done.add(n.id);
    for (const id of groupOf.get(n.id) ?? []) {
      if (done.has(id)) continue;
      const other = items.find((x) => x.id === id);
      if (!other) continue;
      out.push(other);
      done.add(id);
      joined.add(id);
    }
  }
  return { items: out, joined };
}

async function choose(notebookId: string, m: SameRepoMatch, choice: SameRepoChoice['choice']) {
  try {
    const next = await api.post<SameRepoList>(`/claude-code/notebooks/${notebookId}/same-repo`, {
      other_notebook_id: m.notebook_id,
      choice,
    } satisfies SameRepoChoice);
    queryClient.setQueryData(SAME_REPO_KEYS.matches(notebookId), next);
    void queryClient.invalidateQueries({ queryKey: SAME_REPO_KEYS.matches(m.notebook_id) });
    void queryClient.invalidateQueries({ queryKey: SAME_REPO_KEYS.links });
    if (choice === 'show_together')
      notify({
        level: 'success',
        title: `Shown together with ${m.title}`,
        body: 'The sidebar keeps the two notebooks side by side. Nothing was moved or merged.',
      });
  } catch (error) {
    notify({
      level: 'error',
      title: error instanceof ApiCallError ? error.body.error.title : 'That choice was not saved',
      body:
        error instanceof ApiCallError
          ? error.body.error.hint
          : 'Check that NVX Ancile is running, then try again.',
    });
  }
}

/** The one line on a notebook whose folder is the same repository as another notebook's. */
export function SameRepoHint({ notebookId }: { notebookId: string }) {
  const q = useSameRepo(notebookId);
  const notebooks = useNotebooks();
  const [busy, setBusy] = useState(false);
  const m = q.data?.items.find((x) => !x.together);
  if (!m) return null;
  const act = async (c: SameRepoChoice['choice']) => {
    setBusy(true);
    await choose(notebookId, m, c);
    setBusy(false);
  };
  return (
    <div className="same-repo" role="status">
      <Icon name="branch" size={13} className="same-repo__icon" />
      <span className="same-repo__text" title={`${m.cwd}\n${m.other_cwd}`}>
        {sameRepoLine(m)}
      </span>
      <span className="same-repo__acts">
        {q.data?.can_merge ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() =>
              openEditor({
                kind: 'merge',
                into: {
                  id: notebookId,
                  title: notebooks.data?.find((n) => n.id === notebookId)?.title ?? 'this notebook',
                },
                from: m.notebook_id,
              })
            }
          >
            Merge notebooks
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy}
          onClick={() => void act('show_together')}
        >
          Show together
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy}
          onClick={() => void act('keep_apart')}
        >
          Keep apart
        </button>
      </span>
    </div>
  );
}
