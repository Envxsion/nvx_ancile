/**
 * ------------------------------------------------------------------
 *  Title    |  Tracing
 *  Ref      |  DESIGN.md §11.1
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One trace per user action, across every service and
 *           |  every provider call.
 *  How      |  OTel NodeSDK with GenAI semantic conventions; an OTLP
 *           |  exporter only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *           |  The Hono middleware accepts an incoming traceparent (the
 *           |  Cockpit creates one per action) or starts a new trace,
 *           |  and echoes x-trace-id on every response.
 *  Note     |  Requests that change something (and any that fail) are
 *           |  also recorded as spans (obs/spans.ts) for Admin → Traces;
 *           |  reads, polls and streams are not, or they would bury it.
 * ------------------------------------------------------------------
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { MiddlewareHandler } from 'hono';
import { formatTraceparent, newSpanId, newTraceId, parseTraceparent, runWithContext } from '../context';
import { logFor } from './logger';
import { startSpan } from './spans';

let sdk: NodeSDK | undefined;

export function startTracing(opts: {
  endpoint: string | undefined;
  namespace: string;
  version: string;
}): void {
  if (sdk) return;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'ancile-core',
      [ATTR_SERVICE_VERSION]: opts.version,
      'service.namespace': opts.namespace,
    }),
    ...(!!opts.endpoint && { traceExporter: new OTLPTraceExporter({ url: opts.endpoint }) }),
  });
  sdk.start();
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

/** Establish trace context for the request and expose it to handlers and logs. */
export function traceMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = parseTraceparent(c.req.header('traceparent'));
    const traceId = incoming?.traceId ?? newTraceId();
    const spanId = newSpanId();
    c.set('traceId', traceId);
    c.header('x-trace-id', traceId);
    c.header('traceparent', formatTraceparent(traceId, spanId));
    const started = performance.now();
    await runWithContext({ traceId, spanId, component: 'http' }, async () => {
      await next();
      // One access line per request, carrying the trace id (via the logger's
      // context mixin) so the log viewer can follow a request across services.
      // Liveness and readiness probes are debug-level, or they drown the log.
      // So is log shipping itself: each accepted batch would log a line that is
      // shipped again, and its spans buried every real request in Traces.
      const shipping = c.req.path === '/internal/v1/logs' && c.res.status < 400;
      const quiet =
        shipping ||
        c.req.header('x-ancile-probe') === 'background' ||
        ((c.req.path === '/health' || c.req.path === '/ready') && !c.req.header('traceparent'));
      const line = {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      };
      if (quiet) accessLog.debug(line, 'request');
      else accessLog.info(line, 'request');
      // The flow editor checks and sizes the graph as you draw: chatter, not work.
      const housekeeping =
        (/\/(ui-state|drafts)\//.test(c.req.path) ||
          /\/flows\/(validate|estimate-context)$/.test(c.req.path)) &&
        c.res.status < 500;
      if (
        !quiet &&
        !housekeeping &&
        (c.req.method !== 'GET' || c.res.status >= 500) &&
        !c.req.path.endsWith('/stream')
      ) {
        // The request is the root of its trace here; the browser's span is not stored.
        const route = c.req.routePath && !c.req.routePath.endsWith('*') ? c.req.routePath : c.req.path;
        const span = startSpan(
          `${c.req.method} ${route.replace(/^\/api\/v1/, '')}`,
          'server',
          {
            'http.method': c.req.method,
            'http.path': c.req.path,
            'http.status': c.res.status,
            ...(incoming && { client_span: incoming.parentId }),
          },
          { spanId, parent: { traceId, spanId } },
        );
        span.end(c.res.status >= 500 ? 'error' : 'ok', { ms: line.ms });
      }
    });
  };
}

const accessLog = logFor('http');
