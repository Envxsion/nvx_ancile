/**
 * ------------------------------------------------------------------
 *  Title    |  Claude bridge client and supervisor
 *  Ref      |  docs/claude-code.md · services/claude-bridge
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Start the Claude bridge when Claude Code is used, talk
 *           |  to it over its local WebSocket, and stop it when idle.
 *  How      |  The bridge is a separate MIT program that loads
 *           |  Anthropic's Agent SDK; Core (GPL) never imports the SDK,
 *           |  only exchanges plain JSON with the bridge. Core starts it
 *           |  with Node, a per-launch random token and a minimal
 *           |  environment (no Ancile secrets), waits for its ready
 *           |  line, connects to 127.0.0.1 with the token, and says
 *           |  hello. A crash is restarted on the next request, with
 *           |  backoff; five idle minutes stop it, unless live sessions
 *           |  are open. Pushed events (live sessions) go to whoever
 *           |  listens (claudecode/live.ts); a bridge that goes away
 *           |  is announced as bridge.closed.
 *  Note     |  Every request has a timeout (resilience withTimeout).
 * ------------------------------------------------------------------
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { withTimeout } from '@nvx/resilience';
import { WebSocket } from 'ws';
import { currentContext } from '../context';
import { assertClaudeCodeAllowed } from '../gateway/e2e-guard';
import { logFor } from '../obs/logger';
import {
  BRIDGE_PROTOCOL,
  BRIDGE_READY_TAG,
  type BridgeSdkStatus,
  type CcSessionInfo,
  type CcSessionMessage,
  type LiveBridge,
  type LiveControlOp,
  type LiveEvent,
  type LiveOpenParams,
  type LivePermissionReply,
  type Paging,
  type SessionSource,
} from './bridge-protocol';

const log = logFor('claude-bridge');

/** A running bridge: where it listens and how to stop it. */
export interface LaunchedBridge {
  url: string;
  token: string;
  stop(): void;
  /** Resolves when the bridge exits by itself. */
  exited: Promise<void>;
}

export type BridgeLauncher = () => Promise<LaunchedBridge>;

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** What the bridge may see of this machine: enough to find files, a home and the network. */
const BRIDGE_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'SystemDrive',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'USERNAME',
  'XDG_CONFIG_HOME',
  'CLAUDE_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

/** Find the bridge next to Core: the built program, or its source in a checkout. */
export function findBridgeEntry(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  const fromSource = /\.ts$/.test(fileURLToPath(import.meta.url));
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const candidates = fromSource
      ? [join(dir, 'claude-bridge', 'src', 'main.ts'), join(dir, 'claude-bridge', 'dist', 'main.js')]
      : [join(dir, 'claude-bridge', 'dist', 'main.js')];
    for (const c of candidates) if (existsSync(c)) return c;
    dir = dirname(dir);
  }
  return null;
}

export interface ProcessLauncherOptions {
  dataDir: string;
  entry?: string | null;
  logLevel?: string;
  readyTimeoutMs?: number;
}

/** Start the bridge as a child process of Core. */
export function processLauncher(opts: ProcessLauncherOptions): BridgeLauncher {
  let lastEntry: string | null = null;
  return async () => {
    const entry = opts.entry ?? findBridgeEntry() ?? lastEntry;
    if (!entry) throw new BridgeError('missing', 'The Claude bridge program is not installed next to Core');
    // Found before but gone or locked now: name the file, so the error can name the folder to allow.
    try {
      accessSync(entry, constants.R_OK);
    } catch (err) {
      throw new BridgeError(
        'missing',
        `${(err as NodeJS.ErrnoException).code ?? 'ENOENT'}: cannot open '${entry}'`,
      );
    }
    lastEntry = entry;
    const token = randomBytes(32).toString('base64url');
    const env: Record<string, string> = {};
    for (const k of BRIDGE_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    env.ANCILE_BRIDGE_TOKEN = token;
    env.ANCILE_BRIDGE_DATA_DIR = opts.dataDir;
    env.ANCILE_LOG_LEVEL = opts.logLevel ?? 'info';
    const args = entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx'), entry] : [entry];
    const child: ChildProcess = spawn(process.execPath, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));

    // The bridge's own JSON log lines, folded into Core's log.
    if (child.stderr)
      createInterface({ input: child.stderr }).on('line', (line) => {
        try {
          const j = JSON.parse(line) as { level?: string; msg?: string } & Record<string, unknown>;
          const { level, msg, time: _t, service: _s, ...rest } = j;
          const fn =
            level === 'error'
              ? log.error
              : level === 'warn'
                ? log.warn
                : level === 'debug'
                  ? log.debug
                  : log.info;
          fn.call(log, rest, `bridge: ${String(msg ?? '')}`);
        } catch {
          log.debug({ line: line.slice(0, 300) }, 'bridge output');
        }
      });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new BridgeError('start_timeout', 'The Claude bridge did not start in time'));
      }, opts.readyTimeoutMs ?? 20_000);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(new BridgeError('start_failed', `The Claude bridge could not start: ${e.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new BridgeError('start_failed', `The Claude bridge stopped while starting (exit ${code})`));
      });
      if (!child.stdout) return reject(new BridgeError('start_failed', 'No output from the Claude bridge'));
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith(BRIDGE_READY_TAG)) return;
        try {
          const ready = JSON.parse(line.slice(BRIDGE_READY_TAG.length)) as { port: number };
          clearTimeout(timer);
          resolve(ready.port);
        } catch {
          /* not the ready line */
        }
      });
    });
    return {
      url: `ws://127.0.0.1:${port}`,
      token,
      exited,
      stop: () => {
        // Closing stdin asks it to exit; a kill makes sure.
        child.stdin?.end();
        setTimeout(() => child.kill(), 2000).unref();
      },
    };
  };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface BridgeClientOptions {
  launch: BridgeLauncher;
  idleMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

const PAGE = 500;

/** Core's connection to the bridge. Implements SessionSource. */
export class BridgeClient implements SessionSource, LiveBridge {
  private readonly listeners = new Set<(e: LiveEvent) => void>();
  private keepAlive: () => boolean = () => false;
  private ws: WebSocket | null = null;
  private launched: LaunchedBridge | null = null;
  private starting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private retryAt = 0;
  private lastStatus: BridgeSdkStatus | null = null;
  private lastStartError: string | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: BridgeClientOptions) {
    this.now = opts.now ?? Date.now;
  }

  lastSdkStatus(): BridgeSdkStatus | null {
    if (this.lastStatus) return this.lastStatus;
    return this.lastStartError ? { ready: false, version: null, error: this.lastStartError } : null;
  }

  get running(): boolean {
    return !!this.ws;
  }

  private async connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.now() < this.retryAt)
      throw new BridgeError(
        'backoff',
        this.lastStartError ?? 'The Claude bridge is restarting after a failure',
      );
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<WebSocket> {
    // The test profile never starts the bridge (gateway/e2e-guard.ts).
    assertClaudeCodeAllowed();
    try {
      const b = await this.opts.launch();
      this.launched = b;
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(b.url, {
          headers: { authorization: `Bearer ${b.token}` },
          maxPayload: 512 * 1024 * 1024,
        });
        sock.once('open', () => resolve(sock));
        sock.once('error', (e) => reject(e));
        sock.once('unexpected-response', (_q, res) =>
          reject(new Error(`the bridge refused: ${res.statusCode}`)),
        );
      });
      ws.on('message', (raw) => this.onMessage(String(raw)));
      ws.on('close', () => this.onClose());
      ws.on('error', (e) => log.warn({ err: e.message }, 'Claude bridge socket error'));
      this.ws = ws;
      void b.exited.then(() => {
        if (this.launched === b) this.onClose(true);
      });
      const hello = (await this.call('hello', { protocol: BRIDGE_PROTOCOL, client: 'ancile-core' })) as {
        protocol: number;
        sdk: BridgeSdkStatus;
      };
      if (hello.protocol !== BRIDGE_PROTOCOL)
        throw new BridgeError('protocol_mismatch', 'The Claude bridge speaks another protocol');
      this.lastStatus = hello.sdk;
      this.failures = 0;
      this.lastStartError = null;
      log.info({}, 'Claude bridge started');
      return ws;
    } catch (err) {
      this.failures++;
      this.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** (this.failures - 1));
      this.lastStartError = (err as Error).message;
      this.stop();
      throw err instanceof BridgeError ? err : new BridgeError('start_failed', (err as Error).message);
    }
  }

  private onMessage(raw: string) {
    let m: { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id !== 'number') {
      const push = m as unknown as { event?: unknown; data?: unknown };
      if (typeof push.event === 'string') this.emit({ event: push.event, data: push.data } as LiveEvent);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new BridgeError(m.error?.code ?? 'failed', m.error?.message ?? 'The Claude bridge failed'));
  }

  private emit(e: LiveEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        log.warn({ err: (err as Error).message, event: e.event }, 'a bridge event listener failed');
      }
    }
  }

  onEvent(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setKeepAlive(fn: () => boolean): void {
    this.keepAlive = fn;
  }

  private onClose(crashed = false) {
    const had = !!this.ws;
    if (crashed) {
      this.failures++;
      this.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** (this.failures - 1));
      log.warn({}, 'Claude bridge stopped unexpectedly');
    }
    this.ws = null;
    this.launched = null;
    for (const [, p] of this.pending) p.reject(new BridgeError('closed', 'The Claude bridge closed'));
    this.pending.clear();
    if (had) this.emit({ event: 'bridge.closed', data: {} });
  }

  private call(op: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new BridgeError('closed', 'The Claude bridge is not running'));
    const id = this.nextId++;
    const trace_id = currentContext()?.traceId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, op, params, ...(trace_id && { trace_id }) }), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** One request, starting the bridge if needed. */
  async request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.connect();
    this.touch();
    try {
      return (await withTimeout(() => this.call(op, params), {
        ms: timeoutMs ?? this.opts.requestTimeoutMs ?? 180_000,
      })) as T;
    } finally {
      this.touch();
    }
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        if (this.pending.size === 0 && !this.keepAlive()) {
          log.info({}, 'Claude bridge idle: stopping it');
          this.stop();
        } else this.touch();
      },
      this.opts.idleMs ?? 5 * 60_000,
    );
    this.idleTimer.unref();
  }

  /**
   * The computer woke from sleep (system/wake.ts): check the socket still
   * answers; if not, drop it (live sessions hear bridge.closed) and, while
   * live sessions are open, connect again now. A backoff from before the
   * sleep no longer applies.
   */
  async wake(timeoutMs = 5_000): Promise<'ok' | 'reconnected' | 'idle'> {
    this.failures = 0;
    this.retryAt = 0;
    if (this.ws) {
      try {
        await withTimeout(() => this.call('status.sdk', { load: false }), { ms: timeoutMs });
        return 'ok';
      } catch {
        log.info({}, 'Claude bridge did not answer after sleep: reconnecting');
        this.stop();
      }
    }
    if (!this.keepAlive()) return 'idle';
    await this.connect();
    return 'reconnected';
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const b = this.launched;
    const ws = this.ws;
    this.launched = null;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    b?.stop();
    for (const [, p] of this.pending) p.reject(new BridgeError('closed', 'The Claude bridge stopped'));
    this.pending.clear();
    if (ws) this.emit({ event: 'bridge.closed', data: {} });
  }

  /* ---- live sessions (protocol 2) ---------------------------------------- */

  open(p: LiveOpenParams): Promise<{ handle: string }> {
    return this.request('session.open', { ...p }, 120_000);
  }

  async send(
    handle: string,
    text: string,
    opts: { uuid?: string; images?: { mime: string; data: string }[] } = {},
  ) {
    await this.request('session.send', { handle, text, ...opts }, 60_000);
  }

  async interrupt(handle: string) {
    await this.request('session.interrupt', { handle }, 30_000);
  }

  control<T = unknown>(handle: string, op: LiveControlOp, args: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>('session.control', { handle, op, args }, 60_000);
  }

  async close(handle: string) {
    await this.request('session.close', { handle }, 30_000);
  }

  async reply(handle: string, requestId: string, r: LivePermissionReply) {
    await this.request('session.permission_reply', { handle, request_id: requestId, ...r }, 30_000);
  }

  async sdkStatus(load = false): Promise<BridgeSdkStatus> {
    const s = await this.request<BridgeSdkStatus>('status.sdk', { load }, load ? 300_000 : 30_000);
    this.lastStatus = s;
    return s;
  }

  async listSessions(opts: Paging & { dir?: string } = {}): Promise<CcSessionInfo[]> {
    const r = await this.request<CcSessionInfo[]>('sessions.list', { ...opts });
    // The SDK answered, so it is ready; ask once for its version.
    if (!this.lastStatus?.ready || !this.lastStatus.version) {
      this.lastStatus = { ready: true, version: this.lastStatus?.version ?? null, error: null };
      void this.sdkStatus().catch(() => undefined);
    }
    return Array.isArray(r) ? r : [];
  }

  async sessionInfo(sessionId: string): Promise<CcSessionInfo | null> {
    return (await this.request<CcSessionInfo | null>('sessions.info', { session_id: sessionId })) ?? null;
  }

  async sessionMessages(sessionId: string, page: Paging = {}): Promise<CcSessionMessage[]> {
    if (page.limit !== undefined)
      return this.request('sessions.messages', { session_id: sessionId, ...page });
    return this.allPages((p) => this.request('sessions.messages', { session_id: sessionId, ...p }));
  }

  async listSubagents(sessionId: string): Promise<string[]> {
    const r = await this.request<string[]>('subagents.list', { session_id: sessionId });
    return Array.isArray(r) ? r : [];
  }

  async subagentMessages(sessionId: string, agentId: string, page: Paging = {}): Promise<CcSessionMessage[]> {
    if (page.limit !== undefined)
      return this.request('subagents.messages', { session_id: sessionId, agent_id: agentId, ...page });
    return this.allPages((p) =>
      this.request('subagents.messages', { session_id: sessionId, agent_id: agentId, ...p }),
    );
  }

  /** Read a long transcript a page at a time, so no one frame is huge. */
  private async allPages(get: (p: Paging) => Promise<CcSessionMessage[]>): Promise<CcSessionMessage[]> {
    const out: CcSessionMessage[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await get({ limit: PAGE, offset });
      if (!Array.isArray(page)) break;
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
  }
}
