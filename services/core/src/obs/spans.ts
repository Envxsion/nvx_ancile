/**
 * ------------------------------------------------------------------
 *  Title    |  Spans
 *  Ref      |  DESIGN.md §11.1, §11.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Record what happened, in what order and for how long,
 *           |  so a trace can be drawn as a waterfall and a run can be
 *           |  replayed: requests, runs and their steps, model calls,
 *           |  tool calls and calls to the other services.
 *  How      |  OpenTelemetry's shape (trace id, span id, parent, kind,
 *           |  status, attributes, events), our own recorder: the
 *           |  AsyncLocalStorage context already carries the trace, so
 *           |  withSpan() just opens a child context and hands the
 *           |  finished span to a sink (obs/store.ts batches them into
 *           |  core.spans). No sink, no cost beyond an object.
 *  Note     |  OTLP export, when configured, stays with the OTel SDK in
 *           |  tracing.ts. This is the in-app copy the Cockpit reads.
 * ------------------------------------------------------------------
 */

import { currentContext, newSpanId, newTraceId, type RequestContext, runWithContext } from '../context';
import { redact } from './redact';

export type SpanKind = 'server' | 'client' | 'internal' | 'producer' | 'consumer';
export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  name: string;
  kind: SpanKind;
  startAt: Date;
  endAt: Date | null;
  status: SpanStatus;
  attrs: Record<string, unknown>;
  events: { name: string; at: string; attrs?: Record<string, unknown> }[];
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  set(attrs: Record<string, unknown>): void;
  event(name: string, attrs?: Record<string, unknown>): void;
  end(status?: SpanStatus, attrs?: Record<string, unknown>): void;
}

type Sink = (s: SpanRecord) => void;
let sink: Sink | null = null;

/** Where finished spans go (the batching store); null stops recording. */
export function setSpanSink(next: Sink | null): void {
  sink = next;
}

const SERVICE = 'core';

/**
 * Start a span under whatever is running now, without changing the context
 * (for generators and callbacks that cannot wrap a function). End it yourself.
 */
export function startSpan(
  name: string,
  kind: SpanKind = 'internal',
  attrs: Record<string, unknown> = {},
  opts: { spanId?: string; parent?: RequestContext | undefined } = {},
): SpanHandle {
  const ctx = opts.parent === undefined ? currentContext() : opts.parent;
  const record: SpanRecord = {
    traceId: ctx?.traceId ?? newTraceId(),
    spanId: opts.spanId ?? newSpanId(),
    parentSpanId: opts.spanId && ctx?.spanId === opts.spanId ? null : (ctx?.spanId ?? null),
    service: SERVICE,
    name,
    kind,
    startAt: new Date(),
    endAt: null,
    status: 'unset',
    attrs: { ...attrs },
    events: [],
  };
  let ended = false;
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    set(more) {
      Object.assign(record.attrs, more);
    },
    event(eventName, eventAttrs) {
      if (record.events.length < 50)
        record.events.push({
          name: eventName,
          at: new Date().toISOString(),
          ...(eventAttrs && { attrs: eventAttrs }),
        });
    },
    end(status = 'ok', more) {
      if (ended) return;
      ended = true;
      record.endAt = new Date();
      record.status = status;
      if (more) Object.assign(record.attrs, more);
      record.attrs = redact(record.attrs) as Record<string, unknown>;
      try {
        sink?.(record);
      } catch {
        /* recording must never break the work it records */
      }
    },
  };
}

/** Run fn inside a child span: everything it logs or calls carries the new span id. */
export async function withSpan<T>(
  name: string,
  kind: SpanKind,
  attrs: Record<string, unknown>,
  fn: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  const parent = currentContext();
  const span = startSpan(name, kind, attrs, { parent });
  const ctx: RequestContext = { ...(parent ?? {}), traceId: span.traceId, spanId: span.spanId };
  try {
    const out = await runWithContext(ctx, () => fn(span));
    span.end('ok');
    return out;
  } catch (err) {
    span.end('error', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
