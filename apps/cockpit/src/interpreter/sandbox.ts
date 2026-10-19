/**
 * ------------------------------------------------------------------
 *  Title    |  The Python sandbox
 *  Ref      |  docs/interpreter.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Run code in Pyodide where it cannot reach the network,
 *           |  Core, this window's storage or anything on disk, and
 *           |  stop it when it runs too long.
 *  How      |  A hidden <iframe sandbox="allow-scripts"> (an opaque
 *           |  origin) on the frame host (lib/frameHost.ts), filled
 *           |  with a document whose CSP allows no connections at all
 *           |  starts the worker (worker.ts) from a Blob and relays
 *           |  messages both ways. When the worker asks for a runtime
 *           |  file, this side fetches it from Core (which checked its
 *           |  hash) and transfers the bytes in. A run past its limit
 *           |  removes the frame, which ends the worker with it; the
 *           |  next run starts a fresh one.
 *  Note     |  Messages are taken only from this frame's window, with
 *           |  its nonce, and are shape-checked; file names the worker
 *           |  asks for must look like runtime files, and Core serves
 *           |  only the pinned ones anyway.
 * ------------------------------------------------------------------
 */

import { INTERPRETER_LIMITS, InterpreterOutcome } from '@nvx/contracts/interpreter';
import { FRAME_HOST_URL, feedFrame } from '../lib/frameHost';
import { pythonWorker } from './worker';

const CHANNEL = 'nvx-ancile-python';

export type Stage = 'starting' | 'loading' | 'packages' | 'running';

export type RunOutcome = Omit<InterpreterOutcome, 'client_id'>;

export interface RunInput {
  code: string;
  files: { name: string; bytes: ArrayBuffer }[];
  timeoutS: number;
  memoryMb: number;
}

export interface SandboxDeps {
  /** A verified runtime file's bytes (from Core). */
  runtimeFile: (name: string) => Promise<ArrayBuffer>;
  /** Seconds allowed to download and start Python before the run's own clock starts. */
  startS?: number;
}

export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  'worker-src blob:',
  "connect-src 'none'",
  "img-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const FILE = /^[A-Za-z0-9._+-]{1,200}$/;

function frameScript(channel: string, nonce: string, workerSource: string) {
  // A classic worker: an opaque origin cannot start a module worker from a Blob.
  const w = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
  w.onmessage = (e) => {
    const d = e.data as Record<string, unknown>;
    window.parent.postMessage({ channel, nonce, msg: d }, '*');
  };
  w.onerror = (e) => {
    window.parent.postMessage({ channel, nonce, msg: { type: 'crash', message: String(e.message) } }, '*');
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data as { channel?: string; nonce?: string; msg?: unknown; transfer?: Transferable[] };
    if (!d || d.channel !== channel || d.nonce !== nonce) return;
    w.postMessage(d.msg, d.transfer ?? []);
  });
}

export function sandboxDocument(nonce: string): string {
  const worker = `(${pythonWorker.toString()})();`;
  const script = `(${frameScript.toString()})(${JSON.stringify(CHANNEL)},${JSON.stringify(nonce)},${JSON.stringify(worker)});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"></head><body><script>${script.replace(/<\/(script)/gi, '<\\/$1')}</script></body></html>`;
}

const nonceOf = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
};

type Msg =
  | { type: 'ready' }
  | { type: 'need'; file: string }
  | { type: 'progress'; stage: Stage }
  | { type: 'done'; outcome: unknown }
  | { type: 'crash'; message: string };

function parse(raw: unknown): Msg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'need':
      return typeof m.file === 'string' && FILE.test(m.file) ? { type: 'need', file: m.file } : null;
    case 'progress':
      return m.stage === 'loading' || m.stage === 'packages' || m.stage === 'running'
        ? { type: 'progress', stage: m.stage }
        : null;
    case 'done':
      return { type: 'done', outcome: m.outcome };
    case 'crash':
      return { type: 'crash', message: String(m.message ?? '').slice(0, 2000) };
    default:
      return null;
  }
}

export class PythonSandbox {
  private frame: HTMLIFrameElement | null = null;
  private nonce = '';
  private ready: Promise<void> | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;
  private unfeed: (() => void) | null = null;
  private handler: ((m: Msg) => void) | null = null;
  private busy = false;

  constructor(private readonly deps: SandboxDeps) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.nonce = nonceOf();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.title = 'Python sandbox';
    frame.className = 'python-sandbox';
    frame.src = FRAME_HOST_URL;
    this.unfeed = feedFrame(frame, sandboxDocument(this.nonce));
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The Python sandbox did not start.')), 15_000);
      this.listener = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || e.origin !== 'null') return;
        const d = e.data as { channel?: string; nonce?: string; msg?: unknown };
        if (!d || d.channel !== CHANNEL || d.nonce !== this.nonce) return;
        const m = parse(d.msg);
        if (!m) return;
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (m.type === 'need') void this.serve(m.file);
        else this.handler?.(m);
      };
      window.addEventListener('message', this.listener);
    });
    document.body.appendChild(frame);
    this.frame = frame;
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  private send(msg: unknown, transfer: Transferable[] = []) {
    this.frame?.contentWindow?.postMessage(
      { channel: CHANNEL, nonce: this.nonce, msg, transfer },
      '*',
      transfer,
    );
  }

  private async serve(file: string) {
    try {
      const bytes = await this.deps.runtimeFile(file);
      this.send({ type: 'file', file, bytes }, [bytes]);
    } catch (err) {
      this.send({ type: 'file', file, message: (err as Error).message });
    }
  }

  /** End the frame and its worker. */
  stop() {
    if (this.listener) window.removeEventListener('message', this.listener);
    this.listener = null;
    this.unfeed?.();
    this.unfeed = null;
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
    this.handler = null;
  }

  async run(input: RunInput, onStage: (s: Stage) => void, signal?: AbortSignal): Promise<RunOutcome> {
    if (this.busy) throw new Error('Python is already running here.');
    this.busy = true;
    try {
      onStage('starting');
      await this.start();
      return await new Promise<RunOutcome>((resolve) => {
        let clock: ReturnType<typeof setTimeout> | null = null;
        const startS = this.deps.startS ?? INTERPRETER_LIMITS.startS;
        const fail = (kind: 'timeout' | 'runtime' | 'cancelled', message: string) => {
          if (clock) clearTimeout(clock);
          this.stop();
          resolve({
            ok: false,
            stdout: '',
            stderr: '',
            figures: [],
            error: { kind, message },
            duration_ms: 0,
            truncated: false,
          });
        };
        const startClock = setTimeout(
          () => fail('runtime', `Python did not start within ${startS} seconds.`),
          startS * 1000,
        );
        signal?.addEventListener('abort', () => fail('cancelled', 'The run was stopped.'), { once: true });
        this.handler = (m) => {
          if (m.type === 'progress') {
            onStage(m.stage);
            if (m.stage === 'running' && !clock) {
              clearTimeout(startClock);
              clock = setTimeout(
                () => fail('timeout', `The code was stopped after ${input.timeoutS} seconds.`),
                input.timeoutS * 1000,
              );
            }
          } else if (m.type === 'done') {
            clearTimeout(startClock);
            if (clock) clearTimeout(clock);
            const parsed = InterpreterOutcome.omit({ client_id: true }).safeParse(m.outcome);
            this.handler = null;
            resolve(
              parsed.success
                ? parsed.data
                : {
                    ok: false,
                    stdout: '',
                    stderr: '',
                    figures: [],
                    error: {
                      kind: 'runtime',
                      message: 'Python answered in a shape NVX Ancile does not accept.',
                    },
                    duration_ms: 0,
                    truncated: false,
                  },
            );
          } else if (m.type === 'crash') {
            clearTimeout(startClock);
            fail('runtime', m.message || 'The Python worker stopped unexpectedly.');
          }
        };
        const transfer = input.files.map((f) => f.bytes);
        this.send(
          {
            type: 'run',
            code: input.code,
            files: input.files,
            memoryMb: input.memoryMb,
            outputChars: INTERPRETER_LIMITS.outputChars,
            maxFigures: INTERPRETER_LIMITS.figures,
          },
          transfer,
        );
      });
    } finally {
      this.busy = false;
    }
  }
}
