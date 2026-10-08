/**
 * ------------------------------------------------------------------
 *  Title    |  SSE helpers
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One way to stream: every event carries its seq as the
 *           |  SSE id, so the browser's automatic reconnect sends
 *           |  Last-Event-ID and we resume exactly there. A comment
 *           |  heartbeat every 15 s keeps proxies from closing idle
 *           |  streams.
 * ------------------------------------------------------------------
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

export function lastEventId(c: Context): number {
  const raw = c.req.header('last-event-id') ?? c.req.query('after') ?? '0';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function sseStream<E extends { seq: number; type: string }>(
  c: Context,
  attach: (emit: (e: E) => void) => (() => void) | Promise<() => void>,
  opts: { heartbeatMs?: number } = {},
) {
  return streamSSE(c, async (stream) => {
    const queue: E[] = [];
    let wake: (() => void) | null = null;
    const emit = (e: E) => {
      queue.push(e);
      wake?.();
    };
    const detach = await attach(emit);
    stream.onAbort(() => {
      detach();
      wake?.();
    });
    const heartbeat = setInterval(() => void stream.write(': keep-alive\n\n'), opts.heartbeatMs ?? 15_000);
    try {
      while (!stream.aborted) {
        const next = queue.shift();
        if (next) {
          // No `event:` field: EventSource.onmessage only receives unnamed
          // events, and the type is already inside the JSON.
          await stream.writeSSE({ id: String(next.seq), data: JSON.stringify(next) });
          if (next.type === 'done') break;
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
      }
    } finally {
      clearInterval(heartbeat);
      detach();
    }
  });
}
