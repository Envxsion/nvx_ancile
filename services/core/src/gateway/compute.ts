/**
 * ------------------------------------------------------------------
 *  Title    |  Waiting for a GPU node
 *  Ref      |  DESIGN.md §7.3 · ROADMAP.md Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A model that runs on your own node may be asleep. The
 *           |  Controller wakes it and answers 503 node_waking; the
 *           |  gateway then waits (the thread says "Waking your GPU
 *           |  node") and asks again, until the node answers, the wait
 *           |  runs out, or you choose "Use a cloud model instead".
 *  How      |  nodeWakingFrom() reads the Controller's error body out of
 *           |  whatever the AI SDK threw. waitOrSkip() sleeps for the
 *           |  Retry-After, but wakes at once if the run is stopped or
 *           |  the person asks to use the cloud (useCloud(runId)).
 *  Note     |  The run stays running while it waits, holding its lease
 *           |  (heartbeats keep it), rather than parking as
 *           |  waiting_compute: the wait is short and visible, and the
 *           |  answer streams straight on when the node is up.
 * ------------------------------------------------------------------
 */

export interface NodeWaking {
  nodeId: string | null;
  etaS: number | null;
  retryAfterS: number;
  message: string;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

/** The Controller's node_waking answer, or null for any other error. */
export function nodeWakingFrom(err: unknown): NodeWaking | null {
  const seen = new Set<unknown>();
  let e: unknown = err;
  // The AI SDK wraps: RetryError → APICallError (statusCode, responseBody, responseHeaders).
  while (e && !seen.has(e)) {
    seen.add(e);
    const r = asRecord(e);
    if (!r) break;
    const status = r.statusCode ?? r.status;
    const raw = typeof r.responseBody === 'string' ? r.responseBody : null;
    if (status === 503 && raw?.includes('node_waking')) {
      let body: Record<string, unknown> = {};
      try {
        body = asRecord(asRecord(JSON.parse(raw))?.error) ?? {};
      } catch {
        /* not JSON: use defaults */
      }
      const headers = asRecord(r.responseHeaders) ?? {};
      const retry = Number(headers['retry-after'] ?? headers['Retry-After']);
      const eta = Number(body.eta_s);
      return {
        nodeId: typeof body.node_id === 'string' ? body.node_id : null,
        etaS: Number.isFinite(eta) ? eta : null,
        retryAfterS: Number.isFinite(retry) && retry >= 0 ? retry : 10,
        message: typeof body.message === 'string' ? body.message : 'The GPU node is waking up.',
      };
    }
    e = r.lastError ?? r.cause ?? (Array.isArray(r.errors) ? r.errors.at(-1) : undefined);
  }
  return null;
}

const skips = new Set<string>();
const waiters = new Map<string, Set<() => void>>();

/** "Use a cloud model instead": the run stops waiting and falls through to the next model. */
export function useCloud(runId: string): void {
  skips.add(runId);
  for (const wake of waiters.get(runId) ?? []) wake();
  // Forget the choice after the run has had time to act on it.
  setTimeout(() => skips.delete(runId), 10 * 60_000).unref?.();
}

export function skipRequested(runId: string | null): boolean {
  return runId !== null && skips.has(runId);
}

/** Sleep before asking the node again; 'skip' when the person chose the cloud. */
export function waitOrSkip(ms: number, signal: AbortSignal, runId: string | null): Promise<'retry' | 'skip'> {
  if (skipRequested(runId)) return Promise.resolve('skip');
  return new Promise((resolve) => {
    const set = runId ? (waiters.get(runId) ?? new Set()) : null;
    const done = (v: 'retry' | 'skip') => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (set && runId) {
        set.delete(wake);
        if (!set.size) waiters.delete(runId);
      }
      resolve(v);
    };
    const wake = () => done('skip');
    const onAbort = () => done('retry');
    const timer = setTimeout(() => done('retry'), ms);
    signal.addEventListener('abort', onAbort);
    if (set && runId) {
      set.add(wake);
      waiters.set(runId, set);
    }
  });
}
