/**
 * ------------------------------------------------------------------
 *  Title    |  Controller environment
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Validate every variable once at boot and fail with the
 *           |  variable's name and the fix, never a stack trace.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

const Env = z.object({
  CONTROLLER_PORT: z.coerce.number().int().min(1).max(65535).default(7720),
  CONTROLLER_HOST: z.string().default('0.0.0.0'),
  CONTROLLER_TOKEN: z
    .string()
    .min(16, 'must be at least 16 characters; generate one with crypto.randomBytes'),
  CONTROLLER_NODE_TOKEN: z.string().default(''),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
    .optional(),
  CONTROLLER_STORE: z.enum(['postgres', 'memory']).default('postgres'),
  /**
   * runpod: pods in your RunPod account · local: OpenAI-compatible servers on
   * your network (CONTROLLER_LOCAL_NODES) · fake: sample nodes, no GPU.
   * Without a RunPod key outside production, sample nodes are shown.
   */
  CONTROLLER_PROVIDER: z.enum(['runpod', 'local', 'fake']).default('runpod'),
  /** JSON list of {name, url, gpu?, models?}, e.g. [{"name":"Desk 3090","url":"http://192.168.1.20:11434/v1"}]. */
  CONTROLLER_LOCAL_NODES: z.string().default(''),
  /** How often node state is re-read from the provider. */
  CONTROLLER_RECONCILE_S: z.coerce.number().int().min(5).default(30),
  NODE_ENV: z.string().default('development'),
  RUNPOD_API_KEY: z.string().default(''),
  RUNPOD_API_BASE: z.string().url().default('https://api.runpod.io'),
  CONTROLLER_COST_CAP_USD: z.coerce.number().positive().default(150),
  CONTROLLER_QUEUE_DEADLINE_S: z.coerce.number().int().positive().default(240),
  CONTROLLER_RULES_INTERVAL_S: z.coerce.number().int().min(5).default(30),
  ANCILE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});
export type Env = z.infer<typeof Env>;

const FIXES: Record<string, string> = {
  CONTROLLER_TOKEN: 'Set CONTROLLER_TOKEN in .env (the same value Core uses).',
  DATABASE_URL: 'Set DATABASE_URL, e.g. postgres://ancile:change-me-locally@localhost:5433/ancile.',
  RUNPOD_API_BASE: 'Use https://api.runpod.io (REST v2).',
};

export class EnvError extends Error {}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? '?');
      return `  ${key}: ${i.message}. ${FIXES[key] ?? 'See .env.example.'}`;
    });
    throw new EnvError(`Controller configuration is invalid:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  if (env.CONTROLLER_STORE === 'postgres' && !env.DATABASE_URL) {
    throw new EnvError(
      `Controller configuration is invalid:\n  DATABASE_URL: required when CONTROLLER_STORE=postgres. ${FIXES.DATABASE_URL}`,
    );
  }
  if (env.CONTROLLER_PROVIDER === 'runpod' && !env.RUNPOD_API_KEY) {
    // Not fatal: the Controller runs and reports "no provider key" in /ready and diagnostics.
  }
  return env;
}
