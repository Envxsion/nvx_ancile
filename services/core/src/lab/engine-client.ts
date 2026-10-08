/**
 * ------------------------------------------------------------------
 *  Title    |  Agent Engine client
 *  Ref      |  DESIGN.md §1.4 (the lab lane), vendor/opencode/PATCHES.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The few calls Core makes to the lab's engine (our
 *           |  opencode fork, headless): open a session in a folder,
 *           |  send it a prompt, stop it, answer its permission
 *           |  requests, read its changes, undo them, and follow its
 *           |  event stream.
 *  How      |  HTTP with Basic auth (the engine's server password),
 *           |  through tracedFetch so a lab run is one trace. The event
 *           |  stream is read as SSE and reconnects with backoff; each
 *           |  (re)connect calls onConnect so the mirror can catch up on
 *           |  what it missed while the stream was down.
 * ------------------------------------------------------------------
 */

import { tracedFetch } from '../context';
import { logFor } from '../obs/logger';

const log = logFor('lab');

export interface EngineEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface EngineSession {
  id: string;
  directory: string;
}

export interface FileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

export interface PendingPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
}

/** One message of a session with its parts, as GET /session/:id/message returns it. */
export interface EngineMessage {
  info: {
    id: string;
    role: 'user' | 'assistant';
    time?: { created?: number; completed?: number };
    tokens?: { input?: number; output?: number };
    cost?: number;
    error?: { name?: string; data?: { message?: string } };
  };
  parts: Record<string, unknown>[];
}

export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface Engine {
  createSession(directory: string, title: string): Promise<EngineSession>;
  prompt(sessionId: string, directory: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** Permission routes are scoped to the project folder the session works in. */
  reply(requestId: string, directory: string, reply: 'once' | 'reject', message?: string): Promise<void>;
  pendingPermissions(directory: string): Promise<PendingPermission[]>;
  diff(sessionId: string, messageId?: string): Promise<FileDiff[]>;
  revert(sessionId: string, messageId: string): Promise<void>;
  /** Busy sessions in a folder; a session that is not listed is idle. */
  statuses(directory: string): Promise<Record<string, { type: string }>>;
  messages(sessionId: string, directory: string): Promise<EngineMessage[]>;
  /** Follow every session's events until the signal aborts; onConnect runs on each (re)connect. */
  follow(onEvent: (e: EngineEvent) => void, signal: AbortSignal, onConnect?: () => void): Promise<void>;
}

export class HttpEngine implements Engine {
  private readonly auth: string;

  constructor(
    private readonly baseUrl: string,
    password: string,
  ) {
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await tracedFetch(url, {
      method,
      headers: {
        authorization: this.auth,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new EngineError(
        res.status,
        `${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async createSession(directory: string, title: string): Promise<EngineSession> {
    const s = await this.call<{ id: string; directory: string }>(
      'POST',
      '/session',
      { title },
      { directory },
    );
    return { id: s.id, directory: s.directory };
  }

  async prompt(sessionId: string, directory: string, text: string): Promise<void> {
    await this.call(
      'POST',
      `/session/${sessionId}/prompt_async`,
      { parts: [{ type: 'text', text }] },
      { directory },
    );
  }

  async abort(sessionId: string): Promise<void> {
    await this.call('POST', `/session/${sessionId}/abort`);
  }

  async reply(
    requestId: string,
    directory: string,
    reply: 'once' | 'reject',
    message?: string,
  ): Promise<void> {
    await this.call(
      'POST',
      `/permission/${requestId}/reply`,
      { reply, ...(message && { message }) },
      { directory },
    );
  }

  async pendingPermissions(directory: string): Promise<PendingPermission[]> {
    return this.call<PendingPermission[]>('GET', '/permission', undefined, { directory });
  }

  async diff(sessionId: string, messageId?: string): Promise<FileDiff[]> {
    return this.call<FileDiff[]>(
      'GET',
      `/session/${sessionId}/diff`,
      undefined,
      messageId ? { messageID: messageId } : undefined,
    );
  }

  async revert(sessionId: string, messageId: string): Promise<void> {
    await this.call('POST', `/session/${sessionId}/revert`, { messageID: messageId });
  }

  async statuses(directory: string): Promise<Record<string, { type: string }>> {
    return (
      (await this.call<Record<string, { type: string }>>('GET', '/session/status', undefined, {
        directory,
      })) ?? {}
    );
  }

  async messages(sessionId: string, directory: string): Promise<EngineMessage[]> {
    return (
      (await this.call<EngineMessage[]>('GET', `/session/${sessionId}/message`, undefined, { directory })) ??
      []
    );
  }

  async follow(
    onEvent: (e: EngineEvent) => void,
    signal: AbortSignal,
    onConnect?: () => void,
  ): Promise<void> {
    let backoff = 500;
    while (!signal.aborted) {
      try {
        const res = await fetch(new URL('/global/event', this.baseUrl), {
          headers: { authorization: this.auth, accept: 'text/event-stream' },
          signal,
        });
        if (!res.ok || !res.body)
          throw new EngineError(res.status, `the event stream answered ${res.status}`);
        backoff = 500;
        onConnect?.();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let cut = buf.indexOf('\n\n');
          while (cut >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (data) {
              try {
                const raw = JSON.parse(data) as { payload?: EngineEvent } & Partial<EngineEvent>;
                const e = raw.payload ?? (raw as EngineEvent);
                if (e?.type) onEvent({ type: e.type, properties: e.properties ?? {} });
              } catch {
                /* a malformed frame is skipped */
              }
            }
            cut = buf.indexOf('\n\n');
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        log.warn({ err: (err as Error).message }, 'lab event stream dropped; reconnecting');
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 10_000);
    }
  }
}
