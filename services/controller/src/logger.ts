/**
 * JSON logs with service, component and trace ids (DESIGN.md §11.1),
 * secrets redacted at the logger so they cannot leak by accident: by
 * field name (pino's redact paths) and by shape inside any text, the
 * message included, so a provider error that echoes a key cannot print it.
 */
import { type DestinationStream, pino } from 'pino';

/** Key shapes; mirrors services/core/src/obs/redact.ts. */
const TEXT_PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-…'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-…'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza…'],
  [/\brpa_[A-Za-z0-9]{16,}/g, 'rpa_…'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'hf_…'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, 'gh…'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer …'],
  [/\b(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1…@'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, repl] of TEXT_PATTERNS) out = out.replace(re, repl);
  return out;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) {
    return { type: value.name, message: redactText(value.message), stack: redactText(value.stack ?? '') };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, depth + 1)]));
  }
  return value;
}

/** The Controller's logger; tests pass a destination to read what it writes. */
export function makeLogger(dest?: DestinationStream) {
  return pino(
    {
      level: process.env.ANCILE_LOG_LEVEL ?? 'info',
      base: { service: 'controller' },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          '*.authorization',
          '*.apiKey',
          '*.api_key',
          '*.token',
          'headers.authorization',
          'RUNPOD_API_KEY',
        ],
        censor: '[redacted]',
      },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map((a) => scrub(a)) as Parameters<typeof method>);
        },
      },
      formatters: { level: (label) => ({ level: label }) },
    },
    dest,
  );
}

export const logger = makeLogger();

export function componentLogger(component: string, traceId?: string) {
  return logger.child(traceId ? { component, trace_id: traceId } : { component });
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function traceIdFrom(header: string | undefined | null): string {
  const m = header ? TRACEPARENT.exec(header.trim().toLowerCase()) : null;
  return m?.[1] ?? crypto.randomUUID().replaceAll('-', '');
}
