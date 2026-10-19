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
 *           |  connection is held longer than the check. It also fills
 *           |  the claims store as each claim is found and each verdict
 *           |  lands, so the Evidence tab shows cards, not a skeleton (EV1),
 *           |  and a panel opened mid-check follows the same run again. The result
 *           |  is a query that polls gently while a check is running,
 *           |  which also catches checks started by grounded mode.
 *           |  A 404 (factcheck.none) is "not checked yet", not an
 *           |  error. An answer's citations are checked against their
 *           |  sources now (removed, changed since cited), once per
 *           |  answer and again when sources change.
 * ------------------------------------------------------------------
 */

import {
  type CitationStatus,
  type ClaimVerdict,
  type Explain,
  type Factcheck,
  RunEvent,
  type SelectionCheck,
  type StartFactcheckResponse,
  type StartSelectionCheckResponse,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { notify } from '../state/notify';
import { ApiCallError, api } from './api';
import { queryClient } from './query';
import { openStream } from './sse';

export const fcKeys = {
  factcheck: (messageId: string) => ['factcheck', messageId] as const,
  explain: (messageId: string) => ['explain', messageId] as const,
  citations: (messageId: string) => ['citations', messageId] as const,
};

export interface FactcheckProgress {
  stage: 'starting' | 'extracting' | 'gathering' | 'verifying' | 'done' | 'failed';
  done: number;
  total: number;
}

/** A claim of a check still running: found, and judged once its verdict has landed (EV1). */
export interface LiveClaim {
  index: number;
  text: string;
  checkable: boolean;
  verdict?: ClaimVerdict;
  rationale?: string;
  judge?: string | null;
  quotes?: {
    source_title: string;
    quote: string;
    stance: 'supports' | 'contradicts' | 'neutral';
    origin: 'source' | 'web';
  }[];
}

interface ProgressState {
  byMessage: Record<string, FactcheckProgress>;
  /** The claims of each running check, in the order they were found. */
  claims: Record<string, LiveClaim[]>;
  set: (messageId: string, p: FactcheckProgress | null) => void;
  /** A claim was found, or its verdict landed. */
  claim: (messageId: string, c: LiveClaim) => void;
}

export const useFactcheckProgress = create<ProgressState>((set) => ({
  byMessage: {},
  claims: {},
  set: (messageId, p) =>
    set((s) => {
      if (p) return { byMessage: { ...s.byMessage, [messageId]: p } };
      const { [messageId]: _gone, ...rest } = s.byMessage;
      const { [messageId]: _claims, ...claims } = s.claims;
      return { byMessage: rest, claims };
    }),
  claim: (messageId, c) =>
    set((s) => {
      const list = (s.claims[messageId] ?? []).filter((x) => x.index !== c.index);
      // A verdict keeps the words the claim was found with.
      const found = s.claims[messageId]?.find((x) => x.index === c.index);
      return {
        claims: {
          ...s.claims,
          [messageId]: [...list, { ...found, ...c }].sort((a, b) => a.index - b.index),
        },
      };
    }),
}));

const NO_CLAIMS: LiveClaim[] = [];

/** The claims found so far in a check that is running. */
export function useLiveClaims(messageId: string): LiveClaim[] {
  return useFactcheckProgress((s) => s.claims[messageId] ?? NO_CLAIMS);
}

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
      if (e.type === 'factcheck.claim')
        useFactcheckProgress.getState().claim(messageId, {
          index: e.index,
          text: e.text,
          checkable: e.checkable,
          ...(e.verdict && { verdict: e.verdict }),
          ...(e.rationale !== undefined && { rationale: e.rationale }),
          ...(e.judge !== undefined && { judge: e.judge }),
          ...(e.quotes && { quotes: e.quotes }),
        });
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

/**
 * Follow a check that is already running (the panel was closed and opened again, or the page
 * reloaded): the run's events replay from the start, so the cards fill in as if it had been watched.
 */
export function resumeFactcheck(messageId: string, runId: string): void {
  if (streams.has(messageId)) return;
  useFactcheckProgress.getState().set(messageId, { stage: 'starting', done: 0, total: 0 });
  follow(messageId, runId);
}

/** Start (or join) a fact-check of one answer. `web: true` allows the web for this check (FC4). */
export async function startFactcheck(messageId: string, opts: { web?: boolean } = {}): Promise<void> {
  useFactcheckProgress.getState().set(messageId, { stage: 'starting', done: 0, total: 0 });
  try {
    const r = await api.post<StartFactcheckResponse>(
      `/messages/${messageId}/factcheck`,
      opts.web ? { web: true } : undefined,
    );
    if (opts.web && r.web && !r.web.used && r.web.note)
      notify({ level: 'info', title: 'Checked against your sources only', body: r.web.note });
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

/** What a highlighted claim's check needs from the person: the text, and what it was inside. */
export interface SelectionCheckBody {
  text: string;
  kind?: SelectionCheck['kind'];
  web?: boolean;
  again?: boolean;
}

/** Check a highlighted claim; the card is also recorded on the message, so a reload keeps it. */
export async function runSelectionCheck(
  messageId: string,
  body: SelectionCheckBody,
): Promise<StartSelectionCheckResponse> {
  const r = await api.post<StartSelectionCheckResponse>(`/messages/${messageId}/selection-checks`, body);
  void queryClient.invalidateQueries({ queryKey: ['thread'] });
  void queryClient.invalidateQueries({ queryKey: fcKeys.explain(messageId) });
  return r;
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

/**
 * What became of an answer's cited sources: removed or changed since. Only
 * asked for answers that cite something; a failure leaves the chips as they
 * are, never flagged.
 */
export function useCitationStatus(messageId: string | null | undefined, cites: boolean) {
  return useQuery({
    queryKey: fcKeys.citations(messageId ?? 'none'),
    enabled: Boolean(messageId) && cites,
    staleTime: 60_000,
    retry: false,
    queryFn: () => api.get<CitationStatus>(`/messages/${messageId}/citations`),
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

/** Let fact-checks in a notebook look claims up on the web (off by default; never for a private notebook). */
export async function setCheckOnWeb(notebookId: string, on: boolean): Promise<boolean> {
  try {
    await api.patch(`/notebooks/${notebookId}`, { check_on_web: on });
    await queryClient.invalidateQueries({ queryKey: ['notebooks'] });
    notify({
      level: 'success',
      title: on ? 'Fact-checks here can use the web' : 'Fact-checks here use your sources only',
      body: on
        ? 'Claims your sources do not cover are looked up on the web. Each search asks permission first.'
        : 'You can still allow the web for one check at a time.',
    });
    return true;
  } catch (err) {
    const e = err instanceof ApiCallError ? err.body.error : null;
    notify({ level: 'warn', title: e?.title ?? 'That setting could not be changed', body: e?.hint });
    return false;
  }
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
