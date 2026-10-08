/**
 * One error shape across every service (DESIGN.md §11.3). The UI renders
 * title + detail + hint and never a stack. Stacks live in logs under the
 * same trace id.
 */
import { z } from 'zod';

export const ErrorClass = z.enum([
  'transient',
  'capacity',
  'refusal',
  'context_overflow',
  'policy',
  'permanent',
  'bug',
]);
export type ErrorClass = z.infer<typeof ErrorClass>;

export const Attempt = z.object({
  target: z.string(),
  class: ErrorClass.optional(),
  ms: z.number().nonnegative(),
  status: z.number().int().optional(),
  note: z.string().optional(),
});
export type Attempt = z.infer<typeof Attempt>;

export const ApiError = z.object({
  error: z.object({
    /** Dotted, stable, documented in docs/errors.md: `provider.auth_failed` */
    code: z.string(),
    /** One plain sentence: what happened. */
    title: z.string(),
    /** Specifics, already redacted. */
    detail: z.string().optional(),
    /** What the user can do about it. Every user-facing error has one. */
    hint: z.string(),
    retryable: z.boolean(),
    trace_id: z.string(),
    attempts: z.array(Attempt).default([]),
    context: z.record(z.string(), z.unknown()).default({}),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Thrown inside services; serialised to ApiError at the edge. */
export class AncileError extends Error {
  readonly code: string;
  readonly title: string;
  readonly hint: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly errorClass: ErrorClass;
  readonly detail: string | undefined;
  readonly attempts: Attempt[];
  readonly context: Record<string, unknown>;

  constructor(init: {
    code: string;
    title: string;
    hint: string;
    status?: number;
    retryable?: boolean;
    errorClass?: ErrorClass;
    detail?: string;
    attempts?: Attempt[];
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(init.title, { cause: init.cause });
    this.name = 'AncileError';
    this.code = init.code;
    this.title = init.title;
    this.hint = init.hint;
    this.status = init.status ?? 500;
    this.retryable = init.retryable ?? false;
    this.errorClass = init.errorClass ?? 'bug';
    this.detail = init.detail;
    this.attempts = init.attempts ?? [];
    this.context = init.context ?? {};
  }

  toJSON(traceId: string): ApiError {
    return {
      error: {
        code: this.code,
        title: this.title,
        detail: this.detail,
        hint: this.hint,
        retryable: this.retryable,
        trace_id: traceId,
        attempts: this.attempts,
        context: this.context,
      },
    };
  }
}
