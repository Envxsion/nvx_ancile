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
 *           |  `hello`. Every other op is a thin, read-only call into
 *           |  the SDK: the bridge never writes to a session.
 *  Note     |  Logs name the op and timings, never message contents.
 * ------------------------------------------------------------------
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { type ErrorCode, OPS, PROTOCOL, type Reply, type Request } from './protocol';
import type { ClaudeAgentSdk } from './sdk-types';
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

  wss.on('connection', (ws: WebSocket) => {
    let greeted = false;
    const send = (r: Reply) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(r));
    };
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
          if (want !== PROTOCOL) {
            send({
              id: req.id,
              ok: false,
              error: { code: 'protocol_mismatch', message: `This bridge speaks protocol ${PROTOCOL}` },
            });
            ws.close(1002, 'protocol mismatch');
            return;
          }
          greeted = true;
          send({
            id: req.id,
            ok: true,
            result: { protocol: PROTOCOL, bridge: BRIDGE_VERSION, sdk: opts.sdk.status() },
          });
          return;
        }
        if (!greeted) throw new BridgeError('hello_first', 'Send hello first');
        const result = await handle(opts.sdk, req.op, (req.params ?? {}) as Record<string, unknown>);
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
            for (const c of wss.clients) c.terminate();
            wss.close(() => r());
          }),
      });
    });
  });
}
