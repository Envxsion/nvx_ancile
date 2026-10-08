/**
 * ------------------------------------------------------------------
 *  Title    |  Logger
 *  Ref      |  DESIGN.md §11.1
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  JSON lines with the same shape in every service:
 *           |  {ts, level, service, component, trace_id, span_id, msg}.
 *  How      |  pino, with a mixin that reads trace context from
 *           |  AsyncLocalStorage and a formatter that redacts secrets.
 *           |  Every line is also handed to a tap (setLogTap): main.ts
 *           |  points it at the batching store, so Admin → Logs can
 *           |  filter, follow and export what was printed.
 * ------------------------------------------------------------------
 */

import pino, { type Logger } from 'pino';
import { currentContext } from '../context';
import { redact, redactText } from './redact';

export const SERVICE = 'core';

/**
 * Errors keep their message and stack. The redacting formatter runs before
 * pino's own serialisers and would otherwise flatten an Error to its
 * enumerable fields, losing exactly the text needed to debug it.
 */
function serialiseErrors(obj: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof Error) {
      out ??= { ...obj };
      out[k] = pino.stdSerializers.err(v);
    }
  }
  return out ?? obj;
}

type Tap = (line: Record<string, unknown>) => void;
let tap: Tap | null = null;

/** Receive every log line as an object (the log store); null stops it. */
export function setLogTap(next: Tap | null): void {
  tap = next;
}

/** Parses pino's output line for the tap; a bad line is skipped, never thrown. */
const tapStream = {
  write(chunk: string) {
    if (!tap) return;
    try {
      tap(JSON.parse(chunk) as Record<string, unknown>);
    } catch {
      /* not JSON, or the tap failed: the line still went to stdout */
    }
  },
};

export function createLogger(level: string = process.env.ANCILE_LOG_LEVEL ?? 'info'): Logger {
  const streams = pino.multistream([
    { level: 'trace', stream: process.stdout },
    { level: 'trace', stream: tapStream },
  ]);
  return pino(
    {
      level,
      base: { service: SERVICE },
      messageKey: 'msg',
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => redact(serialiseErrors(obj)),
      },
      // The formatter above sees only the merged object; the message text
      // (and printf-style arguments) are redacted here, so a provider error
      // that echoes a key back cannot print it.
      hooks: {
        logMethod(args, method) {
          method.apply(
            this,
            args.map((a) => (typeof a === 'string' ? redactText(a) : a)) as Parameters<typeof method>,
          );
        },
      },
      mixin() {
        const ctx = currentContext();
        if (!ctx) return {};
        return {
          trace_id: ctx.traceId,
          span_id: ctx.spanId,
          ...(!!ctx.component && { component: ctx.component }),
          ...(!!ctx.runId && { run_id: ctx.runId }),
        };
      },
    },
    streams,
  );
}

export const log = createLogger();

/** A child logger tagged with a component name, e.g. log.for('gateway'). */
export function logFor(component: string): Logger {
  return log.child({ component });
}
