/**
 * ------------------------------------------------------------------
 *  Title    |  Knowledge client
 *  Ref      |  DESIGN.md §4.2 (Core ↔ Knowledge, /kn/v1)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Core's one way to reach the knowledge service: sources,
 *           |  notebook links, content, search. Its errors arrive as
 *           |  NVX Ancile's own (same code, title and hint), and a
 *           |  service that is not answering says so plainly.
 *  How      |  JSON calls carry the service token and the trace. Reads
 *           |  retry transient failures through @nvx/resilience;
 *           |  writes do not (they are not all idempotent). stream()
 *           |  passes a request body and the response through
 *           |  untouched, for uploads and original files.
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';
import { retry } from '@nvx/resilience';
import { currentContext, formatTraceparent, newSpanId, newTraceId } from '../context';

export interface KnowledgeClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** Forward a raw request (multipart upload, file download) and return the raw response. */
  stream(
    method: string,
    path: string,
    init: { body?: RequestInit['body']; headers?: Headers; signal?: AbortSignal },
  ): Promise<Response>;
}

interface WireError {
  error?: { code?: string; title?: string; hint?: string; retryable?: boolean; detail?: string };
}

function unavailable(cause: unknown): AncileError {
  return new AncileError({
    code: 'knowledge.unavailable',
    title: 'The knowledge service is not answering',
    hint: 'It starts with NVX Ancile. If it keeps failing, open Admin → Health and check "Knowledge".',
    status: 503,
    retryable: true,
    errorClass: 'transient',
    cause,
  });
}

async function toError(res: Response): Promise<AncileError> {
  const json = (await res.json().catch(() => null)) as WireError | null;
  const e = json?.error;
  return new AncileError({
    code: e?.code ?? 'knowledge.failed',
    title: e?.title ?? 'The knowledge service could not do that',
    hint: e?.hint ?? 'Try again. If it keeps happening, check Admin → Logs for the knowledge service.',
    status: res.status >= 400 && res.status < 600 ? res.status : 502,
    retryable: e?.retryable ?? res.status >= 500,
    errorClass: res.status >= 500 ? 'transient' : 'permanent',
    ...(e?.detail && { detail: e.detail }),
  });
}

export function knowledgeClient(opts: {
  baseUrl: string;
  serviceToken: string;
  fetch?: typeof fetch;
}): KnowledgeClient {
  const doFetch = opts.fetch ?? fetch;

  const headers = (extra?: Headers) => {
    const h = new Headers(extra);
    h.set('authorization', `Bearer ${opts.serviceToken}`);
    h.set('traceparent', formatTraceparent(currentContext()?.traceId ?? newTraceId(), newSpanId()));
    return h;
  };

  const once = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const h = headers();
    if (body !== undefined) h.set('content-type', 'application/json');
    let res: Response;
    try {
      res = await doFetch(new URL(`/kn/v1${path}`, opts.baseUrl), {
        method,
        headers: h,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(method === 'GET' ? 15_000 : 60_000),
      });
    } catch (cause) {
      throw unavailable(cause);
    }
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  return {
    get: <T>(path: string) =>
      retry(() => once<T>('GET', path), {
        maxAttempts: 3,
        baseMs: 150,
        shouldRetry: (err) => err instanceof AncileError && err.retryable,
      }),
    post: <T>(path: string, body?: unknown) => once<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => once<T>('PUT', path, body),
    patch: <T>(path: string, body?: unknown) => once<T>('PATCH', path, body),
    del: (path: string) => once<void>('DELETE', path),
    stream: async (method, path, init) => {
      try {
        const res = await doFetch(new URL(`/kn/v1${path}`, opts.baseUrl), {
          method,
          headers: headers(init.headers),
          body: init.body ?? null,
          ...(init.body && { duplex: 'half' }),
          ...(init.signal && { signal: init.signal }),
        } as RequestInit);
        if (!res.ok) throw await toError(res);
        return res;
      } catch (cause) {
        if (cause instanceof AncileError) throw cause;
        throw unavailable(cause);
      }
    },
  };
}
