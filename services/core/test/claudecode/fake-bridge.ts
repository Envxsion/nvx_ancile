/**
 * A fake Claude bridge for Core's tests: an in-process WebSocket server
 * that speaks the bridge protocol over fixture sessions. No SDK, no
 * download, no Claude Code.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { BridgeLauncher } from '../../src/claudecode/bridge';
import type { CcSessionInfo, CcSessionMessage } from '../../src/claudecode/bridge-protocol';

export interface FakeSession {
  info: CcSessionInfo;
  chain: CcSessionMessage[];
  subagents?: Record<string, CcSessionMessage[]>;
}

export interface FakeWorld {
  sessions: Map<string, FakeSession>;
  /** When set, every data op fails as if the SDK could not load. */
  sdkError?: string;
  launches: number;
  requests: string[];
}

export function world(sessions: FakeSession[] = []): FakeWorld {
  return { sessions: new Map(sessions.map((s) => [s.info.sessionId, s])), launches: 0, requests: [] };
}

export function fakeLauncher(w: FakeWorld): BridgeLauncher & { close(): Promise<void> } {
  let servers: WebSocketServer[] = [];
  const launch = async () => {
    w.launches++;
    const token = `tok-${w.launches}-${'x'.repeat(24)}`;
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info, done) => done(info.req.headers.authorization === `Bearer ${token}`, 401),
    });
    servers.push(wss);
    await new Promise<void>((r) => wss.once('listening', () => r()));
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((r) => {
      exit = r;
    });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const req = JSON.parse(String(raw)) as { id: number; op: string; params?: Record<string, unknown> };
        w.requests.push(req.op);
        const ok = (result: unknown) => ws.send(JSON.stringify({ id: req.id, ok: true, result }));
        const fail = (code: string, message: string) =>
          ws.send(JSON.stringify({ id: req.id, ok: false, error: { code, message } }));
        const p = req.params ?? {};
        const page = <T>(xs: T[]) => {
          const off = Number(p.offset ?? 0);
          return p.limit === undefined ? xs.slice(off) : xs.slice(off, off + Number(p.limit));
        };
        if (req.op === 'hello')
          return ok({
            protocol: 1,
            bridge: 'fake',
            sdk: { ready: !w.sdkError, version: '0.3.296', error: w.sdkError ?? null },
          });
        if (req.op === 'status.sdk')
          return ok({
            ready: !w.sdkError,
            version: w.sdkError ? null : '0.3.296',
            error: w.sdkError ?? null,
          });
        if (w.sdkError) return fail('sdk_unavailable', w.sdkError);
        const s = w.sessions.get(String(p.session_id));
        switch (req.op) {
          case 'sessions.list':
            return ok([...w.sessions.values()].map((x) => x.info));
          case 'sessions.info':
            return ok(s?.info ?? null);
          case 'sessions.messages':
            return ok(page(s?.chain ?? []));
          case 'subagents.list':
            return ok(Object.keys(s?.subagents ?? {}));
          case 'subagents.messages':
            return ok(page(s?.subagents?.[String(p.agent_id)] ?? []));
          default:
            return fail('unknown_op', req.op);
        }
      });
    });
    const port = (wss.address() as AddressInfo).port;
    return {
      url: `ws://127.0.0.1:${port}`,
      token,
      exited,
      stop: () => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        exit();
      },
    };
  };
  return Object.assign(launch, {
    close: async () => {
      for (const s of servers) {
        for (const c of s.clients) c.terminate();
        s.close();
      }
      servers = [];
    },
  });
}

/* ---- fixture builders --------------------------------------------------- */

let clock = Date.UTC(2026, 9, 1, 9, 0, 0);
const ts = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

export const user = (
  uuid: string,
  text: string,
  extra: Partial<CcSessionMessage> = {},
): CcSessionMessage => ({
  type: 'user',
  uuid,
  session_id: 's',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  timestamp: ts(),
  ...extra,
});

export const assistant = (
  uuid: string,
  content: unknown[],
  extra: { id?: string; model?: string; usage?: Record<string, number> } = {},
): CcSessionMessage => ({
  type: 'assistant',
  uuid,
  session_id: 's',
  message: {
    role: 'assistant',
    id: extra.id ?? `api-${uuid}`,
    model: extra.model ?? 'claude-opus-5-5',
    content,
    ...(extra.usage && { usage: extra.usage }),
  },
  parent_tool_use_id: null,
  timestamp: ts(),
});

export const toolResult = (
  uuid: string,
  callId: string,
  content: unknown,
  isError = false,
): CcSessionMessage => ({
  type: 'user',
  uuid,
  session_id: 's',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: callId, content, is_error: isError }],
  },
  parent_tool_use_id: null,
  timestamp: ts(),
});

export const info = (id: string, extra: Partial<CcSessionInfo> = {}): CcSessionInfo => ({
  sessionId: id,
  summary: `Session ${id}`,
  lastModified: Date.UTC(2026, 9, 1, 10, 0, 0),
  ...extra,
});
