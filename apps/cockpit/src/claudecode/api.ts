/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code: data
 *  Ref      |  packages/contracts/src/claudecode.ts · docs/claude-code.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the Cockpit asks Core about the person's own
 *           |  Claude Code: whether it is installed and signed in, its
 *           |  settings, the sessions on this computer, importing them
 *           |  and syncing a thread that came from one.
 *  How      |  React Query over /api/v1/claude-code. The global event
 *           |  claude_code.changed invalidates what it makes stale
 *           |  (onClaudeCodeChanged), and install progress lands in a
 *           |  small store so the Settings card can show it live.
 *  Note     |  NVX Ancile never handles Claude credentials. Signing in
 *           |  is Claude Code's own browser flow; Core only starts it.
 * ------------------------------------------------------------------
 */

import type {
  ClaudeCodeProject,
  ClaudeCodeSession,
  ClaudeCodeSettings,
  ClaudeCodeStatus,
  GlobalEvent,
  ImportClaudeCodeSessionsRequest,
  ImportClaudeCodeSessionsResult,
} from '@nvx/contracts';
import { type QueryClient, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { reportFailure } from '../ops/common';
import { notify } from '../state/notify';

export const CC_KEYS = {
  all: ['claude-code'] as const,
  status: ['claude-code', 'status'] as const,
  sessions: ['claude-code', 'sessions'] as const,
  sessionList: (q: string) => ['claude-code', 'sessions', q] as const,
  projects: ['claude-code', 'projects'] as const,
};

/* ---- Live install progress ---------------------------------------------- */

interface InstallProgress {
  /** The latest line Core sent while installing, if any. */
  detail: string | null;
  set: (detail: string | null) => void;
}

export const useInstallProgress = create<InstallProgress>((set) => ({
  detail: null,
  set: (detail) => set({ detail }),
}));

/* ---- Background import progress ------------------------------------------ */

interface ImportProgress {
  /** "Bringing in 12 of 40 sessions", while Core brings sessions in by itself. */
  line: string | null;
  set: (line: string | null) => void;
}

export const useImportProgress = create<ImportProgress>((set) => ({
  line: null,
  set: (line) => set({ line }),
}));

/**
 * What a `sessions` event's detail says. Assumed convention with Core:
 * "importing:<done>/<total>" while it works, "imported:<n>" once at the end;
 * any other text is shown as it is.
 */
export function readSessionsDetail(
  detail: string | undefined,
): { kind: 'progress'; line: string } | { kind: 'done'; count: number } | null {
  const d = detail?.trim();
  if (!d) return null;
  const done = /^imported:(\d+)$/.exec(d);
  if (done) return { kind: 'done', count: Number(done[1]) };
  const step = /^importing:(\d+)\/(\d+)$/.exec(d);
  if (step) return { kind: 'progress', line: `Bringing in ${step[1]} of ${step[2]} sessions` };
  return { kind: 'progress', line: d };
}

type CcChanged = Extract<GlobalEvent, { type: 'claude_code.changed' }>;

/** What a claude_code.changed event makes stale. */
export function onClaudeCodeChanged(e: CcChanged, qc: QueryClient): void {
  switch (e.what) {
    case 'install':
      useInstallProgress.getState().set(e.detail ?? null);
      void qc.invalidateQueries({ queryKey: CC_KEYS.status });
      break;
    case 'auth':
      void qc.invalidateQueries({ queryKey: CC_KEYS.status });
      break;
    case 'sessions': {
      const d = readSessionsDetail(e.detail);
      if (d?.kind === 'progress') useImportProgress.getState().set(d.line);
      if (d?.kind === 'done') {
        useImportProgress.getState().set(null);
        if (d.count > 0) {
          // One toast at the end, never one per session; the id keeps a replayed event from repeating it.
          notify({
            id: `cc-imported-${e.seq}`,
            level: 'success',
            title: `Brought in ${d.count} Claude Code ${d.count === 1 ? 'session' : 'sessions'}`,
          });
          void qc.invalidateQueries({ queryKey: keys.threads });
          void qc.invalidateQueries({ queryKey: keys.notebooks });
        }
      }
      void qc.invalidateQueries({ queryKey: CC_KEYS.sessions });
      break;
    }
    case 'thread':
      if (e.thread_id) void qc.invalidateQueries({ queryKey: keys.thread(e.thread_id) });
      void qc.invalidateQueries({ queryKey: CC_KEYS.sessions });
      break;
    default:
      break;
  }
}

/* ---- Status and settings ------------------------------------------------- */

export function useClaudeCodeStatus(opts: { poll?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: CC_KEYS.status,
    enabled: opts.enabled ?? true,
    queryFn: () => api.get<ClaudeCodeStatus>('/claude-code/status'),
    staleTime: 30_000,
    // Events move this along; polling is only the fallback while something is under way.
    refetchInterval: (q) => (opts.poll || q.state.data?.install.state === 'installing' ? 2_500 : false),
  });
}

/** Core answers with the new status; tolerate it answering with the settings alone. */
function mergeSettings(prev: ClaudeCodeStatus | undefined, next: unknown): ClaudeCodeStatus | undefined {
  if (next && typeof next === 'object' && 'installed' in next) return next as ClaudeCodeStatus;
  if (!prev) return prev;
  return { ...prev, settings: { ...prev.settings, ...(next as Partial<ClaudeCodeSettings>) } };
}

export function usePatchClaudeCodeSettings() {
  return useMutation({
    mutationFn: (patch: Partial<ClaudeCodeSettings>) =>
      api.patch<ClaudeCodeStatus | ClaudeCodeSettings>('/claude-code/settings', patch),
    onMutate: (patch) => {
      const before = queryClient.getQueryData<ClaudeCodeStatus>(CC_KEYS.status);
      if (before)
        queryClient.setQueryData<ClaudeCodeStatus>(CC_KEYS.status, {
          ...before,
          settings: { ...before.settings, ...patch },
        });
      return { before };
    },
    onSuccess: (next) =>
      queryClient.setQueryData<ClaudeCodeStatus | undefined>(CC_KEYS.status, (prev) =>
        mergeSettings(prev, next),
      ),
    onError: (error, _patch, ctx) => {
      if (ctx?.before) queryClient.setQueryData(CC_KEYS.status, ctx.before);
      reportFailure(error, 'Saving the setting');
    },
  });
}

export async function installClaudeCode(): Promise<void> {
  useInstallProgress.getState().set(null);
  queryClient.setQueryData<ClaudeCodeStatus | undefined>(CC_KEYS.status, (s) =>
    s ? { ...s, install: { state: 'installing', error: null } } : s,
  );
  try {
    await api.post('/claude-code/install');
  } catch (error) {
    reportFailure(error, 'Installing Claude Code');
  }
  void queryClient.invalidateQueries({ queryKey: CC_KEYS.status });
}

/** Asks Core to start Claude Code's own sign-in, which opens in the browser. */
export async function startClaudeCodeSignIn(): Promise<boolean> {
  try {
    await api.post('/claude-code/sign-in');
    return true;
  } catch (error) {
    reportFailure(error, 'Starting Claude Code sign-in');
    return false;
  }
}

export async function signOutOfClaudeCode(): Promise<void> {
  try {
    await api.post('/claude-code/sign-out');
    notify({ level: 'success', title: 'Signed out of Claude Code' });
  } catch (error) {
    reportFailure(error, 'Signing out of Claude Code');
  }
  void queryClient.invalidateQueries({ queryKey: CC_KEYS.status });
}

/* ---- Sessions ------------------------------------------------------------ */

export interface SessionPage {
  items: ClaudeCodeSession[];
  next_cursor: string | null;
}

export const PAGE_SIZE = 60;

function sessionsPath(p: { q?: string; cwd?: string; limit?: number; cursor?: string | null }): string {
  const s = new URLSearchParams();
  if (p.q) s.set('q', p.q);
  if (p.cwd) s.set('cwd', p.cwd);
  s.set('limit', String(p.limit ?? PAGE_SIZE));
  if (p.cursor) s.set('cursor', p.cursor);
  return `/claude-code/sessions?${s.toString()}`;
}

export function useClaudeCodeSessions(q: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: CC_KEYS.sessionList(q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<SessionPage>(sessionsPath({ q, cursor: pageParam })),
    getNextPageParam: (last) => last.next_cursor,
    enabled,
    staleTime: 15_000,
  });
  return { ...query, items: query.data?.pages.flatMap((p) => p.items) ?? [] };
}

/** Every session from one folder, following the cursor (capped at the import limit). */
export async function sessionsInFolder(cwd: string): Promise<ClaudeCodeSession[]> {
  const out: ClaudeCodeSession[] = [];
  let cursor: string | null = null;
  do {
    const page: SessionPage = await api.get<SessionPage>(sessionsPath({ cwd, limit: 200, cursor }));
    out.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && out.length < 500);
  return out;
}

export async function importSessions(body: ImportClaudeCodeSessionsRequest) {
  const result = await api.post<ImportClaudeCodeSessionsResult>('/claude-code/sessions/import', body);
  void queryClient.invalidateQueries({ queryKey: CC_KEYS.sessions });
  void queryClient.invalidateQueries({ queryKey: keys.threads });
  void queryClient.invalidateQueries({ queryKey: keys.notebooks });
  for (const i of result.imported) void queryClient.invalidateQueries({ queryKey: keys.thread(i.thread_id) });
  return result;
}

/** Brings a thread up to date with its Claude Code session, and says what happened. */
export async function syncThread(threadId: string): Promise<number | null> {
  try {
    const { added } = await api.post<{ added: number }>(`/claude-code/threads/${threadId}/sync`);
    notify({
      level: added ? 'success' : 'info',
      title: added ? `Added ${added} ${added === 1 ? 'message' : 'messages'}` : 'Already up to date',
    });
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    void queryClient.invalidateQueries({ queryKey: CC_KEYS.sessions });
    return added;
  } catch (error) {
    reportFailure(error, 'Syncing from Claude Code');
    return null;
  }
}

/* ---- Folders -------------------------------------------------------------- */

/** Which notebook each Claude Code folder lands in. */
export function useClaudeCodeProjects(enabled = true) {
  return useQuery({
    queryKey: CC_KEYS.projects,
    queryFn: () => api.get<{ items: ClaudeCodeProject[] }>('/claude-code/projects'),
    enabled,
    staleTime: 60_000,
    select: (r) => r.items,
  });
}

/**
 * "Don't bring in this folder": it joins the excluded folders, and its
 * threads are archived by Core. Answers whether it worked.
 */
export async function excludeFolder(cwd: string): Promise<boolean> {
  try {
    const settings = await api.post<ClaudeCodeSettings>('/claude-code/projects/exclude', { cwd });
    queryClient.setQueryData<ClaudeCodeStatus | undefined>(CC_KEYS.status, (prev) =>
      mergeSettings(prev, settings),
    );
    notify({ level: 'success', title: `Sessions from ${folderOf(cwd)} no longer come in` });
    void queryClient.invalidateQueries({ queryKey: CC_KEYS.all });
    void queryClient.invalidateQueries({ queryKey: keys.threads });
    void queryClient.invalidateQueries({ queryKey: keys.notebooks });
    return true;
  } catch (error) {
    reportFailure(error, 'Excluding the folder');
    return false;
  }
}

/** "/home/me/work/site" → "site". */
export function folderOf(cwd: string): string {
  const parts = cwd.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/* ---- Words -------------------------------------------------------------- */

const METHOD_WORDS: Record<string, string> = {
  'claude.ai': 'a Claude account',
  claudeai: 'a Claude account',
  oauth: 'a Claude account',
  api_key: 'an Anthropic API key',
  apikey: 'an Anthropic API key',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

const PLAN_WORDS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
};

/** "Signed in with a Claude account, Max plan." */
export function signedInWords(s: Pick<ClaudeCodeStatus, 'auth_method' | 'plan'>): string {
  const method = s.auth_method ? (METHOD_WORDS[s.auth_method.toLowerCase()] ?? s.auth_method) : null;
  const plan = s.plan ? (PLAN_WORDS[s.plan.toLowerCase()] ?? s.plan) : null;
  return `Signed in${method ? ` with ${method}` : ''}${plan ? `, ${plan} plan` : ''}.`;
}

/** 812 KB, 3.4 MB. */
export function sizeWords(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
