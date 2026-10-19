/**
 * ------------------------------------------------------------------
 *  Title    |  Interpreter host
 *  Ref      |  docs/interpreter.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Take python_run requests from Core and run them in this
 *           |  window's sandbox, one at a time, then send the outcome
 *           |  back. Every open window offers; the first claim wins.
 *  How      |  `interpreter.requested` (global events) → claim → read
 *           |  the request → fetch the runtime files Core verified and
 *           |  the attachments Core listed (nothing else) → run →
 *           |  post the result. Live progress per tool call is kept in
 *           |  a small store, so the step in the answer can say
 *           |  "Downloading Python" or "Running" while it waits.
 * ------------------------------------------------------------------
 */

import type { InterpreterRequest } from '@nvx/contracts';
import { PYODIDE_VERSION } from '@nvx/contracts/interpreter';
import { create } from 'zustand';
import { API_BASE, api } from '../lib/api';
import type { PythonSandbox, RunOutcome, Stage } from './sandbox';

export interface Live {
  stage: Stage;
  since: number;
}

interface LiveState {
  calls: Record<string, Live>;
  set: (callId: string, stage: Stage | null) => void;
}

export const useInterpreterLive = create<LiveState>((set) => ({
  calls: {},
  set: (callId, stage) =>
    set((s) => {
      const calls = { ...s.calls };
      if (stage) calls[callId] = { stage, since: calls[callId]?.since ?? Date.now() };
      else delete calls[callId];
      return { calls };
    }),
}));

/** This window's id when claiming (random per tab). */
const CLIENT_ID = (() => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `win-${Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')}`;
})();

async function bytesOf(path: string): Promise<ArrayBuffer> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`NVX Ancile could not provide ${path.split('/').pop()} (${res.status}).`);
  return res.arrayBuffer();
}

let sandbox: PythonSandbox | null = null;
async function theSandbox(): Promise<PythonSandbox> {
  if (sandbox) return sandbox;
  const { PythonSandbox } = await import('./sandbox');
  sandbox = new PythonSandbox({
    runtimeFile: (name) => bytesOf(`/interpreter/runtime/${PYODIDE_VERSION}/${encodeURIComponent(name)}`),
  });
  return sandbox;
}

let queue: Promise<unknown> = Promise.resolve();
const seen = new Set<string>();

async function runOne(id: string, key: string, req: InterpreterRequest) {
  let outcome: RunOutcome;
  try {
    const files = await Promise.all(
      req.files.map(async (f) => ({
        name: f.name,
        bytes: await bytesOf(`/sources/${encodeURIComponent(f.source_id)}/file`),
      })),
    );
    const box = await theSandbox();
    outcome = await box.run(
      { code: req.code, files, timeoutS: req.timeout_s, memoryMb: req.memory_mb },
      (stage) => useInterpreterLive.getState().set(key, stage),
    );
  } catch (err) {
    outcome = {
      ok: false,
      stdout: '',
      stderr: '',
      figures: [],
      error: { kind: 'runtime', message: (err as Error).message.slice(0, 2000) },
      duration_ms: 0,
      truncated: false,
    };
  }
  try {
    await api.post(`/interpreter/requests/${encodeURIComponent(id)}/result`, {
      client_id: CLIENT_ID,
      ...outcome,
    });
  } finally {
    useInterpreterLive.getState().set(key, null);
  }
}

/** From the global event stream: claim at once (first window wins), run in turn. */
export function onInterpreterRequested(e: { request_id: string; call_id: string | null }): void {
  if (seen.has(e.request_id)) return;
  seen.add(e.request_id);
  void api
    .post<InterpreterRequest>(`/interpreter/requests/${encodeURIComponent(e.request_id)}/claim`, {
      client_id: CLIENT_ID,
    })
    .then(
      (req) => {
        const key = e.call_id ?? req.call_id ?? e.request_id;
        useInterpreterLive.getState().set(key, 'starting');
        queue = queue.then(() => runOne(e.request_id, key, req)).catch(() => undefined);
      },
      // Another window took it, or it is gone: nothing to do here.
      () => undefined,
    );
}
