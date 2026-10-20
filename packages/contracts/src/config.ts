/**
 * Schemas for everything in config/. The onboarding wizard and settings
 * screens write these files; a person can too. Boot tests validate them
 * and print the exact key that is wrong (DESIGN.md §12, §14).
 */
import { z } from 'zod';
import { Tier } from './events';

/**
 * How capable a model is, for routing by need (docs/models.md, Tiers). Stored names are
 * best (frontier: Opus, GPT, Gemini Pro), balanced (standard: Sonnet, GPT mini, Flash),
 * fast (small: Haiku, nano, Flash-Lite) and tiny (quick checks on obvious things).
 */
export const ModelTier = z.enum(['best', 'balanced', 'fast', 'tiny']);
export type ModelTier = z.infer<typeof ModelTier>;

/** Order of capability: tiny 0, fast 1, balanced 2, best 3. */
export const TIER_RANK: Record<ModelTier, number> = { tiny: 0, fast: 1, balanced: 2, best: 3 };

/** The plain words the YAML and the docs use, mapped to the stored names. */
export const TIER_WORDS: Record<string, ModelTier> = {
  frontier: 'best',
  standard: 'balanced',
  small: 'fast',
  tiny: 'tiny',
  best: 'best',
  balanced: 'balanced',
  fast: 'fast',
};

/** The plain word for each stored tier: what the docs, Admin and `tier_label` in GET /models say. */
export const TIER_LABEL: Record<ModelTier, 'frontier' | 'standard' | 'small' | 'tiny'> = {
  best: 'frontier',
  balanced: 'standard',
  fast: 'small',
  tiny: 'tiny',
};

/** A tier by either name; the plain words are what people write. */
export const TierName = z.preprocess(
  (v) => (typeof v === 'string' ? (TIER_WORDS[v.toLowerCase()] ?? v) : v),
  ModelTier,
);

/** Where a model's tier came from (shown quietly in Admin → Models). */
export const TierSource = z.enum(['override', 'line', 'size', 'price', 'unknown']);
export type TierSource = z.infer<typeof TierSource>;

/** What a task needs of the model behind it (TR1). The router picks the best ready match and widens, in a fixed order, rather than fail. */
export const Want = z.object({
  tier: TierName,
  /** Never go below this tier, even when widening. */
  floor: TierName.optional(),
  /** `generator`: prefer a model from another family than the one that wrote the text. */
  distinct_family: z.literal('generator').nullable().optional(),
  needs: z.array(z.enum(['vision', 'tools', 'json'])).default([]),
  ctx_tokens: z.number().int().positive().optional(),
});
export type Want = z.infer<typeof Want>;

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

/**
 * A line a model belongs to when its id alone cannot say (OpenRouter's, which carries a vendor and uses
 * its own spellings). `id` is the line inside its provider (`openrouter/<id>`), `version` orders the
 * generations of one line (the newest is current, the one before it previous), and `company` is the
 * name pickers group by. Direct providers need none: their ids are read by services/core/src/models/watch/lines.ts.
 */
export const ModelLineSpec = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a lower-case slug such as anthropic-opus'),
  name: z.string(),
  tier: z.enum(['best', 'balanced', 'fast']),
  version: z.string().regex(/^\d+(\.\d+)*$/, 'a version such as 5.5'),
  company: z.string(),
  /** A preview stays off while another model of its line is stable. */
  preview: z.boolean().optional(),
});
export type ModelLineSpec = z.infer<typeof ModelLineSpec>;

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
  /** The line this model belongs to, when its id cannot say (see ModelLineSpec). */
  line: ModelLineSpec.optional(),
  /** Pin this model's tier; otherwise it is read from its line, its size or its price. */
  tier: ModelTier.optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ModelsFile = z.object({
  version: z.literal(1),
  /** The date the prices below were last checked by hand (ISO); live checks show it when they fall back (MD5). */
  prices_as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  models: z.array(ModelConfig).superRefine((models, ctx) => {
    // One id, one model: a repeat would shadow the first silently.
    const seen = new Set<string>();
    models.forEach((m, i) => {
      if (seen.has(m.id))
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `"${m.id}" is listed twice` });
      seen.add(m.id);
    });
  }),
});

export const TaskClass = z.string().regex(/^[a-z]+(\.[a-z_]+)*$/);

export const ChainSpec = z.union([
  z.array(z.string()),
  z.object({
    /** Models tried first, in order (pins). With `want`, the router fills in behind them. */
    chain: z.array(z.string()).default([]),
    prefer_different_family: z.boolean().default(false),
    /** What the task needs; the router finds the best ready model for it (TR1). */
    want: Want.optional(),
    /** Step up a tier on low confidence, disagreement or criticality (fact-check), at most twice. */
    escalate: z.boolean().default(false),
  }),
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
  /** The most web lookups through a model may cost in a day, in USD. SearXNG is not counted. 0 turns them off. */
  web_daily_cap_usd: z.number().min(0).default(0.25),
  /**
   * Hard limits on one fact-check. A claim that hits one reads "Not checked: <reason>" and the check
   * goes on; the run never crashes and never walks the whole list of models.
   */
  limits: z
    .object({
      /** Model calls for one claim, escalation and repair retries included. */
      calls_per_claim: z.number().int().min(1).max(10).default(3),
      /** Model calls for the whole answer, extraction included (never more than 3 per claim plus 2). */
      calls_per_check: z.number().int().min(1).max(100).default(20),
      /** Minutes the whole check may take. */
      minutes: z.number().min(0.5).max(60).default(6),
      /** Most one check may spend on models, in USD. Claude Code's plan use is not counted. */
      spend_usd: z.number().min(0).default(0.5),
    })
    .default({ calls_per_claim: 3, calls_per_check: 20, minutes: 6, spend_usd: 0.5 }),
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
