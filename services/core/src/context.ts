/**
 * ------------------------------------------------------------------
 *  Title    |  Request context
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The trace id, span id and user for whatever is running
 *           |  now, available anywhere without threading arguments
 *           |  through every call. The logger reads it on every line.
 * ------------------------------------------------------------------
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface RequestContext {
  traceId: string;
  spanId: string;
  userId?: string;
  runId?: string;
  component?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** Parse a W3C traceparent header: 00-<trace>-<parent>-<flags> */
export function parseTraceparent(
  header: string | undefined | null,
): { traceId: string; parentId: string } | null {
  if (!header) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header.trim());
  if (!m || /^0+$/.test(m[1] as string) || /^0+$/.test(m[2] as string)) return null;
  return { traceId: m[1] as string, parentId: m[2] as string };
}

export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/**
 * fetch that carries the current trace to the next service. Every call
 * Core makes to Knowledge, the Controller, the Agent Engine or a provider
 * goes through this, so one user action is one trace end to end
 * (DESIGN.md §11.1). Outside a request it starts a fresh trace.
 */
export type FetchSpanHook = (
  method: string,
  url: URL,
  spanId: string,
) => { end(status: number | null, error?: string): void } | null;
let fetchHook: FetchSpanHook | null = null;

/** Record each outgoing call as a client span (set by main.ts; obs/spans.ts). */
export function setFetchSpanHook(hook: FetchSpanHook | null): void {
  fetchHook = hook;
}

export async function tracedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const ctx = currentContext();
  const headers = new Headers(init.headers);
  const spanId = newSpanId();
  if (!headers.has('traceparent'))
    headers.set('traceparent', formatTraceparent(ctx?.traceId ?? newTraceId(), spanId));
  // Background probes are not worth a span each.
  const span =
    ctx && headers.get('x-ancile-probe') !== 'background'
      ? fetchHook?.((init.method ?? 'GET').toUpperCase(), new URL(String(input)), spanId)
      : null;
  try {
    const res = await fetch(input, { ...init, headers });
    span?.end(res.status);
    return res;
  } catch (err) {
    span?.end(null, (err as Error).message);
    throw err;
  }
}
