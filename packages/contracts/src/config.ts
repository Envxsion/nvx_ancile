/**
 * Schemas for everything in config/. The onboarding wizard and settings
 * screens write these files; a person can too. Boot tests validate them
 * and print the exact key that is wrong (DESIGN.md §12, §14).
 */
import { z } from 'zod';
import { Tier } from './events';

export const Capability = z.enum(['tools', 'vision', 'reasoning', 'json', 'audio', 'embeddings', 'rerank']);

/** The identity-ramp hue a model's chip uses. Unset follows the model's family. */
export const ModelHue = z.enum(['coral', 'amber', 'jade', 'cyan', 'azure', 'magenta', 'chalk']);
export type ModelHue = z.infer<typeof ModelHue>;

export const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type Weekday = z.infer<typeof Weekday>;

/** "HH:MM" on the 24-hour clock in UTC; "24:00" is allowed as the end of a day. */
const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'HH:MM in UTC, such as 06:00');

/**
 * A stretch of the week, in UTC (so no daylight saving), on the listed days:
 * from the start up to but not including the end. A window never crosses
 * midnight; split it in two ("22:00-24:00" on one day, "00:00-06:00" on the next).
 */
export const PriceWindow = z
  .object({ days: z.array(Weekday).min(1), from: ClockTime, to: ClockTime })
  .refine((w) => w.from < w.to, 'from must be earlier than to; split a window that crosses midnight');
export type PriceWindow = z.infer<typeof PriceWindow>;

/**
 * Rates that apply only inside `windows` (UTC), instead of the model's normal
 * price. These are the OFF-PEAK windows: where a provider names its peak hours
 * (DeepSeek), list everything else here. Costs, receipts and the receipt's
 * rates use the rate in force when the call was made (gateway/usage.ts).
 */
export const OffPeakPrice = z.object({
  input_per_mtok: z.number(),
  output_per_mtok: z.number(),
  cached_per_mtok: z.number().optional(),
  cache_write_per_mtok: z.number().optional(),
  windows: z.array(PriceWindow).min(1),
});
export type OffPeakPrice = z.infer<typeof OffPeakPrice>;

export const ModelConfig = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/, 'provider/model'),
  provider: z.string(),
  provider_model: z.string(),
  display_name: z.string(),
  via: z.enum(['direct', 'controller']).default('direct'),
  family: z.string(),
  context_window: z.number().int().positive(),
  max_output: z.number().int().positive(),
  capabilities: z.array(Capability).default([]),
  price: z
    .object({
      input_per_mtok: z.number(),
      output_per_mtok: z.number(),
      cached_per_mtok: z.number().optional(),
      /** Writing to the provider's cache (Anthropic charges 1.25× input); the input price when absent. */
      cache_write_per_mtok: z.number().optional(),
      /** A cheaper rate inside certain weekly windows (UTC). The fields above are the rate at all other times. */
      off_peak: OffPeakPrice.optional(),
    })
    .default({ input_per_mtok: 0, output_per_mtok: 0 }),
  enabled: z.boolean().default(true),
  /** Any OpenAI-compatible endpoint: base_url + secret name. */
  base_url: z.string().url().optional(),
  secret: z.string().optional(),
  /** The chip's hue; unset follows the family. */
  hue: ModelHue.optional(),
  /**
   * Where a GPU node's model runs: a machine on your own network, or one
   * rented from a provider (RunPod). A rented node is not local for scopes:
   * prompts leave this machine. Unset for every other model.
   */
  runs_on: z.enum(['your_network', 'rented']).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ModelsFile = z.object({
  version: z.literal(1),
  /** The date the prices below were last checked by hand (ISO); live checks show it when they fall back (MD5). */
  prices_as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  models: z.array(ModelConfig),
});

export const TaskClass = z.string().regex(/^[a-z]+(\.[a-z_]+)*$/);

export const ChainSpec = z.union([
  z.array(z.string()),
  z.object({ chain: z.array(z.string()), prefer_different_family: z.boolean().default(false) }),
]);

export const RoutingFile = z.object({
  version: z.literal(1),
  task_classes: z.record(TaskClass, ChainSpec),
  resilience: z
    .object({
      retry: z
        .object({
          base_ms: z.number(),
          factor: z.number(),
          cap_ms: z.number(),
          max_attempts: z.number().int(),
        })
        .partial(),
      breaker: z
        .object({
          window_s: z.number(),
          failure_rate: z.number(),
          min_calls: z.number().int(),
          consecutive: z.number().int(),
          half_open_s: z.number(),
        })
        .partial(),
      compute_wait_max_s: z.number().int().default(240),
    })
    .partial()
    .default({}),
});

export const ToolOverride = z.object({
  tier: Tier.optional(),
  disabled: z.boolean().optional(),
  destructive: z.boolean().optional(),
});
export const ToolsFile = z.object({
  version: z.literal(1),
  preset: z.enum(['careful', 'balanced', 'hands_off', 'auto']).default('balanced'),
  workspace_root: z.string().default('/workspace'),
  tools: z.record(z.string(), z.record(z.string(), ToolOverride)).default({}),
});

export const MemoryType = z.object({
  path: z.string(),
  scope: z.enum(['global', 'user', 'notebook', 'retrieved', 'model']),
  priority: z.number().int().min(0).max(100),
  budget_share: z.number().min(0).max(1),
  auto_apply: z.number().min(0).max(1).nullable(),
  top_k: z.number().int().positive().optional(),
});
export const MemoryFile = z.object({
  version: z.literal(1),
  budget: z.object({ share_of_context: z.number().min(0).max(0.5), max_tokens: z.number().int().positive() }),
  capture: z.enum(['propose_all', 'auto_confident', 'off']).default('auto_confident'),
  remote: z.object({ url: z.string(), push_cron: z.string() }).nullable().default(null),
  types: z.record(z.string(), MemoryType),
});

export const McpServerConfig = z.discriminatedUnion('transport', [
  z.object({
    name: z.string(),
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env_secrets: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
    tools: z.record(z.string(), ToolOverride).default({}),
  }),
  z.object({
    name: z.string(),
    transport: z.literal('http'),
    url: z.string().url(),
    oauth: z.boolean().default(false),
    enabled: z.boolean().default(true),
    tools: z.record(z.string(), ToolOverride).default({}),
  }),
  z.object({
    name: z.string(),
    transport: z.literal('sse'),
    url: z.string().url(),
    enabled: z.boolean().default(true),
    tools: z.record(z.string(), ToolOverride).default({}),
  }),
]);
export const McpFile = z.object({ version: z.literal(1), servers: z.array(McpServerConfig).default([]) });

export const PanelConfig = z.object({
  id: z.string(),
  title: z.string(),
  placement: z.enum(['drawer', 'admin']),
  plugin: z.string(),
  entry: z.string(),
  capabilities: z
    .array(z.enum(['read:thread', 'read:sources', 'read:memory', 'write:notes', 'invoke:tools']))
    .default([]),
});
export const PanelsFile = z.object({ version: z.literal(1), panels: z.array(PanelConfig).default([]) });

export const AutomationsFile = z.object({
  version: z.literal(1),
  jobs: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      cron: z.string().optional(),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});

export const FactcheckFile = z.object({
  version: z.literal(1),
  weights: z.object({ support: z.number(), agreement: z.number(), retrieval: z.number() }),
  thresholds: z.object({ contradict: z.number(), verified: z.number() }),
  web_search: z.boolean().default(false),
});

/** config/retrieval.yaml: how many passages a turn is given, and how many one source may give. */
export const RetrievalFile = z.object({
  version: z.literal(1),
  /** Passages given to one answer (Core's conductor and the Claude Code search tool's default). */
  k: z.number().int().min(1).max(40).default(8),
  /** At most this many of them from any one source, so one huge source cannot fill a turn. */
  per_source_max: z.number().int().min(1).max(40).default(4),
});
export type RetrievalFile = z.infer<typeof RetrievalFile>;
export const DEFAULT_RETRIEVAL: RetrievalFile = { version: 1, k: 8, per_source_max: 4 };

export const PluginManifest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  version: z.string(),
  kind: z.enum(['tools', 'memory-provider', 'panel']),
  entry: z.string(),
  description: z.string(),
  requests: z.array(z.string()).default([]),
  tools: z
    .array(
      z.object({ name: z.string(), action: z.string(), tier: Tier, destructive: z.boolean().default(false) }),
    )
    .default([]),
});
export type PluginManifest = z.infer<typeof PluginManifest>;
