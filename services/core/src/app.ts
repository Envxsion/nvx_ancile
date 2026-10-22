/**
 * ------------------------------------------------------------------
 *  Title    |  The Core HTTP app
 *  Ref      |  DESIGN.md §4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Mount everything on one origin:
 *           |    /health, /ready         liveness and readiness
 *           |    /api/v1/*               the Cockpit's API (REST + SSE)
 *           |    /internal/v1/*          service-to-service (token)
 *           |    /mcp, /mcp/lab          MCP for apps, and for the lab
 *           |    /mcp/claude             MCP for live Claude Code sessions
 *           |    /*                      the built Cockpit, SPA fallback
 *  How      |  createApp() takes its dependencies, so tests build an
 *           |  app with fakes and no network. /api/v1 sits behind the
 *           |  request guard (http/guard.ts: only the owner, with the
 *           |  install key or a paired browser, and no other site
 *           |  driving the browser) and a 25 MB body limit (200 MB for
 *           |  a file added as a source). The guard's credentials are a
 *           |  required dependency (localAuth): there is no app without
 *           |  them.
 * ------------------------------------------------------------------
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  AncileError,
  type GlobalEvent,
  type license,
  type RunEvent,
  type SystemHealth,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import type { EventBus } from './events/bus';
import type { ServiceState } from './health/supervisor';
import { cockpitPageHeaders } from './http/csp';
import { cockpitOrigins, requestGuard } from './http/guard';
import type { LocalAuth, Presented } from './http/localAuth';
import { pairingRoutes } from './http/pairing';
import { lastEventId, sseStream } from './http/sse';
import { mountPlanned } from './http/stubs';
import { type InternalDeps, internalRoutes } from './internal/openai';
import { errorHandler, notFound } from './obs/errors';
import { traceMiddleware } from './obs/tracing';
import { identityMiddleware } from './pro/routes';
import type { IdentityProvider, Principal } from './pro/types';
import type { RunStore } from './runs/engine';
import { type RunEventLog, replayThenTail } from './runs/events';
import type { ApiObservation } from './telemetry/collect';

export type AppEnv = { Variables: { traceId: string; principal?: Principal; presented?: Presented } };

export interface AppDeps {
  version: string;
  /**
   * Who may call /api/v1: the install key and the paired browser's session (http/localAuth.ts).
   * Required, not optional, so no caller of createApp can leave the Cockpit API open by leaving it out.
   */
  localAuth: LocalAuth;
  serviceToken: string;
  /** A narrower token (the lab's): model calls under /internal/v1/openai only. */
  gatewayToken?: string | undefined;
  events: EventBus;
  runEvents: RunEventLog;
  /** Readiness: every check must pass before traffic is accepted. */
  ready: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  health: () => ServiceState[];
  /** Probe every service now instead of returning the last cached result. */
  checkHealthNow?: () => Promise<void>;
  license: () => z.infer<typeof license.LicenseStatus>;
  /** Built Cockpit to serve in production; omitted in dev (Vite serves it). */
  cockpitDist?: string;
  /** Built feature routes, mounted under /api/v1 ahead of the planned-route stubs. */
  routes?: Hono<AppEnv>[];
  /** The gateway behind /internal/v1/openai/* (other services' model calls). */
  internal?: InternalDeps;
  /** Lets a stream for a run that does not exist answer 404. */
  runs?: Pick<RunStore, 'get'>;
  /** Origins allowed to change things through /api/v1 (defaults: the Cockpit's). */
  allowedOrigins?: string[];
  /** Phase 5: the full health view (adapter, fixes, restarts), when the supervisor provides it. */
  systemHealth?: () => SystemHealth;
  /** Phase 5: NVX Ancile as an MCP server, at /mcp (bearer token, not the browser guard). */
  mcp?: (req: Request) => Promise<Response>;
  /** The hosted MCP tools, for the lab, at /mcp/lab (the lab's token, not the browser guard). */
  labMcp?: (req: Request) => Promise<Response>;
  /** Ancile's MCP server for live Claude Code sessions, at /mcp/claude (a per-thread token, not the browser guard). */
  claudeMcp?: (req: Request) => Promise<Response>;
  /** Phase 5: more service-token routes under /internal/v1 (log ingest). */
  internalRoutes?: Hono<AppEnv>[];
  /** Phase 6: every /api/v1 request, answered (anonymous usage statistics). */
  observe?: (o: ApiObservation) => void;
  /** Who is asking (the one owner in the free build; Teams in Pro). Read per request. */
  identity?: () => IdentityProvider;
}

/** Largest JSON body /api/v1 accepts. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
/** A chat export brought in on first run (CHAT_IMPORT_MAX_MB). */
export const MAX_CHAT_IMPORT_BYTES = 300 * 1024 * 1024 + 64 * 1024;
/** Files added as sources. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024 + 64 * 1024;

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', traceMiddleware());
  app.onError(errorHandler);

  app.get('/health', (c) => c.json({ ok: true, service: 'core', version: deps.version }));
  app.get('/ready', async (c) => {
    const r = await deps.ready();
    return c.json(r, r.ok ? 200 : 503);
  });

  const api = new Hono<AppEnv>();
  if (deps.observe) {
    const observe = deps.observe;
    api.use('*', async (c, next) => {
      const started = Date.now();
      await next();
      observe({
        method: c.req.method,
        path: c.req.path.replace(/^\/api\/v1/, ''),
        status: c.res.status,
        ms: Date.now() - started,
        ...(c.error && { error: c.error }),
        body: () => c.req.json(),
      });
    });
  }
  api.use('*', requestGuard({ origins: deps.allowedOrigins ?? cockpitOrigins(), auth: deps.localAuth }));
  api.route('/', pairingRoutes(deps.localAuth));
  if (deps.identity) api.use('*', identityMiddleware(deps.identity));
  const limit = (maxSize: number, what: string) =>
    bodyLimit({
      maxSize,
      onError: () => {
        throw new AncileError({
          code: 'request.too_large',
          title: 'That request is too large',
          hint: `Send less at once: the limit is ${what}.`,
          status: 413,
          errorClass: 'permanent',
        });
      },
    });
  const general = limit(MAX_BODY_BYTES, '25 MB');
  // A file added as a source may be large; nothing else may.
  const upload = limit(MAX_UPLOAD_BYTES, '200 MB per file');
  const chatExport = limit(MAX_CHAT_IMPORT_BYTES, '300 MB per file');
  api.use('*', (c, next) => {
    const multipart = (c.req.header('content-type') ?? '').startsWith('multipart/form-data');
    if (c.req.method === 'POST' && multipart && c.req.path.endsWith('/sources')) return upload(c, next);
    if (c.req.method === 'POST' && multipart && c.req.path.endsWith('/imports/chats'))
      return chatExport(c, next);
    return general(c, next);
  });

  api.get('/system/health', async (c) => {
    // ?fresh=1 probes live, inside this request's trace (the dashboard's
    // "Check now"); otherwise the supervisor's last result is returned.
    if (c.req.query('fresh') && deps.checkHealthNow) await deps.checkHealthNow();
    if (deps.systemHealth) return c.json(deps.systemHealth());
    return c.json({
      services: deps.health().map((s) => ({
        service: s.service,
        status: s.status,
        consecutive_failures: s.consecutiveFailures,
        last_ok_at: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null,
        last_error: s.lastError,
        needs_attention: s.attention,
      })),
    });
  });

  api.get('/events', (c) => {
    // A first connection starts from now: replaying the buffer would toast
    // yesterday's notifications on every page load. A reconnect (with
    // Last-Event-ID or ?after=) gets exactly what it missed.
    const resuming = c.req.header('last-event-id') !== undefined || c.req.query('after') !== undefined;
    const after = resuming ? lastEventId(c) : Number.MAX_SAFE_INTEGER;
    return sseStream<GlobalEvent>(c, (emit) => deps.events.subscribe(after, emit));
  });

  api.get('/runs/:id/stream', async (c) => {
    const id = c.req.param('id');
    if (deps.runs && !(await deps.runs.get(id))) throw notFound('That run');
    return sseStream<RunEvent>(c, (emit) => replayThenTail(deps.runEvents, id, lastEventId(c), emit));
  });

  api.get('/license', (c) => c.json(deps.license()));

  for (const r of deps.routes ?? []) api.route('/', r);
  mountPlanned(api);
  api.all('*', () => {
    throw notFound('That API route');
  });
  app.route('/api/v1', api);

  const internal = new Hono<AppEnv>();
  internal.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const gateway =
      !!deps.gatewayToken &&
      sameSecret(auth, `Bearer ${deps.gatewayToken}`) &&
      /^\/internal\/v1\/openai\//.test(c.req.path);
    if (!sameSecret(auth, `Bearer ${deps.serviceToken}`) && !gateway) {
      throw new AncileError({
        code: 'auth.service_token',
        title: 'This endpoint is for Ancile services only',
        hint: 'Check that ANCILE_SERVICE_TOKEN matches across services.',
        status: 401,
        errorClass: 'permanent',
      });
    }
    await next();
  });
  internal.route('/', internalRoutes(deps.internal));
  for (const r of deps.internalRoutes ?? []) internal.route('/', r);
  app.route('/internal/v1', internal);

  if (deps.mcp) {
    const handle = deps.mcp;
    app.all('/mcp', (c) => handle(c.req.raw));
  }
  if (deps.labMcp) {
    const handle = deps.labMcp;
    app.all('/mcp/lab', (c) => handle(c.req.raw));
  }
  if (deps.claudeMcp) {
    const handle = deps.claudeMcp;
    app.all('/mcp/claude', (c) => handle(c.req.raw));
  }

  if (deps.cockpitDist) {
    const dist = deps.cockpitDist;
    app.use('/assets/*', serveStatic({ root: dist }));
    app.use('/*', cockpitPageHeaders(), serveStatic({ root: dist }));
    app.get('*', async (c) => c.html(await readFile(join(dist, 'index.html'), 'utf8')));
  }

  return app;
}

/** Constant-time comparison of two secrets (hashed first, so lengths never leak). */
function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
