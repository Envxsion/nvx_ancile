/**
 * ------------------------------------------------------------------
 *  Title    |  Error edge
 *  Ref      |  DESIGN.md §11.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every failure leaves Core in one shape: a plain title,
 *           |  a hint, the trace id, and what was tried. Stacks go to
 *           |  the log under the same trace id, never to the client.
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { currentContext } from '../context';
import { log } from './logger';
import { redact, redactText } from './redact';

export function notImplemented(phase: number, what: string): AncileError {
  return new AncileError({
    code: 'not_implemented',
    title: `${what} is not built yet`,
    hint: `This arrives in phase ${phase} of the roadmap (ROADMAP.md).`,
    status: 501,
    errorClass: 'permanent',
    context: { phase },
  });
}

export function notFound(what: string): AncileError {
  return new AncileError({
    code: 'request.not_found',
    title: `${what} was not found`,
    hint: 'It may have been deleted. Refresh the view and try again.',
    status: 404,
    errorClass: 'permanent',
  });
}

export function badRequest(detail: string): AncileError {
  return new AncileError({
    code: 'request.invalid',
    title: 'The request was not valid',
    detail,
    hint: 'This is likely a bug in the client. Copy the debug info and report it.',
    status: 400,
    errorClass: 'permanent',
  });
}

function traceIdOf(c: Context): string {
  return (c.get('traceId') as string | undefined) ?? currentContext()?.traceId ?? '0'.repeat(32);
}

/** Hono onError handler. */
export function errorHandler(err: unknown, c: Context) {
  const traceId = traceIdOf(c);
  // Hono's own HTTPException (e.g. malformed JSON) already knows its response.
  if (err && typeof err === 'object' && 'getResponse' in err && !(err instanceof AncileError)) {
    const status = (err as { status?: number }).status ?? 500;
    if (status < 500) {
      return c.json(
        badRequest((err as unknown as Error).message ?? 'The request could not be read').toJSON(traceId),
        400,
      );
    }
  }
  if (err instanceof AncileError) {
    if (err.status >= 500 && err.code !== 'not_implemented') log.error({ err, code: err.code }, err.title);
    const body = err.toJSON(traceId);
    body.error.detail = body.error.detail ? redactText(body.error.detail) : undefined;
    body.error.context = redact({ ...body.error.context, service: 'core' });
    return c.json(body, err.status as ContentfulStatusCode);
  }
  log.error({ err }, 'unhandled error');
  const wrapped = new AncileError({
    code: 'internal.bug',
    title: 'Something went wrong inside Ancile',
    hint: 'Try again. If it keeps happening, copy the debug info from this message and check the logs for this trace id.',
    status: 500,
    errorClass: 'bug',
    context: { service: 'core' },
  });
  return c.json(wrapped.toJSON(traceId), 500);
}
