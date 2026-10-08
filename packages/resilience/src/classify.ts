/**
 * ------------------------------------------------------------------
 *  Title    |  Error classification
 *  Ref      |  DESIGN.md §7.1
 *  ID       |  resilience
 * ------------------------------------------------------------------
 *  Purpose  |  Turn whatever a provider, a node or a service threw into
 *           |  one of seven classes. The class, not the exception type,
 *           |  decides whether we retry, fall back, compact or stop.
 * ------------------------------------------------------------------
 */

import type { ErrorClass } from '@nvx/contracts';

export type { ErrorClass };

/** Classes worth retrying against the same target. */
export const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['transient']);

/** Classes after which the next target in a chain should be tried. */
export const FALLBACKABLE: ReadonlySet<ErrorClass> = new Set([
  'transient',
  'capacity',
  'refusal',
  'policy',
  'permanent',
]);

/** An error that already knows its class. */
export class ClassifiedError extends Error {
  readonly errorClass: ErrorClass;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    errorClass: ErrorClass,
    message: string,
    opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ClassifiedError';
    this.errorClass = errorClass;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const OVERFLOW =
  /(context[_ ]length|context window|maximum context|too many tokens|prompt is too long|max_tokens.*exceed)/i;
const REFUSAL = /(content[_ ]filter|content_policy|safety|refus)/i;

/** HTTP status (plus optional provider error code/message) → class. */
export function classifyStatus(status: number, codeOrMessage = ''): ErrorClass {
  if (status === 402) return 'policy';
  if (status === 408 || status === 425 || status === 429) return 'transient';
  if (status === 503 && /node_waking|queue_full|capacity|overloaded/i.test(codeOrMessage)) return 'capacity';
  if (status === 529) return 'capacity'; // provider "overloaded"
  if (status >= 500) return 'transient';
  if (status === 400 || status === 413) {
    if (OVERFLOW.test(codeOrMessage)) return 'context_overflow';
    if (REFUSAL.test(codeOrMessage)) return 'refusal';
    return 'permanent';
  }
  if (status === 401 || status === 403 || status === 404 || status === 422) return 'permanent';
  return 'permanent';
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  errorClass?: unknown;
  finishReason?: unknown;
  cause?: unknown;
}

/** Best-effort classification of anything thrown. Unknown means `bug`. */
export function classify(err: unknown): ErrorClass {
  if (err instanceof ClassifiedError) return err.errorClass;
  if (!err || typeof err !== 'object') return 'bug';
  const e = err as ErrorLike;
  if (typeof e.errorClass === 'string') return e.errorClass as ErrorClass;
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (name === 'TimeoutError' || name === 'DeadlineExceededError') return 'transient';
  if (name === 'AbortError') return 'permanent'; // the caller cancelled: never retry
  if (e.finishReason === 'content-filter' || e.finishReason === 'content_filter') return 'refusal';
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return 'transient';
  const status =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined)
    return classifyStatus(status, `${typeof e.code === 'string' ? e.code : ''} ${message}`);
  if (OVERFLOW.test(message)) return 'context_overflow';
  if (e.cause && e.cause !== err) {
    const inner = classify(e.cause);
    if (inner !== 'bug') return inner;
  }
  if (/fetch failed|network|socket hang up/i.test(message)) return 'transient';
  return 'bug';
}

/** Parse a Retry-After header (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Read retryAfterMs off an error if one was recorded. */
export function retryAfterOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'retryAfterMs' in err) {
    const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof v === 'number' ? v : undefined;
  }
  return undefined;
}
