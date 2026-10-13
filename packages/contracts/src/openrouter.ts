/**
 * ------------------------------------------------------------------
 *  Title    |  OpenRouter: endpoints, routing, cost and choosing
 *  Ref      |  docs/openrouter.md · DESIGN.md §7.2
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes behind the endpoint explorer, the routing
 *           |  presets, which provider served an answer, the cost
 *           |  calculator and the model-choosing assistant.
 *  How      |  GET /openrouter/endpoints?model= answers EndpointsReport.
 *           |  GET/PUT /openrouter/routing?scope=&id= reads and writes a
 *           |  RoutingSettings override (model, notebook or thread; a
 *           |  flow node keeps its own in its params as `routing`).
 *           |  POST /openrouter/routing/preview answers RoutingPreview.
 *           |  POST /cost/estimate answers CostEstimate. POST /advisor
 *           |  answers AdvisorResult. GET /usage/history answers
 *           |  UsageHistory.
 *  Note     |  OpenRouter's provider object is passed through as it is
 *           |  documented (openrouter.ai/docs, provider routing). Prices
 *           |  here are US dollars per million tokens.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** The id OpenRouter's own router answers to. Which model it used is only known afterwards. */
export const OPENROUTER_AUTO = 'openrouter/auto';

/** Precision values OpenRouter reports and filters on. */
export const OrQuantization = z.enum([
  'int4',
  'int8',
  'fp4',
  'mxfp4',
  'nvfp4',
  'fp6',
  'fp8',
  'mxfp8',
  'fp16',
  'bf16',
  'fp32',
  'unknown',
]);
export type OrQuantization = z.infer<typeof OrQuantization>;

/** Rough bits per weight, for ordering precisions (a floor keeps this many or more). */
export const QUANT_BITS: Record<OrQuantization, number> = {
  int4: 4,
  fp4: 4,
  mxfp4: 4,
  nvfp4: 4,
  fp6: 6,
  int8: 8,
  fp8: 8,
  mxfp8: 8,
  fp16: 16,
  bf16: 16,
  fp32: 32,
  unknown: 0,
};

/** OpenRouter's `provider` request object, field for field. */
export const OrProviderObject = z
  .object({
    order: z.array(z.string().min(1)).optional(),
    only: z.array(z.string().min(1)).optional(),
    ignore: z.array(z.string().min(1)).optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(['allow', 'deny']).optional(),
    zdr: z.boolean().optional(),
    quantizations: z.array(OrQuantization).optional(),
    sort: z.enum(['price', 'throughput', 'latency']).optional(),
    max_price: z
      .object({
        prompt: z.number().nonnegative().optional(),
        completion: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OrProviderObject = z.infer<typeof OrProviderObject>;

export const RoutingPreset = z.enum([
  'recommended',
  'best_quality',
  'lowest_cost',
  'fastest',
  'pinned',
  'advanced',
]);
export type RoutingPreset = z.infer<typeof RoutingPreset>;

/** What a person chose for one model, notebook, thread or flow step. */
export const RoutingSettings = z
  .object({
    preset: RoutingPreset.default('recommended'),
    /** Pinned: providers to try, in order (OpenRouter's provider names, e.g. "DeepInfra"). */
    providers: z.array(z.string().min(1).max(80)).max(20).default([]),
    /** Providers to leave out (a retry after one cut an answer off adds it here). */
    avoid: z.array(z.string().min(1).max(80)).max(50).default([]),
    /** Ask providers not to keep or train on prompts (data_collection: deny). */
    deny_data_collection: z.boolean().default(false),
    /** Keep only endpoints at this precision or better; null: any. */
    min_precision: OrQuantization.nullable().default(null),
    /** The answer budget sent as max_tokens; null: the model's own default in Ancile. */
    max_tokens: z.number().int().positive().max(2_000_000).nullable().default(null),
    /** Advanced: the provider object exactly as typed; replaces what the preset would build. */
    advanced: OrProviderObject.nullable().default(null),
  })
  .strict();
export type RoutingSettings = z.infer<typeof RoutingSettings>;

export const RoutingScope = z.enum(['model', 'notebook', 'thread']);
export type RoutingScope = z.infer<typeof RoutingScope>;

export const RoutingOverride = z.object({
  scope: RoutingScope,
  id: z.string().min(1).max(200),
  settings: RoutingSettings.nullable(),
});
export type RoutingOverride = z.infer<typeof RoutingOverride>;

export const EndpointWarningCode = z.enum([
  'short_context',
  'short_output',
  'no_tools',
  'not_original_precision',
  'unknown_precision',
  'low_uptime',
  'no_cache_price',
]);
export type EndpointWarningCode = z.infer<typeof EndpointWarningCode>;

export const EndpointWarning = z.object({ code: EndpointWarningCode, text: z.string() });
export type EndpointWarning = z.infer<typeof EndpointWarning>;

export const OrEndpoint = z.object({
  /** OpenRouter's provider name, as `order` and `only` take it. */
  provider: z.string(),
  tag: z.string().nullable(),
  precision: OrQuantization,
  /** true: the lab's own release precision; false: reduced; null: not known. */
  original_precision: z.boolean().nullable(),
  context: z.number().int().nonnegative().nullable(),
  /** context as a share of the model's native window, 0 to 100; null when either is unknown. */
  context_pct: z.number().min(0).max(100).nullable(),
  max_output: z.number().int().nonnegative().nullable(),
  tools: z.boolean(),
  /** USD per million tokens. */
  price: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative().nullable(),
    cache_write: z.number().nonnegative().nullable(),
  }),
  /** Share of requests answered over the last 30 minutes, 0 to 100. */
  uptime: z.number().min(0).max(100).nullable(),
  supported_parameters: z.array(z.string()),
  warnings: z.array(EndpointWarning),
});
export type OrEndpoint = z.infer<typeof OrEndpoint>;

export const EndpointsReport = z.object({
  model: z.string(),
  name: z.string(),
  /** The model's own window, as its lab released it (from config, else the largest endpoint's). */
  native_context: z.number().int().nullable(),
  /** The lab's release precision when known, and where that is written down. */
  original_precision: z.object({ precision: OrQuantization, source: z.string().url() }).nullable(),
  endpoints: z.array(OrEndpoint),
  fetched_at: z.string(),
  /** Answered from the saved copy because OpenRouter could not be reached. */
  offline: z.boolean(),
});
export type EndpointsReport = z.infer<typeof EndpointsReport>;

/** What a routing choice would send, and what it means. */
export const RoutingPreview = z.object({
  provider: OrProviderObject,
  max_tokens: z.number().int().positive().nullable(),
  /** Auto Exacto (OpenRouter's tool-calling ordering) still applies to tool calls. */
  auto_exacto: z.boolean(),
  /** Plain sentences: what this does, and what it turns off. */
  notes: z.array(z.string()),
});
export type RoutingPreview = z.infer<typeof RoutingPreview>;

export const RoutingPreviewRequest = z
  .object({
    model: z.string().min(1),
    settings: RoutingSettings,
    /** What the job needs, to rule out endpoints that cannot hold it. */
    need: z
      .object({
        context: z.number().int().nonnegative().default(0),
        output: z.number().int().nonnegative().default(0),
        tools: z.boolean().default(false),
      })
      .default({ context: 0, output: 0, tools: false }),
  })
  .strict();
export type RoutingPreviewRequest = z.infer<typeof RoutingPreviewRequest>;

/* ---- which provider served ---------------------------------------------- */

/** Recorded on a message's usage when the model ran through OpenRouter. */
export const ServedBy = z.object({
  /** OpenRouter's provider name, e.g. "DeepInfra". */
  provider: z.string().nullable(),
  /** The model that answered; differs from the asked one under openrouter/auto. */
  model: z.string().nullable(),
  /** The answer stopped at the endpoint's output limit (finish_reason length). */
  cut_off: z.boolean(),
});
export type ServedBy = z.infer<typeof ServedBy>;

/* ---- cost calculator ----------------------------------------------------- */

export const CostEstimateRequest = z
  .object({
    model: z.string().min(1),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    /** Tokens written to the cache per turn (Anthropic-style explicit caching); 0 for most. */
    cache_write_tokens: z.number().int().nonnegative().default(0),
    /** Share of input read from cache, 0 to 1; null: from this person's history (else 0). */
    cache_hit_rate: z.number().min(0).max(1).nullable().default(null),
    messages_per_day: z.number().nonnegative().max(1_000_000).default(50),
    /** For the RunPod comparison: what the GPU costs an hour. */
    gpu_usd_per_hour: z.number().nonnegative().max(1_000).nullable().default(null),
    /** For the RunPod comparison: tokens a second it can produce. */
    gpu_tokens_per_second: z.number().positive().max(100_000).nullable().default(null),
  })
  .strict();
export type CostEstimateRequest = z.infer<typeof CostEstimateRequest>;

export const CostRow = z.object({
  provider: z.string(),
  per_turn: z.number().nonnegative(),
  per_day: z.number().nonnegative(),
  per_month: z.number().nonnegative(),
  /** What the price sort would rank by: list input + output, no cache. */
  list_per_turn: z.number().nonnegative(),
  /** Can it hold the turn (context, output)? */
  fits: z.boolean(),
});
export type CostRow = z.infer<typeof CostRow>;

export const CostEstimate = z.object({
  model: z.string(),
  cache_hit_rate: z.number().min(0).max(1),
  /** Where the hit rate came from. */
  cache_hit_from: z.enum(['given', 'history', 'none']),
  /** Cheapest real cost first. */
  rows: z.array(CostRow),
  runpod: z
    .object({
      usd_per_hour: z.number().nonnegative(),
      /** Tokens a month at which a GPU running all day costs the same as the cheapest endpoint. */
      break_even_tokens_per_month: z.number().nonnegative().nullable(),
      /** What the month's turns would need of GPU time, in hours, at the given speed. */
      hours_needed_per_month: z.number().nonnegative().nullable(),
    })
    .nullable(),
  claude_code: z
    .object({
      /** Highest share used in any plan window, 0 to 100; null when not known. */
      used_percent: z.number().min(0).max(100).nullable(),
      note: z.string(),
    })
    .nullable(),
});
export type CostEstimate = z.infer<typeof CostEstimate>;

/** This person's own mix, per model and provider, over the last 30 days. */
export const UsageHistory = z.object({
  rows: z.array(
    z.object({
      model_id: z.string(),
      provider: z.string().nullable(),
      answers: z.number().int().nonnegative(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cached_tokens: z.number().int().nonnegative(),
      /** cached ÷ input, 0 to 1. */
      cache_hit_rate: z.number().min(0).max(1),
      /** input ÷ (input + output), 0 to 1. */
      input_share: z.number().min(0).max(1),
    }),
  ),
});
export type UsageHistory = z.infer<typeof UsageHistory>;

/* ---- model-choosing assistant -------------------------------------------- */

export const JobKind = z.enum(['agent_tools', 'long_documents', 'chat', 'coding', 'reasoning', 'cheap_bulk']);
export type JobKind = z.infer<typeof JobKind>;

export const AdvisorRequest = z
  .object({
    /** A sentence describing the job; read for hints when no kind is picked. */
    describe: z.string().max(1_000).default(''),
    kind: JobKind.nullable().default(null),
    budget: z.enum(['low', 'medium', 'high']).default('medium'),
    privacy: z.enum(['any', 'no_training', 'local_only']).default('any'),
    speed: z.enum(['any', 'fast']).default('any'),
    /** Ask the local model for a short explanation (never a paid model). */
    explain: z.boolean().default(false),
  })
  .strict();
export type AdvisorRequest = z.infer<typeof AdvisorRequest>;

export const AdvisorOption = z.object({
  where: z.enum(['openrouter', 'local', 'runpod', 'claude_code', 'direct']),
  model_id: z.string(),
  name: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
  /** For OpenRouter: the routing preset to use. */
  preset: RoutingPreset.nullable(),
  /** Rough cost per 1,000 turns of the job's typical size, USD; null when not priced per token. */
  cost_per_1k_turns: z.number().nonnegative().nullable(),
});
export type AdvisorOption = z.infer<typeof AdvisorOption>;

export const AdvisorResult = z.object({
  kind: JobKind,
  options: z.array(AdvisorOption).max(3),
  /** From the local model, when asked and available. */
  explanation: z.string().nullable(),
});
export type AdvisorResult = z.infer<typeof AdvisorResult>;

/* ---- config/openrouter.yaml ---------------------------------------------- */

export const OpenRouterFile = z.object({
  version: z.literal(1),
  /** How long a model's endpoint list is trusted before asking again, in minutes. */
  endpoints_ttl_minutes: z.number().int().min(1).max(10_080).default(30),
  /** The lab's own release precision and native window, with where it says so. */
  precision: z
    .array(
      z.object({
        /** A model id, or a prefix ending in "*" ("deepseek/*"). */
        model: z.string().min(1),
        precision: OrQuantization,
        context: z.number().int().positive().optional(),
        source: z.string().url(),
      }),
    )
    .default([]),
  /** Best quality: providers ranked first for these models (most trusted first). */
  trusted: z
    .array(z.object({ model: z.string().min(1), providers: z.array(z.string().min(1)).min(1) }))
    .default([]),
});
export type OpenRouterFile = z.infer<typeof OpenRouterFile>;

/* ---- quantization for local and rented models ----------------------------- */

/** Ollama's common GGUF tags, smallest first. */
export const OllamaQuant = z.enum(['q4_K_M', 'q5_K_M', 'q8_0', 'fp16']);
export type OllamaQuant = z.infer<typeof OllamaQuant>;

/** Bits per weight on disk, including GGUF's overhead (llama.cpp's published figures, rounded). */
export const OLLAMA_QUANT_BITS: Record<OllamaQuant, number> = {
  q4_K_M: 4.85,
  q5_K_M: 5.7,
  q8_0: 8.5,
  fp16: 16,
};

/** vLLM's quantization choices for a rented node. original: the repo as released. */
export const VllmQuant = z.enum(['original', 'awq', 'gptq', 'fp8']);
export type VllmQuant = z.infer<typeof VllmQuant>;

export const VLLM_QUANT_BITS: Record<VllmQuant, number> = { original: 16, awq: 4.25, gptq: 4.25, fp8: 8 };

export const VllmChoice = z
  .object({
    /** Hugging Face repo to serve, e.g. "Qwen/Qwen3-32B-AWQ". */
    model: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
    quantization: VllmQuant.default('original'),
    max_model_len: z.number().int().min(512).max(2_000_000).optional(),
  })
  .strict();
export type VllmChoice = z.infer<typeof VllmChoice>;

/** The node bootstrap's environment for a vLLM choice (infra/node/bootstrap.sh reads it). */
export function vllmEnv(c: VllmChoice): Record<string, string> {
  const args: string[] = [];
  if (c.quantization !== 'original') args.push('--quantization', c.quantization);
  if (c.max_model_len) args.push('--max-model-len', String(c.max_model_len));
  return { ANCILE_MODEL: c.model, ...(args.length && { ANCILE_VLLM_ARGS: args.join(' ') }) };
}

/**
 * Memory to hold a model's weights plus a working cache, in GB.
 * weights = params × bits ÷ 8; the cache grows with the window (about
 * 0.12 GB per 1,000 tokens for a 30B-class model, scaled by size); 10%
 * on top for the runtime. An estimate, said as one.
 */
export function memoryEstimateGb(paramsB: number, bits: number, contextTokens = 8_192): number {
  const weights = (paramsB * bits) / 8;
  const kv = (contextTokens / 1_000) * 0.12 * Math.max(0.25, paramsB / 30);
  return Math.round((weights + kv) * 1.1 * 10) / 10;
}

export type VramVerdict = 'fits' | 'tight' | 'no';
export function vramFit(needGb: number, haveGb: number): VramVerdict {
  if (needGb <= haveGb * 0.9) return 'fits';
  if (needGb <= haveGb) return 'tight';
  return 'no';
}
