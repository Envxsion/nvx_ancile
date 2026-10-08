/**
 * ------------------------------------------------------------------
 *  Title    |  Controller client
 *  Ref      |  DESIGN.md §4.3 · packages/contracts/src/controller.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Core's one way to reach the Controller's control plane:
 *           |  nodes, actions, operations, costs, rules, and its event
 *           |  stream. Its errors arrive as NVX Ancile's own.
 *  How      |  JSON calls carry the Controller token and the trace.
 *           |  Reads retry transient failures; writes do not (actions
 *           |  carry their own idempotency key instead).
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';
import { retry } from '@nvx/resilience';
import { currentContext, formatTraceparent, newSpanId, newTraceId } from '../context';

export interface ControllerClient {
  readonly configured: boolean;
  get<T>(path: string): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** The raw response, for SSE streams relayed to the Cockpit. */
  raw(path: string, signal?: AbortSignal): Promise<Response>;
}

function unavailable(cause?: unknown): AncileError {
  return new AncileError({
    code: 'compute.unavailable',
    title: 'The Controller is not answering',
    hint: 'It starts with NVX Ancile. If it keeps failing, open Admin → Health and check "Controller".',
    status: 503,
    retryable: true,
    errorClass: 'transient',
    cause,
  });
}

export function notConfigured(): AncileError {
  return new AncileError({
    code: 'compute.not_configured',
    title: 'Remote compute is not set up',
    hint: 'Set CONTROLLER_URL and CONTROLLER_TOKEN in .env, then restart NVX Ancile.',
    status: 503,
    errorClass: 'permanent',
  });
}

async function toError(res: Response): Promise<AncileError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; title?: string; hint?: string; message?: string };
  } | null;
  const e = body?.error;
  return new AncileError({
    code: e?.code?.includes('.') ? e.code : `compute.${e?.code ?? 'failed'}`,
    title: e?.title ?? e?.message ?? 'The Controller could not do that',
    hint: e?.hint ?? 'Try again. If it keeps happening, check Admin → Logs for the Controller.',
    status: res.status >= 400 && res.status < 600 ? res.status : 502,
    errorClass: res.status >= 500 ? 'transient' : 'permanent',
  });
}

export function controllerClient(opts: {
  url: string | undefined;
  token: string | undefined;
  fetch?: typeof fetch;
}): ControllerClient {
  const f = opts.fetch ?? fetch;
  const base = opts.url ? `${opts.url.replace(/\/$/, '')}/control/v1` : null;
  const headers = (json: boolean): Record<string, string> => {
    const ctx = currentContext();
    return {
      authorization: `Bearer ${opts.token ?? ''}`,
      accept: 'application/json',
      traceparent: formatTraceparent(ctx?.traceId ?? newTraceId(), newSpanId()),
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  };
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    if (!base) throw notConfigured();
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: headers(body !== undefined),
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw unavailable(err);
    }
    if (!res.ok) throw await toError(res);
    return res;
  };
  return {
    configured: Boolean(base),
    get: async <T>(path: string) =>
      retry(async () => (await (await call('GET', path)).json()) as T, {
        maxAttempts: 3,
        baseMs: 200,
        shouldRetry: (e) => e instanceof AncileError && e.retryable,
      }),
    send: async <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
      const res = await call(method, path, body);
      return (res.status === 204 ? null : await res.json()) as T;
    },
    raw: async (path: string, signal?: AbortSignal) => {
      if (!base) throw notConfigured();
      try {
        return await f(`${base}${path}`, {
          headers: { ...headers(false), accept: 'text/event-stream' },
          signal,
        });
      } catch (err) {
        throw unavailable(err);
      }
    },
  };
}
