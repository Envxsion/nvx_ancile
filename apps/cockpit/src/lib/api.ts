/**
 * ------------------------------------------------------------------
 *  Title    |  Core API client
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One typed way to call /api/v1: a W3C traceparent on
 *           |  every request, ApiError parsed into a thrown value the
 *           |  UI can render, and nothing else clever.
 *  How      |  api.get/post/put/del(path, schema?) validates the body
 *           |  with the contract schema when one is given.
 *  Note     |  Network failure (Core not running) throws OfflineError
 *           |  and tells lib/connection.ts, which drives the banner.
 * ------------------------------------------------------------------
 */

import { ApiError } from '@nvx/contracts';
import type { z } from 'zod';
import { useSignInGate } from '../pro/signin-state';
import { useConnection } from './connection';

export const API_BASE = '/api/v1';

function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh trace per user action; spans hang off it in every service. */
export function newTraceparent(): { header: string; traceId: string } {
  const traceId = hex(16);
  return { header: `00-${traceId}-${hex(8)}-01`, traceId };
}

export class OfflineError extends Error {
  constructor(cause: unknown) {
    super('Core is not reachable', { cause });
    this.name = 'OfflineError';
  }
}

/** A failed call with the server's explanation intact. */
export class ApiCallError extends Error {
  readonly body: ApiError;
  readonly status: number;
  constructor(status: number, body: ApiError) {
    super(body.error.title);
    this.name = 'ApiCallError';
    this.status = status;
    this.body = body;
  }
}

/** Synthesises an ApiError for failures that never reached Core. */
export function localError(code: string, title: string, hint: string, traceId: string): ApiError {
  return {
    error: {
      code,
      title,
      hint,
      retryable: true,
      trace_id: traceId,
      attempts: [],
      context: { service: 'cockpit' },
    },
  };
}

async function request<T>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
  const { header, traceId } = newTraceparent();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        traceparent: header,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    useConnection.getState().fail();
    throw new OfflineError(cause);
  }

  // The dev proxy answers 502/504 when Core is down: that is offline, not an API error.
  if (res.status === 502 || res.status === 504) {
    useConnection.getState().fail();
    throw new OfflineError(res.statusText);
  }

  if (!res.ok) {
    const json: unknown = await res.json().catch(() => null);
    const parsed = ApiError.safeParse(json);
    // Core always answers in the ApiError shape and always sets x-trace-id.
    // A 5xx with neither came from something in front of Core (the Vite
    // proxy answers 500 on ECONNREFUSED), so Core is offline, not failing.
    if (!parsed.success && res.status >= 500 && !res.headers.get('x-trace-id')) {
      useConnection.getState().fail();
      throw new OfflineError(res.statusText);
    }
    useConnection.getState().ok();
    // A team (Pro) with nobody signed in: show the sign-in screen, not a page of failures.
    if (parsed.success && parsed.data.error.code === 'auth.sign_in_required')
      useSignInGate.getState().raise();
    throw new ApiCallError(
      res.status,
      parsed.success
        ? parsed.data
        : localError(
            'http.unexpected',
            `The server answered ${res.status} without an explanation`,
            'Copy the debug info and check the logs for this trace.',
            res.headers.get('x-trace-id') ?? traceId,
          ),
    );
  }

  useConnection.getState().ok();
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json();
  return schema ? schema.parse(json) : (json as T);
}

export const api = {
  get: <T>(path: string, schema?: z.ZodType<T>) => request<T>('GET', path, undefined, schema),
  post: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) => request<T>('POST', path, body, schema),
  put: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) => request<T>('PUT', path, body, schema),
  patch: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) => request<T>('PATCH', path, body, schema),
  del: <T>(path: string) => request<T>('DELETE', path),
};
