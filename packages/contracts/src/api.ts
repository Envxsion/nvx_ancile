/**
 * Request and response bodies for the Cockpit ↔ Core API (DESIGN.md §4.1).
 * Only the shapes with real structure are here; trivial CRUD bodies are
 * defined beside their routes and re-exported as they stabilise.
 * TODO(phase-2..5): grow with each route; every route gets a contract test.
 */
import { z } from 'zod';
import { ModelHue } from './config';
import { RunStatus } from './events';
import { Message, Part } from './messages';
import { DecisionScope } from './permissions';

export const API_VERSION = 'v1';

export const SendMessageRequest = z
  .object({
    parent_id: z.string().nullable(),
    parts: z.array(Part).min(1),
    /**
     * A model chosen for this message (@model, "just the next message"): it
     * answers instead of any flow. Otherwise the thread's model, then
     * default_model, then the task class, and only when no flow answers.
     */
    model: z.string().optional(),
    /** Your default for plain chat; never overrides a flow or the thread's model. */
    default_model: z.string().optional(),
    /** Flows: answer this one message through this flow (`@flow` in the composer). */
    flow_id: z.string().optional(),
    task_class: z.string().default('chat.default'),
    /** @-mentions resolved by the composer */
    mentions: z
      .array(
        z.object({
          kind: z.enum(['source', 'notebook', 'thread', 'model', 'memory', 'repo']),
          id: z.string(),
        }),
      )
      .default([]),
    client_message_id: z.string().optional(), // for optimistic reconciliation
  })
  .strict();

export const SendMessageResponse = z.object({
  run_id: z.string(),
  user_message_id: z.string(),
  assistant_message_id: z.string(),
  stream_url: z.string(),
});

export const Run = z.object({
  id: z.string(),
  kind: z.enum(['chat_turn', 'agent', 'research', 'factcheck', 'automation', 'diagnostic', 'flow_try']),
  status: RunStatus,
  thread_id: z.string().nullable(),
  message_id: z.string().nullable(),
  step_cursor: z.number().int(),
  trace_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

// The branch tree, compare and merge shapes live in branching.ts.

export const ApprovalDecision = z.object({
  decision: z.enum(['approve', 'deny']),
  scope: DecisionScope,
  pattern: z.string().optional(),
  ttl_seconds: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export const ContextBudget = z.object({
  model_id: z.string(),
  window: z.number().int(),
  used: z.object({
    system: z.number().int(),
    memory: z.number().int(),
    retrieval: z.number().int(),
    history: z.number().int(),
    reserve_output: z.number().int(),
  }),
  ratio: z.number(),
  level: z.enum(['ok', 'warn', 'critical']),
});

// Explain moved to factcheck.ts (Phase 4), with the shape the route returns.

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

/* ---- Threads (Phase 2) --------------------------------------------------- */

export const ThreadSettings = z
  .object({
    /** The model this thread asks first; null means the task class decides. */
    model: z.string().nullable().default(null),
    /** Flows: this thread's own flow (overrides its notebook's and the workspace default). */
    flow_id: z.string().nullable().default(null),
    /** Flows: node parameter overrides for this thread only, by node id. */
    flow_overrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    /**
     * The flow those overrides were made for. They apply to that flow only, so
     * moving the thread or changing its notebook's flow never lands them on
     * another flow's node of the same name.
     */
    flow_overrides_flow: z.string().nullable().optional(),
    /** The lab's engine session for this thread, reused by every "Run in lab". */
    lab_session: z.string().optional(),
  })
  .partial();

export const Thread = z.object({
  id: z.string(),
  title: z.string(),
  notebook_id: z.string().nullable(),
  active_head_id: z.string().nullable(),
  settings: ThreadSettings,
  /** Pinned threads sit at the top of the rail, in pin order. */
  pinned_at: z.string().nullable().default(null),
  archived_at: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Thread = z.infer<typeof Thread>;

export const ThreadSummary = Thread.extend({
  /** Number of leaf messages: 1 means a straight line, more means branches. */
  branches: z.number().int(),
  /** A run is streaming or waiting in this thread right now. */
  live: z.boolean(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const CreateThreadRequest = z
  .object({
    title: z.string().min(1).max(200).optional(),
    notebook_id: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  })
  .strict();

export const PatchThreadRequest = z
  .object({
    title: z.string().min(1).max(200).optional(),
    model: z.string().nullable().optional(),
    active_head_id: z.string().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    /** Move the thread into a notebook, or out of one with null. */
    notebook_id: z.string().nullable().optional(),
    /** Flows: this thread's flow; 'off' answers without one; null follows the notebook. */
    flow_id: z.string().nullable().optional(),
    /** Flows: node parameter overrides for this thread only, by node id. */
    flow_overrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    /** The flow the overrides are for (required with flow_overrides to take effect). */
    flow_overrides_flow: z.string().nullable().optional(),
  })
  .strict();

/** GET /threads query: ?q= searches titles and message text; ?archived=1 lists the archive. */
export const ThreadListQuery = z.object({
  q: z.string().max(400).optional(),
  notebook_id: z.string().optional(),
  archived: z.enum(['0', '1']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** A search hit inside a thread's messages. */
export const ThreadSearchHit = z.object({
  thread_id: z.string(),
  message_id: z.string(),
  title: z.string(),
  /** The matching passage with the match wrapped in «…». */
  snippet: z.string(),
  updated_at: z.string(),
});
export type ThreadSearchHit = z.infer<typeof ThreadSearchHit>;

/** One branch of a thread, root to head, ready to render. */
export const ThreadPath = z.object({
  thread: Thread,
  head_id: z.string().nullable(),
  messages: z.array(Message),
  /** A run still producing the last message, to attach its stream. */
  active_run: z.object({ id: z.string(), message_id: z.string().nullable(), status: RunStatus }).nullable(),
});
export type ThreadPath = z.infer<typeof ThreadPath>;

export const RegenerateRequest = z
  .object({
    model: z.string().optional(),
    /** Flows: 'same' replays the recorded route, 'again' lets the flow decide afresh (default). */
    route: z.enum(['same', 'again']).optional(),
  })
  .strict();
export const EditMessageRequest = z
  .object({ parts: z.array(Part).min(1), model: z.string().optional() })
  .strict();

/* ---- Models (Phase 2) ---------------------------------------------------- */

export const ModelStatus = z.enum(['ready', 'needs_key', 'disabled']);

export const ModelInfo = z.object({
  id: z.string(),
  display_name: z.string(),
  provider: z.string(),
  family: z.string(),
  via: z.enum(['direct', 'controller']),
  context_window: z.number().int(),
  max_output: z.number().int(),
  capabilities: z.array(z.string()),
  price: z.object({ input_per_mtok: z.number(), output_per_mtok: z.number() }),
  status: ModelStatus,
  /** The secret this model needs, so Settings can ask for exactly that key. */
  secret: z.string().nullable(),
  /** The built-in offline test model: answers without a key or a network. */
  offline: z.boolean(),
  /** Added by you in Settings → Models (can be edited and removed); absent for config models. */
  custom: z.boolean().optional(),
  /** OpenAI-compatible endpoint models: where they are served. */
  base_url: z.string().nullable().optional(),
  /** The chip's hue you chose; null or absent follows the family. */
  hue: ModelHue.nullable().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/* ---- Routing chains (Admin → Routing) ------------------------------------ */

/** One task class's fallback chain: GET /routing items, and the answer to PUT and DELETE. */
export const RoutingChain = z.object({
  task_class: z.string(),
  /** The models routing tries right now, in order: only those that can answer. */
  chain: z.array(z.string()),
  /** False when no model in the chain can answer yet. */
  ok: z.boolean(),
  /** The chain as set, ready or not: your saved order when you have one, otherwise config/routing.yaml. */
  configured: z.array(z.string()),
  /** The chain in config/routing.yaml; DELETE goes back to it. */
  default: z.array(z.string()),
  /** True when a chain saved in Admin → Routing wins over config/routing.yaml. */
  custom: z.boolean(),
});
export type RoutingChain = z.infer<typeof RoutingChain>;

export const RoutingList = z.object({ items: z.array(RoutingChain) });
export type RoutingList = z.infer<typeof RoutingList>;

/**
 * PUT /routing/:task_class: save this order for the task class. Every id
 * must be a known chat model; an empty chain is refused (`routing.chain_empty`).
 */
export const PutRoutingRequest = z.object({ chain: z.array(z.string().min(1).max(200)).max(32) }).strict();
export type PutRoutingRequest = z.infer<typeof PutRoutingRequest>;

/* ---- Adding models (Settings → Models, flow model picker) ------------------ */

/** Where an added model is served. `openai-compatible` covers vLLM, LM Studio, a RunPod proxy URL, a LAN box. */
export const ModelSource = z.enum(['openrouter', 'anthropic', 'openai', 'google', 'openai-compatible']);
export type ModelSource = z.infer<typeof ModelSource>;

export const AddModelRequest = z
  .object({
    source: ModelSource,
    /** The provider's own model id, e.g. "meta-llama/llama-4-maverick" or "claude-opus-5-5". */
    provider_model: z.string().min(1).max(200),
    display_name: z.string().min(1).max(120).optional(),
    /** For openai-compatible: the server's base URL, ending before /chat/completions (…/v1). */
    base_url: z.string().url().optional(),
    /** For openai-compatible: its API key, stored encrypted; never returned. Omit for none. */
    api_key: z.string().min(1).max(4000).optional(),
    family: z.string().min(1).max(60).optional(),
    context_window: z.number().int().positive().max(10_000_000).optional(),
    max_output: z.number().int().positive().max(1_000_000).optional(),
    capabilities: z.array(z.enum(['tools', 'vision', 'reasoning', 'json', 'audio'])).optional(),
    price: z.object({ input_per_mtok: z.number().min(0), output_per_mtok: z.number().min(0) }).optional(),
    enabled: z.boolean().default(true),
    hue: ModelHue.optional(),
  })
  .strict();
export type AddModelRequest = z.infer<typeof AddModelRequest>;

/** PATCH /models/:id for an added model; config models only take `enabled` and `hue`. */
export const PatchModelRequest = z
  .object({
    enabled: z.boolean().optional(),
    display_name: z.string().min(1).max(120).optional(),
    family: z.string().min(1).max(60).optional(),
    context_window: z.number().int().positive().max(10_000_000).optional(),
    max_output: z.number().int().positive().max(1_000_000).optional(),
    capabilities: z.array(z.enum(['tools', 'vision', 'reasoning', 'json', 'audio'])).optional(),
    price: z.object({ input_per_mtok: z.number().min(0), output_per_mtok: z.number().min(0) }).optional(),
    base_url: z.string().url().optional(),
    /** Replace the endpoint's key (openai-compatible only). */
    api_key: z.string().min(1).max(4000).optional(),
    /** Use a key already in the encrypted store, by name; null sends no key (openai-compatible only). */
    secret: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,79}$/, 'A key name, like MY_SERVER_KEY')
      .nullable()
      .optional(),
    /** The chip's hue; null goes back to the family's. */
    hue: ModelHue.nullable().optional(),
  })
  .strict();
export type PatchModelRequest = z.infer<typeof PatchModelRequest>;

/** One model a source offers, for picking before adding. */
export const CatalogueModel = z.object({
  provider_model: z.string(),
  display_name: z.string(),
  context_window: z.number().int().nullable(),
  max_output: z.number().int().nullable(),
  price: z.object({ input_per_mtok: z.number(), output_per_mtok: z.number() }).nullable(),
  capabilities: z.array(z.string()),
  family: z.string(),
  description: z.string().nullable(),
  /** Already in your registry. */
  added: z.boolean(),
});
export type CatalogueModel = z.infer<typeof CatalogueModel>;

/** POST /models/catalogue: list what a source offers (OpenRouter's catalogue, or an endpoint's /v1/models). */
export const CatalogueRequest = z
  .object({
    source: ModelSource,
    base_url: z.string().url().optional(),
    api_key: z.string().min(1).max(4000).optional(),
    q: z.string().max(200).optional(),
  })
  .strict();
export type CatalogueRequest = z.infer<typeof CatalogueRequest>;

/* ---- Approvals (Phase 2) ------------------------------------------------- */

export const Approval = z.object({
  id: z.string(),
  run_id: z.string(),
  thread_id: z.string().nullable(),
  tool: z.string(),
  action: z.string(),
  resource: z.string(),
  tier: z.enum(['gated', 'critical']),
  args_preview: z.unknown(),
  suggestions: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  created_at: z.string(),
  expires_at: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

/* ---- Onboarding (Phase 2) ------------------------------------------------ */

export const ProviderId = z.enum(['anthropic', 'openai', 'google', 'openrouter', 'ollama']);
export type ProviderId = z.infer<typeof ProviderId>;

export const SetupStatus = z.object({
  complete: z.boolean(),
  preset: z.enum(['careful', 'balanced', 'hands_off']).nullable(),
  providers: z.array(
    z.object({
      id: ProviderId,
      display_name: z.string(),
      configured: z.boolean(),
      /** Ollama needs no key, only a reachable server. */
      needs_key: z.boolean(),
    }),
  ),
  /** The offline test model is available (no key needed). */
  offline_model: z.boolean(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

export const ProviderTestRequest = z
  .object({
    provider: ProviderId,
    key: z.string().min(1).max(500).optional(),
    base_url: z.string().url().optional(),
    /** Store the key once it passes. */
    save: z.boolean().default(true),
  })
  .strict();

export const ProviderTestResponse = z.object({
  ok: z.literal(true),
  provider: ProviderId,
  model: z.string(),
  latency_ms: z.number(),
  /** Models switched on because this provider now works. */
  enabled: z.array(z.string()),
});

export const MemoryCapture = z.enum(['auto_confident', 'propose_all', 'off']);

export const SetupCompleteRequest = z
  .object({
    preset: z.enum(['careful', 'balanced', 'hands_off']),
    /** How memory capture behaves (used from Phase 4). */
    memory_capture: MemoryCapture.optional(),
    /** Anything the user wants remembered from the start. */
    about: z.string().max(4_000).optional(),
  })
  .strict();

/* ---- Drafts and UI state (Phase 2) --------------------------------------- */

export const Draft = z.object({ text: z.string().max(200_000), updated_at: z.string().optional() });
export type Draft = z.infer<typeof Draft>;
