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
 *  Note     |  Phase 2 adds session.start / session.send /
 *           |  session.interrupt / session.control and pushed
 *           |  session events on the same socket.
 * ------------------------------------------------------------------
 */

export const PROTOCOL = 1;

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
  | 'failed';
