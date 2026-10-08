/**
 * ------------------------------------------------------------------
 *  Title    |  Repository data
 *  Ref      |  DESIGN.md §17 · services/core/src/repos/routes.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the status bar, the Repo panel and the palette read
 *           |  about repositories: the list, the one this screen works
 *           |  in, its status, diffs, history, GitHub.
 *  How      |  React Query. repo.changed from the event stream
 *           |  invalidates the repository's queries, so a commit made
 *           |  in a terminal shows here within seconds.
 * ------------------------------------------------------------------
 */

import type {
  BranchInfo,
  CommitInfo,
  GitHubAccess,
  PullRequestInfo,
  RepoActionRequest,
  RepoInfo,
  RepoStatus,
  WorkflowRunInfo,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { api } from '../lib/api';
import { useThreads } from '../lib/data';
import { queryClient } from '../lib/query';
import { useUi } from '../state/ui';

export const repoKeys = {
  all: ['repos'] as const,
  linked: (threadId: string | null, notebookId: string | null) =>
    ['repos', 'linked', threadId, notebookId] as const,
  repo: (id: string) => ['repos', id] as const,
  status: (id: string) => ['repos', id, 'status'] as const,
  diff: (id: string, path: string | null, staged: boolean) => ['repos', id, 'diff', path, staged] as const,
  log: (id: string) => ['repos', id, 'log'] as const,
  branches: (id: string) => ['repos', id, 'branches'] as const,
  pulls: (id: string) => ['repos', id, 'pulls'] as const,
  runs: (id: string) => ['repos', id, 'runs'] as const,
  access: ['github', 'access'] as const,
};

/** The thread and notebook this screen is about, from the route. */
export function useRepoScope(): { threadId: string | null; notebookId: string | null } {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const threads = useThreads();
  const [, kind, id] = pathname.split('/');
  if (kind === 't' && id) {
    const t = threads.data?.find((x) => x.id === id);
    return { threadId: id, notebookId: t?.notebookId ?? null };
  }
  if (kind === 'n' && id) return { threadId: null, notebookId: id };
  return { threadId: null, notebookId: null };
}

export function useRepos() {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: repoKeys.all,
    queryFn: () => api.get<{ items: RepoInfo[] }>('/repos').then((r) => r.items),
    enabled: !demo,
    staleTime: 10_000,
  });
}

export function useLinkedRepo(scope: { threadId: string | null; notebookId: string | null }) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: repoKeys.linked(scope.threadId, scope.notebookId),
    queryFn: () => {
      const q = new URLSearchParams();
      if (scope.threadId) q.set('thread_id', scope.threadId);
      if (scope.notebookId) q.set('notebook_id', scope.notebookId);
      return api.get<{ repo: RepoInfo | null }>(`/repos/linked?${q}`).then((r) => r.repo);
    },
    enabled: !demo && !!(scope.threadId || scope.notebookId),
    staleTime: 5_000,
  });
}

export function useRepoStatus(id: string | null | undefined) {
  return useQuery({
    queryKey: repoKeys.status(id ?? ''),
    queryFn: () => api.get<RepoStatus>(`/repos/${id}/status`),
    enabled: !!id,
    staleTime: 3_000,
  });
}

export function useRepoDiff(id: string | null | undefined, path: string | null, staged: boolean) {
  return useQuery({
    queryKey: repoKeys.diff(id ?? '', path, staged),
    queryFn: () => {
      const q = new URLSearchParams({ staged: String(staged) });
      if (path) q.set('path', path);
      return api.get<{ diff: string; truncated: boolean }>(`/repos/${id}/diff?${q}`);
    },
    enabled: !!id && !!path,
  });
}

export function useRepoLog(id: string | null | undefined) {
  return useQuery({
    queryKey: repoKeys.log(id ?? ''),
    queryFn: () => api.get<{ items: CommitInfo[] }>(`/repos/${id}/log?limit=20`).then((r) => r.items),
    enabled: !!id,
  });
}

export function useRepoBranches(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: repoKeys.branches(id ?? ''),
    queryFn: () => api.get<{ items: BranchInfo[] }>(`/repos/${id}/branches`).then((r) => r.items),
    enabled: !!id && enabled,
  });
}

export function useGitHubAccess(enabled = true) {
  return useQuery({
    queryKey: repoKeys.access,
    queryFn: () => api.get<GitHubAccess>('/github/access'),
    enabled,
    staleTime: 60_000,
  });
}

export function usePulls(id: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: repoKeys.pulls(id ?? ''),
    queryFn: () => api.get<{ items: PullRequestInfo[] }>(`/repos/${id}/pulls`).then((r) => r.items),
    enabled: !!id && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useRuns(id: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: repoKeys.runs(id ?? ''),
    queryFn: () => api.get<{ items: WorkflowRunInfo[] }>(`/repos/${id}/runs`).then((r) => r.items),
    enabled: !!id && enabled,
    staleTime: 20_000,
    retry: false,
  });
}

/** Run an operation, then refresh everything about that repository. */
export async function repoAction(id: string, req: RepoActionRequest): Promise<{ ok: true; output: string }> {
  try {
    return await api.post<{ ok: true; output: string }>(`/repos/${id}/actions`, req);
  } finally {
    await refreshRepo(id);
  }
}

export function refreshRepo(id: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: repoKeys.repo(id) }),
    queryClient.invalidateQueries({ queryKey: ['repos', 'linked'] }),
  ]);
}

export async function linkRepo(scope: 'notebook' | 'thread', scopeRef: string, repoId: string | null) {
  await api.post('/repos/link', { scope, scope_ref: scopeRef, repo_id: repoId });
  await queryClient.invalidateQueries({ queryKey: ['repos', 'linked'] });
}

export async function addRepo(path: string): Promise<RepoInfo> {
  const r = await api.post<RepoInfo>('/repos', { path });
  await queryClient.invalidateQueries({ queryKey: repoKeys.all });
  return r;
}
