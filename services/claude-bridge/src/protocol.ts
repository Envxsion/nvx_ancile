/**
 * ------------------------------------------------------------------
 *  Title    |  Bridge protocol
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · docs/claude-code.md
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  The JSON spoken between NVX Ancile Core and this bridge
 *           |  over one local WebSocket.
 *  How      |  Requests  { id, op, params?, trace_id? }
 *           |  Replies   { id, ok: true, result } or
 *           |            { id, ok: false, error: { code, message } }
 *           |  Pushes    { event, data } (no id; phase 2 streams)
 *           |  The first request must be `hello` with the protocol
 *           |  version; a mismatch is refused and the socket closed.
 *  Note     |  Protocol 2 adds live sessions (src/session.ts):
 *           |  session.open / send / interrupt / control / close /
 *           |  permission_reply, and pushed events session.message,
 *           |  session.permission and session.state. Protocol 1
 *           |  clients still get the read-only ops.
 * ------------------------------------------------------------------
 */

export const PROTOCOL = 2;
/** Protocol versions this bridge still answers. */
export const PROTOCOLS = [1, 2] as const;

/** Printed on stdout once listening: the line starts with this tag, then JSON. */
export const READY_TAG = 'ANCILE_BRIDGE_READY';

export const OPS = [
  'hello',
  'status.sdk',
  'sessions.list',
  'sessions.info',
  'sessions.messages',
  'subagents.list',
  'subagents.messages',
] as const;

/** Live-session ops (protocol 2). */
export const SESSION_OPS = [
  'session.open',
  'session.send',
  'session.interrupt',
  'session.control',
  'session.close',
  'session.permission_reply',
] as const;
export type Op = (typeof OPS)[number];

export interface Request {
  id: number | string;
  op: string;
  params?: Record<string, unknown>;
  trace_id?: string;
}

export type Reply =
  | { id: number | string; ok: true; result: unknown }
  | { id: number | string | null; ok: false; error: { code: string; message: string } };

export interface Push {
  event: string;
  data: unknown;
}

export type ErrorCode =
  | 'bad_request'
  | 'unknown_op'
  | 'protocol_mismatch'
  | 'hello_first'
  | 'sdk_unavailable'
  | 'unknown_handle'
  | 'failed';
