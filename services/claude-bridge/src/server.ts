/**
 * ------------------------------------------------------------------
 *  Title    |  Bridge server
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · src/protocol.ts
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Answer Core's requests about Claude Code sessions by
 *           |  calling Anthropic's Agent SDK, over a WebSocket on
 *           |  127.0.0.1 only.
 *  How      |  MIT, a separate program; Core talks to it over a local
 *           |  WebSocket. A connection must carry Core's per-launch
 *           |  bearer token and no browser Origin; anything else is
 *           |  refused before the upgrade. The first request must be
 *           |  `hello`. The session-reading ops are thin, read-only
 *           |  calls into the SDK. Protocol 2's live-session ops run
 *           |  through SessionManager (src/session.ts), whose events
 *           |  are pushed on the connection that opened the session;
 *           |  a closed connection closes its sessions.
 *  Note     |  Logs name the op and timings, never message contents.
 * ------------------------------------------------------------------
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { type ErrorCode, OPS, PROTOCOLS, type Reply, type Request, SESSION_OPS } from './protocol';
import type { ClaudeAgentSdk } from './sdk-types';
import { type OpenParams, SessionError, SessionManager } from './session';
import { log } from './util';

export const BRIDGE_VERSION = '0.1.0';

export interface SdkSource {
  load(): Promise<ClaudeAgentSdk>;
  status(): { ready: boolean; version: string | null; error: string | null };
  readonly busy?: boolean;
}

export interface BridgeServerOptions {
  token: string;
  sdk: SdkSource;
  host?: string;
  port?: number;
  /** Largest frame accepted from Core. */
  maxPayload?: number;
  /** Live sessions (tests pass their own). */
  sessions?: SessionManager;
}

class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const sameSecret = (a: string, b: string) => {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
};

const str = (v: unknown, name: string, required = true): string | undefined => {
  if (v === undefined || v === null) {
    if (required) throw new BridgeError('bad_request', `${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length > 4096)
    throw new BridgeError('bad_request', `${name} must be a string`);
  return v;
};
const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
    throw new BridgeError('bad_request', `${name} must be a whole number`);
  return v;
};
const dirOpt = (p: Record<string, unknown>) => {
  const dir = str(p.dir, 'dir', false);
  return dir ? { dir } : {};
};
const page = (p: Record<string, unknown>) => {
  const limit = num(p.limit, 'limit');
  const offset = num(p.offset, 'offset');
  return { ...(limit !== undefined && { limit }), ...(offset !== undefined && { offset }) };
};

/** Run one op. Exported for tests. */
export async function handle(
  sdkSource: SdkSource,
  op: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (op === 'status.sdk') {
    if (params.load === true) await sdkSource.load().catch(() => undefined);
    return { ...sdkSource.status(), loading: !!sdkSource.busy };
  }
  if (!(OPS as readonly string[]).includes(op))
    throw new BridgeError('unknown_op', `Unknown op ${op.slice(0, 60)}`);
  let sdk: ClaudeAgentSdk;
  try {
    sdk = await sdkSource.load();
  } catch (err) {
    throw new BridgeError('sdk_unavailable', (err as Error).message || 'The Agent SDK is not available');
  }
  switch (op) {
    case 'sessions.list':
      return sdk.listSessions({ ...dirOpt(params), ...page(params) });
    case 'sessions.info':
      return (
        (await sdk.getSessionInfo(str(params.session_id, 'session_id') as string, dirOpt(params))) ?? null
      );
    case 'sessions.messages':
      return sdk.getSessionMessages(str(params.session_id, 'session_id') as string, {
        ...dirOpt(params),
        ...page(params),
        ...(params.include_system === true && { includeSystemMessages: true }),
      });
    case 'subagents.list':
      return sdk.listSubagents(str(params.session_id, 'session_id') as string, dirOpt(params));
    case 'subagents.messages':
      return sdk.getSubagentMessages(
        str(params.session_id, 'session_id') as string,
        str(params.agent_id, 'agent_id') as string,
        { ...dirOpt(params), ...page(params) },
      );
    default:
      throw new BridgeError('unknown_op', `Unknown op ${op.slice(0, 60)}`);
  }
}

const obj = (v: unknown, name: string): Record<string, unknown> | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v))
    throw new BridgeError('bad_request', `${name} must be an object`);
  return v as Record<string, unknown>;
};

const strMap = (v: unknown, name: string): Record<string, string> | undefined => {
  const o = obj(v, name);
  if (!o) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) {
    if (typeof x !== 'string') throw new BridgeError('bad_request', `${name}.${k} must be a string`);
    out[k] = x;
  }
  return out;
};

/** session.open's parameters, checked. */
export function openParams(p: Record<string, unknown>): OpenParams {
  const servers = obj(p.mcp_servers, 'mcp_servers');
  const mcp: NonNullable<OpenParams['mcp_servers']> = {};
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const c = obj(raw, `mcp_servers.${name}`) ?? {};
    if (c.type !== 'http' || typeof c.url !== 'string')
      throw new BridgeError('bad_request', 'mcp_servers: only { type: "http", url, headers } is accepted');
    mcp[name] = {
      type: 'http',
      url: c.url,
      ...(c.headers !== undefined && { headers: strMap(c.headers, 'headers') ?? {} }),
    };
  }
  const opt = (k: string) => str(p[k], k, false);
  const big = (k: string) => {
    const v = p[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.length > 20_000)
      throw new BridgeError('bad_request', `${k} must be a string`);
    return v;
  };
  const env = p.env !== undefined ? strMap(p.env, 'env') : undefined;
  return {
    cwd: str(p.cwd, 'cwd') as string,
    path_to_cli: str(p.path_to_cli, 'path_to_cli') as string,
    ...(opt('session_id') && { session_id: opt('session_id') }),
    ...(opt('resume') && { resume: opt('resume') }),
    ...(p.fork === true && { fork: true }),
    ...(opt('resume_at') && { resume_at: opt('resume_at') }),
    ...(opt('model') && { model: opt('model') }),
    ...(opt('effort') && { effort: opt('effort') }),
    ...(opt('permission_mode') && { permission_mode: opt('permission_mode') }),
    ...(big('append_system_prompt') && { append_system_prompt: big('append_system_prompt') }),
    ...(Object.keys(mcp).length && { mcp_servers: mcp }),
    ...(env && { env }),
    ...(p.persist === false && { persist: false }),
  };
}

/** Run one live-session op for a connection. Exported for tests. */
export async function handleSession(
  sessions: SessionManager,
  op: string,
  params: Record<string, unknown>,
  push: (event: string, data: unknown) => void,
  owner: unknown,
): Promise<unknown> {
  try {
    switch (op) {
      case 'session.open':
        return await sessions.openSession(openParams(params), push, owner);
      case 'session.send': {
        const text = params.text;
        if (typeof text !== 'string' || !text) throw new BridgeError('bad_request', 'text is required');
        const images = Array.isArray(params.images)
          ? params.images.flatMap((i) => {
              const o = obj(i, 'images[]') ?? {};
              return typeof o.mime === 'string' && typeof o.data === 'string'
                ? [{ mime: o.mime, data: o.data }]
                : [];
            })
          : [];
        return sessions.send(params.handle, text, {
          ...(images.length && { images }),
          ...(typeof params.uuid === 'string' && { uuid: params.uuid }),
        });
      }
      case 'session.interrupt':
        return await sessions.interrupt(params.handle);
      case 'session.control':
        return await sessions.control(params.handle, params.op, obj(params.args, 'args') ?? {});
      case 'session.close':
        return sessions.close(params.handle);
      case 'session.permission_reply': {
        if (params.behavior !== 'allow' && params.behavior !== 'deny')
          throw new BridgeError('bad_request', 'behavior must be allow or deny');
        const updated = obj(params.updated_input, 'updated_input');
        return {
          delivered: sessions.reply(params.handle, params.request_id, {
            behavior: params.behavior,
            ...(updated && { updated_input: updated }),
            ...(typeof params.message === 'string' && { message: params.message.slice(0, 1000) }),
          }),
        };
      }
      default:
        throw new BridgeError('unknown_op', `Unknown op ${op.slice(0, 60)}`);
    }
  } catch (err) {
    if (err instanceof SessionError) throw new BridgeError(err.code, err.message);
    throw err;
  }
}

export interface RunningBridge {
  port: number;
  close(): Promise<void>;
}

export function startServer(opts: BridgeServerOptions): Promise<RunningBridge> {
  const wss = new WebSocketServer({
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 0,
    maxPayload: opts.maxPayload ?? 16 * 1024 * 1024,
    verifyClient: (info, done) => {
      const auth = info.req.headers.authorization ?? '';
      if (info.req.headers.origin) {
        log('warn', 'refused a connection with a browser origin');
        return done(false, 403, 'Forbidden');
      }
      if (!sameSecret(auth, `Bearer ${opts.token}`)) {
        log('warn', 'refused a connection without the right token');
        return done(false, 401, 'Unauthorized');
      }
      done(true);
    },
  });

  const sessions =
    opts.sessions ?? new SessionManager({ load: () => opts.sdk.load(), version: BRIDGE_VERSION });

  wss.on('connection', (ws: WebSocket) => {
    let greeted = false;
    let protocol = 0;
    const send = (r: Reply) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(r));
    };
    const push = (event: string, data: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event, data }));
    };
    ws.on('close', () => {
      const n = sessions.closeOwnedBy(ws);
      if (n) log('info', 'closed the live sessions of a connection that went away', { sessions: n });
    });
    ws.on('message', async (raw) => {
      let req: Request;
      try {
        req = JSON.parse(String(raw)) as Request;
        if (!req || typeof req !== 'object' || typeof req.op !== 'string' || req.id === undefined)
          throw new Error('not a request');
      } catch {
        send({ id: null, ok: false, error: { code: 'bad_request', message: 'Send { id, op, params }' } });
        return;
      }
      const started = Date.now();
      const trace_id = typeof req.trace_id === 'string' ? req.trace_id.slice(0, 64) : undefined;
      try {
        if (req.op === 'hello') {
          const want = req.params?.protocol;
          if (typeof want !== 'number' || !(PROTOCOLS as readonly number[]).includes(want)) {
            send({
              id: req.id,
              ok: false,
              error: {
                code: 'protocol_mismatch',
                message: `This bridge speaks protocol ${PROTOCOLS.join(' or ')}`,
              },
            });
            ws.close(1002, 'protocol mismatch');
            return;
          }
          greeted = true;
          protocol = want;
          send({
            id: req.id,
            ok: true,
            result: { protocol: want, bridge: BRIDGE_VERSION, sdk: opts.sdk.status() },
          });
          return;
        }
        if (!greeted) throw new BridgeError('hello_first', 'Send hello first');
        const params = (req.params ?? {}) as Record<string, unknown>;
        let result: unknown;
        if ((SESSION_OPS as readonly string[]).includes(req.op)) {
          if (protocol < 2) throw new BridgeError('unknown_op', 'Live sessions need protocol 2');
          result = await handleSession(sessions, req.op, params, push, ws);
        } else result = await handle(opts.sdk, req.op, params);
        send({ id: req.id, ok: true, result });
        log('debug', 'answered', { op: req.op, ms: Date.now() - started, trace_id });
      } catch (err) {
        const code: ErrorCode = err instanceof BridgeError ? err.code : 'failed';
        const message = ((err as Error).message || 'Failed').slice(0, 500);
        log('warn', 'request failed', { op: req.op, code, ms: Date.now() - started, trace_id });
        send({ id: req.id, ok: false, error: { code, message } });
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            sessions.closeAll();
            for (const c of wss.clients) c.terminate();
            wss.close(() => r());
          }),
      });
    });
  });
}
