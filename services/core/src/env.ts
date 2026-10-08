/**
 * ------------------------------------------------------------------
 *  Title    |  Environment
 *  Ref      |  .env.example (every variable documented there)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Validate the environment once, at boot, and say exactly
 *           |  which variable is wrong and how to fix it. Nothing else
 *           |  in Core reads process.env.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const base64Key = z.string().refine((v) => {
  try {
    return Buffer.from(v, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be 32 random bytes, base64-encoded');

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().url().optional());

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    ANCILE_HOST: z.string().default('127.0.0.1'),
    ANCILE_PORT: z.coerce.number().int().min(1).max(65535).default(7700),
    ANCILE_PUBLIC_URL: z.string().url().default('http://localhost:7700'),
    ANCILE_SECRET_KEY: base64Key,
    ANCILE_PASSPHRASE_REQUIRED: bool,
    ANCILE_DATA_DIR: z.string().default('./data'),
    ANCILE_CONFIG_DIR: z.string().default('./config'),
    ANCILE_PROMPTS_DIR: z.string().default('./prompts'),
    ANCILE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    ANCILE_BOOT_TESTS: z.enum(['strict', 'warn', 'off']).default('strict'),
    // The offline test model: answers without a key or a network. The dev
    // stack turns it on; production leaves it off unless asked.
    ANCILE_OFFLINE_MODELS: bool,
    // Where the file tools work; models see it as /workspace.
    ANCILE_WORKSPACE_DIR: z.string().optional(),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),

    KNOWLEDGE_URL: z.string().url().default('http://localhost:7710'),
    // Agent Engine (opencode fork), the lab lane. Optional: Ancile runs
    // without a lab when Bun is not installed.
    AGENT_ENGINE_URL: optionalUrl,
    AGENT_ENGINE_TOKEN: z.string().optional(),
    // The lab's key to Core: accepted for /internal/v1/openai/* only.
    AGENT_GATEWAY_TOKEN: z.string().min(24).optional(),
    ANCILE_SERVICE_TOKEN: z
      .string()
      .min(24, 'must be at least 24 characters; generate one like ANCILE_SECRET_KEY'),

    CONTROLLER_URL: optionalUrl,
    CONTROLLER_TOKEN: z.string().optional(),

    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    OLLAMA_BASE_URL: optionalUrl,

    ANCILE_RESTART_ADAPTER: z.enum(['none', 'process', 'docker']).default('none'),
    ANCILE_RESTART_AFTER_FAILURES: z.coerce.number().int().min(1).default(3),
    ANCILE_HEALTH_INTERVAL_S: z.coerce.number().int().min(2).default(15),
    ANCILE_APPROVAL_TTL_AUTOMATION_S: z.coerce.number().int().min(60).default(86_400),
    // A question nobody answers expires (treated as a denial) after this long.
    ANCILE_APPROVAL_TTL_S: z.coerce.number().int().min(60).default(86_400),
    // A lab run that has not finished after this long is stopped.
    ANCILE_LAB_TIMEOUT_S: z.coerce.number().int().min(60).default(1_800),
    // Runs one Core executes at once (answers, fact-checks, lab runs). Most of
    // a run is waiting on a provider, so this can be generous.
    ANCILE_RUN_CONCURRENCY: z.coerce.number().int().min(1).max(512).default(64),
    // Extra origins (comma-separated) allowed to change things through /api/v1,
    // beyond the Cockpit's own (localhost:7701, ANCILE_PUBLIC_URL, the desktop app).
    ANCILE_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    ANCILE_MEMORY_REMOTE: z.string().optional(),
    ANCILE_MEMORY_AUTHOR_NAME: z.string().default('NVX Ancile'),
    ANCILE_MEMORY_AUTHOR_EMAIL: z.string().default('memory@ancile.local'),
    /** Seed for a new memory repository; defaults to memory-template/ next to config/. */
    ANCILE_MEMORY_TEMPLATE_DIR: z.string().optional(),

    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
    OTEL_SERVICE_NAMESPACE: z.string().default('ancile'),
    ANCILE_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
    ANCILE_SPAN_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    ANCILE_RUN_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),

    /**
     * Which build runs: `free` never loads Pro code; `pro` loads it from pro/
     * when present. Unset: pro when pro/ is there, free otherwise.
     */
    NVX_TIER: z.enum(['free', 'pro']).optional(),
    NVX_LICENSE_URL: z.string().url().default('https://ancile.nvx.sh/api/license'),
    /** Licence public keys, kid → base64url Ed25519 key, injected at build time. */
    NVX_LICENSE_KEYS: z.string().optional(),
    /** Anonymous usage statistics endpoint (https). Empty: nothing is ever sent. */
    NVX_TELEMETRY_URL: z
      .string()
      .optional()
      .transform((v) => v?.trim() || undefined)
      .refine((v) => v === undefined || v.startsWith('https://'), 'must be an https:// URL'),
  })
  .superRefine((env, ctx) => {
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(env.ANCILE_HOST);
    if (!loopback && !env.ANCILE_PASSPHRASE_REQUIRED && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['ANCILE_PASSPHRASE_REQUIRED'],
        message: `Core binds to ${env.ANCILE_HOST}, which is reachable from other machines. Set ANCILE_PASSPHRASE_REQUIRED=true or bind to 127.0.0.1`,
      });
    }
    if (env.CONTROLLER_URL && !env.CONTROLLER_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONTROLLER_TOKEN'],
        message: 'CONTROLLER_URL is set, so CONTROLLER_TOKEN is required',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Readable report: one line per problem, variable name first. */
export function explainEnvErrors(error: z.ZodError): string {
  const lines = error.issues.map((i) => {
    const key = i.path.join('.') || '(environment)';
    return `  ${key}: ${i.message}`;
  });
  return [
    'Core cannot start: the environment is not valid.',
    ...lines,
    '',
    'Fix the values in .env (every variable is documented in .env.example), then start again.',
  ].join('\n');
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const err = new Error(explainEnvErrors(parsed.error));
    err.name = 'EnvError';
    throw err;
  }
  return parsed.data;
}
