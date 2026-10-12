/**
 * ------------------------------------------------------------------
 *  Title    |  Code interpreter: requests and results
 *  Ref      |  docs/interpreter.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Run python_run in a Cockpit window and wait for what it
 *           |  printed and drew. Core decides everything that matters
 *           |  (which code, which files, how long, how much memory);
 *           |  the window only executes, sandboxed, with no network.
 *  How      |  run() parks a request, publishes interpreter.requested,
 *           |  and waits: first for a window to claim it (one claim
 *           |  wins), then for that window's outcome. Figures are kept
 *           |  in core.interpreter_figures and named by id in the
 *           |  result, so the model reads a few words, not a PNG.
 *  Note     |  No window open: the call fails with a plain reason the
 *           |  model can relay ("Open NVX Ancile to run Python").
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type GlobalEvent,
  INTERPRETER_LIMITS,
  type InterpreterFile,
  type InterpreterOutcome,
  type InterpreterRequest,
  PYODIDE_FILES,
  PYODIDE_VERSION,
  type PythonRunResult,
} from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import { logFor } from '../obs/logger';

const log = logFor('interpreter');

export interface FigureStore {
  put(f: {
    threadId: string | null;
    callId: string | null;
    png: Buffer;
    width: number;
    height: number;
  }): Promise<string>;
  get(id: string): Promise<{ png: Buffer; threadId: string | null } | null>;
}

export class PgFigureStore implements FigureStore {
  constructor(private readonly sql: Sql) {}
  async put(f: Parameters<FigureStore['put']>[0]) {
    const id = `fig_${ulid()}`;
    await this.sql`
      insert into core.interpreter_figures (id, thread_id, call_id, png, width, height)
      values (${id}, ${f.threadId}, ${f.callId}, ${f.png}, ${f.width}, ${f.height})`;
    return id;
  }
  async get(id: string) {
    const rows = await this.sql<{ png: Buffer; thread_id: string | null }[]>`
      select png, thread_id from core.interpreter_figures where id = ${id}`;
    const r = rows[0];
    return r ? { png: r.png, threadId: r.thread_id } : null;
  }
}

export class MemoryFigureStore implements FigureStore {
  readonly figures = new Map<string, { png: Buffer; threadId: string | null }>();
  async put(f: Parameters<FigureStore['put']>[0]) {
    const id = `fig_${this.figures.size + 1}`;
    this.figures.set(id, { png: f.png, threadId: f.threadId });
    return id;
  }
  async get(id: string) {
    return this.figures.get(id) ?? null;
  }
}

interface Pending {
  request: InterpreterRequest;
  claimedBy: string | null;
  settle: (r: { outcome: InterpreterOutcome } | { error: AncileError }) => void;
}

export interface InterpreterDeps {
  figures: FigureStore;
  publish: (e: GlobalEvent) => Promise<unknown> | unknown;
  /** Seconds, for tests. */
  limits?: { claimS?: number; startS?: number };
}

const PNG = /^[A-Za-z0-9+/]+={0,2}$/;

/** Keep the first `max` characters, saying how many were left out. */
export function clip(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  return {
    text: `${s.slice(0, max)}\n… ${(s.length - max).toLocaleString('en-GB')} more characters`,
    cut: true,
  };
}

export class InterpreterService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: InterpreterDeps) {}

  /** The request a claiming window reads. Only the window that claimed it may read it. */
  request(id: string, clientId: string): InterpreterRequest {
    const p = this.pending.get(id);
    if (!p) throw gone();
    if (p.claimedBy !== clientId) throw notYours();
    return p.request;
  }

  /** First claim wins; later ones are told it is taken. */
  claim(id: string, clientId: string): InterpreterRequest {
    const p = this.pending.get(id);
    if (!p) throw gone();
    if (p.claimedBy && p.claimedBy !== clientId) throw notYours();
    p.claimedBy = clientId;
    return p.request;
  }

  /** The window's outcome; only from the window that claimed it. */
  finish(id: string, outcome: InterpreterOutcome): void {
    const p = this.pending.get(id);
    if (!p) throw gone();
    if (p.claimedBy !== outcome.client_id) throw notYours();
    this.pending.delete(id);
    p.settle({ outcome });
  }

  get open(): number {
    return this.pending.size;
  }

  async run(
    input: {
      threadId: string | null;
      callId: string | null;
      code: string;
      files: InterpreterFile[];
      timeoutS?: number;
    },
    signal: AbortSignal,
  ): Promise<PythonRunResult> {
    const limits = { ...INTERPRETER_LIMITS, ...this.deps.limits };
    const timeoutS = Math.min(input.timeoutS ?? limits.timeoutS, limits.maxTimeoutS);
    const request: InterpreterRequest = {
      id: `ipr_${ulid()}`,
      thread_id: input.threadId,
      call_id: input.callId,
      code: input.code,
      files: input.files,
      timeout_s: timeoutS,
      memory_mb: limits.memoryMb,
      runtime: { version: PYODIDE_VERSION, files: Object.keys(PYODIDE_FILES) },
      created_at: new Date().toISOString(),
    };
    const started = Date.now();
    const result = await new Promise<{ outcome: InterpreterOutcome } | { error: AncileError }>((resolve) => {
      let done = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const settle = (r: { outcome: InterpreterOutcome } | { error: AncileError }) => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(request.id);
        resolve(r);
      };
      const onAbort = () => settle({ error: cancelled() });
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.id, { request, claimedBy: null, settle });
      timers.push(
        setTimeout(() => {
          if (!this.pending.get(request.id)?.claimedBy) settle({ error: noWindow() });
        }, limits.claimS * 1000),
        // A backstop: the window enforces the run's own limit and the start-up allowance.
        setTimeout(() => settle({ error: tooSlow(timeoutS) }), (timeoutS + limits.startS) * 1000),
      );
      void Promise.resolve(
        this.deps.publish({
          type: 'interpreter.requested',
          request_id: request.id,
          thread_id: input.threadId,
          call_id: input.callId,
        } as GlobalEvent),
      ).catch((err: unknown) => log.warn({ err }, 'interpreter request could not be announced'));
    });
    if ('error' in result) throw result.error;
    return this.toResult(result.outcome, input, Date.now() - started);
  }

  private async toResult(
    o: InterpreterOutcome,
    input: { threadId: string | null; callId: string | null },
    _ms: number,
  ): Promise<PythonRunResult> {
    const figures: PythonRunResult['figures'] = [];
    for (const [i, f] of o.figures.slice(0, INTERPRETER_LIMITS.figures).entries()) {
      if (!PNG.test(f.png_base64)) continue;
      const png = Buffer.from(f.png_base64, 'base64');
      // A PNG and nothing else: the signature, and within the size limit.
      if (
        png.length > INTERPRETER_LIMITS.figureBytes ||
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      )
        continue;
      const id = await this.deps.figures.put({
        threadId: input.threadId,
        callId: input.callId,
        png,
        width: f.width,
        height: f.height,
      });
      figures.push({ id, width: f.width, height: f.height, alt: `Figure ${i + 1}` });
    }
    const out = clip(o.stdout, INTERPRETER_LIMITS.modelOutputChars);
    const err = clip(o.stderr, INTERPRETER_LIMITS.modelOutputChars);
    return {
      ok: o.ok,
      stdout: out.text,
      stderr: err.text,
      figures,
      error: o.error,
      duration_ms: o.duration_ms,
      truncated: o.truncated || out.cut || err.cut,
    };
  }
}

const gone = () =>
  new AncileError({
    code: 'interpreter.request_gone',
    title: 'That Python run is no longer waiting.',
    hint: 'It finished, timed out or was stopped. Ask for it again if you still need it.',
    status: 410,
    errorClass: 'permanent',
  });

const notYours = () =>
  new AncileError({
    code: 'interpreter.claimed',
    title: 'Another window is running this.',
    hint: 'Nothing to do here: its result appears in every window.',
    status: 409,
    errorClass: 'permanent',
  });

const noWindow = () =>
  new AncileError({
    code: 'interpreter.no_window',
    title: 'No NVX Ancile window is open to run Python.',
    hint: 'Python runs inside an open NVX Ancile window, sandboxed. Open one and ask again.',
    status: 503,
    retryable: true,
    errorClass: 'transient',
  });

const tooSlow = (s: number) =>
  new AncileError({
    code: 'interpreter.timeout',
    title: `The Python run did not finish within ${s} seconds.`,
    hint: 'Make the code do less, or ask for a longer limit (up to two minutes).',
    status: 504,
    errorClass: 'permanent',
  });

const cancelled = () =>
  new AncileError({
    code: 'interpreter.cancelled',
    title: 'The Python run was stopped.',
    hint: 'Ask again when you want it run.',
    status: 499,
    errorClass: 'permanent',
  });
