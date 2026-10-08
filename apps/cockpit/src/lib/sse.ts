/**
 * ------------------------------------------------------------------
 *  Title    |  Resumable event streams
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Subscribe to /runs/:id/stream and /events and never
 *           |  miss an event: close the laptop mid-answer, open it,
 *           |  and the stream carries on from the last seq.
 *  How      |  EventSource does not let us set Last-Event-ID on a new
 *           |  connection, so the last seq rides as ?after=. Reconnect
 *           |  uses full-jitter backoff (250 ms base, 10 s cap) and
 *           |  resets after a healthy minute.
 *  Note     |  Events are validated with the contract schema; one bad
 *           |  event is reported and skipped, not fatal. A restarted
 *           |  Core numbers /events from zero again; the first event of
 *           |  a new connection resets the cursor.
 * ------------------------------------------------------------------
 */

import type { z } from 'zod';

export type StreamState = 'connecting' | 'open' | 'retrying' | 'closed';

export interface StreamOptions<T> {
  url: string;
  schema: z.ZodType<T>;
  onEvent: (event: T) => void;
  onState?: (state: StreamState, attempt: number) => void;
  onInvalid?: (raw: string, issue: string) => void;
  /** Resume after this seq (persisted by the caller). */
  after?: number;
  /** Stop when this returns true (e.g. a `done` event). */
  isTerminal?: (event: T) => boolean;
}

export function openStream<T extends { seq: number }>(opts: StreamOptions<T>): () => void {
  let lastSeq = opts.after ?? -1;
  let attempt = 0;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let healthy: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** The first event on a new connection may come from a restarted Core. */
  let fresh = false;

  const connect = () => {
    if (closed) return;
    opts.onState?.(attempt === 0 ? 'connecting' : 'retrying', attempt);
    const sep = opts.url.includes('?') ? '&' : '?';
    source = new EventSource(lastSeq >= 0 ? `${opts.url}${sep}after=${lastSeq}` : opts.url, {
      withCredentials: true,
    });

    source.onopen = () => {
      fresh = true;
      opts.onState?.('open', attempt);
      healthy = setTimeout(() => {
        attempt = 0;
      }, 60_000);
    };

    source.onmessage = (msg: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(msg.data);
      } catch {
        opts.onInvalid?.(msg.data, 'not JSON');
        return;
      }
      const parsed = opts.schema.safeParse(data);
      if (!parsed.success) {
        opts.onInvalid?.(msg.data, parsed.error.message);
        return;
      }
      const event = parsed.data;
      // We asked for events after lastSeq, so an older number on a new
      // connection means Core restarted and counts from zero again: follow it.
      if (event.seq <= lastSeq && !fresh) return;
      fresh = false;
      lastSeq = event.seq;
      opts.onEvent(event);
      if (opts.isTerminal?.(event)) close();
    };

    source.onerror = () => {
      source?.close();
      if (healthy) clearTimeout(healthy);
      if (closed) return;
      attempt += 1;
      const cap = Math.min(10_000, 250 * 2 ** attempt);
      timer = setTimeout(connect, Math.random() * cap);
      opts.onState?.('retrying', attempt);
    };
  };

  const close = () => {
    closed = true;
    source?.close();
    if (timer) clearTimeout(timer);
    if (healthy) clearTimeout(healthy);
    opts.onState?.('closed', attempt);
  };

  connect();
  return close;
}
