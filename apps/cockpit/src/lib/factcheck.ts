/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-checks and explanations
 *  Ref      |  DESIGN.md §10, §11.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Start a fact-check of an answer and watch it work
 *           |  (extracting, gathering, verifying n of m), read its
 *           |  result, and read why an answer said what it said.
 *  How      |  POST starts a durable run; its stream feeds a small
 *           |  progress store and closes on `done` or `error`, so no
 *           |  connection is held longer than the check. The result
 *           |  is a query that polls gently while a check is running,
 *           |  which also catches checks started by grounded mode.
 *           |  A 404 (factcheck.none) is "not checked yet", not an
 *           |  error.
 * ------------------------------------------------------------------
 */

import { type Explain, type Factcheck, RunEvent, type StartFactcheckResponse } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { notify } from '../state/notify';
import { ApiCallError, api } from './api';
import { queryClient } from './query';
import { openStream } from './sse';

export const fcKeys = {
  factcheck: (messageId: string) => ['factcheck', messageId] as const,
  explain: (messageId: string) => ['explain', messageId] as const,
};

export interface FactcheckProgress {
  stage: 'starting' | 'extracting' | 'gathering' | 'verifying' | 'done' | 'failed';
  done: number;
  total: number;
}

interface ProgressState {
  byMessage: Record<string, FactcheckProgress>;
  set: (messageId: string, p: FactcheckProgress | null) => void;
}

export const useFactcheckProgress = create<ProgressState>((set) => ({
  byMessage: {},
  set: (messageId, p) =>
    set((s) => {
      if (p) return { byMessage: { ...s.byMessage, [messageId]: p } };
      const { [messageId]: _gone, ...rest } = s.byMessage;
      return { byMessage: rest };
    }),
}));

export function useProgress(messageId: string): FactcheckProgress | undefined {
  return useFactcheckProgress((s) => s.byMessage[messageId]);
}

const streams = new Map<string, () => void>();

function follow(messageId: string, runId: string) {
  streams.get(messageId)?.();
  const finish = () => {
    streams.get(messageId)?.();
    streams.delete(messageId);
    // The answer's provenance now names the check: refresh it before letting
    // go of the live progress, so the chip never blinks out in between.
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: fcKeys.factcheck(messageId) }),
      queryClient.invalidateQueries({ queryKey: fcKeys.explain(messageId) }),
      queryClient.invalidateQueries({ queryKey: ['thread'] }),
    ]).finally(() => setTimeout(() => useFactcheckProgress.getState().set(messageId, null), 300));
  };
  const close = openStream({
    url: `/api/v1/runs/${runId}/stream`,
    schema: RunEvent,
    onEvent: (e) => {
      if (e.type === 'factcheck.progress')
        useFactcheckProgress.getState().set(messageId, { stage: e.stage, done: e.done, total: e.total });
      if (e.type === 'error')
        useFactcheckProgress.getState().set(messageId, { stage: 'failed', done: 0, total: 0 });
    },
    isTerminal: (e) => e.type === 'done' || e.type === 'error',
    onState: (state) => {
      if (state === 'closed') finish();
    },
  });
  streams.set(messageId, close);
}

/** Start (or join) a fact-check of one answer. */
export async function startFactcheck(messageId: string): Promise<void> {
  useFactcheckProgress.getState().set(messageId, { stage: 'starting', done: 0, total: 0 });
  try {
    const r = await api.post<StartFactcheckResponse>(`/messages/${messageId}/factcheck`);
    void queryClient.invalidateQueries({ queryKey: fcKeys.factcheck(messageId) });
    follow(messageId, r.run_id);
  } catch (err) {
    useFactcheckProgress.getState().set(messageId, null);
    const e = err instanceof ApiCallError ? err.body.error : null;
    notify({
      level: 'warn',
      title: e?.title ?? 'The fact-check could not start',
      body: e?.hint ?? 'Check that Core is running, then try again.',
    });
  }
}

/** The latest fact-check of an answer; null when it has never been checked. */
export function useFactcheck(messageId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: fcKeys.factcheck(messageId ?? 'none'),
    enabled: Boolean(messageId) && enabled,
    staleTime: 30_000,
    retry: (n, err) => !(err instanceof ApiCallError && err.status < 500) && n < 2,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1_500 : false),
    queryFn: async () => {
      try {
        return await api.get<Factcheck>(`/messages/${messageId}/factcheck`);
      } catch (err) {
        if (err instanceof ApiCallError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useExplain(messageId: string | null | undefined) {
  return useQuery({
    queryKey: fcKeys.explain(messageId ?? 'none'),
    enabled: Boolean(messageId),
    staleTime: 15_000,
    queryFn: () => api.get<Explain>(`/messages/${messageId}/explain`),
  });
}

/** Turn grounded mode on or off for a notebook (every answer fact-checked). */
export async function setGrounded(notebookId: string, grounded: boolean): Promise<boolean> {
  try {
    await api.patch(`/notebooks/${notebookId}`, { grounded });
    await queryClient.invalidateQueries({ queryKey: ['notebooks'] });
    notify({
      level: 'success',
      title: grounded ? 'Grounded mode is on' : 'Grounded mode is off',
      body: grounded
        ? 'Every answer in this notebook is now fact-checked against its sources.'
        : 'Answers here are no longer fact-checked on their own. Press F on any answer to check it.',
    });
    return true;
  } catch (err) {
    const e = err instanceof ApiCallError ? err.body.error : null;
    notify({ level: 'warn', title: e?.title ?? 'Grounded mode could not be changed', body: e?.hint });
    return false;
  }
}
