/**
 * ------------------------------------------------------------------
 *  Title    |  Flows
 *  Ref      |  DESIGN.md §16 · ROADMAP.md Phase 5b
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  A flow is a graph you draw that decides how a message is
 *           |  answered: which models run, in what order, what each
 *           |  one is shown, and how their work becomes one answer.
 *  How      |  Nodes are a discriminated union on `kind`; every kind
 *           |  keeps its parameters in `params`. Edges join an output
 *           |  port to an input port and say what context crosses them.
 *           |  A flow is versioned; every answer records the version,
 *           |  the path taken and every decision on it.
 *  Note     |  Canvas-only kinds (note, group) never execute.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/* ---- Context policy (DESIGN §16.2) ---------------------------------------- */

export const ConversationContext = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('last_n'), n: z.number().int().min(1).max(200) }),
  z.object({ mode: z.literal('branch') }),
  z.object({ mode: z.literal('tldr') }),
  /** This branch plus a short summary of its sibling branches (what else was tried). */
  z.object({ mode: z.literal('siblings') }),
  /** A summary of the whole tree, every branch. */
  z.object({ mode: z.literal('tree_summary') }),
]);

export const SourcesContext = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('retrieved'), k: z.number().int().min(1).max(50).default(8) }),
  z.object({ mode: z.literal('named'), source_ids: z.array(z.string()).max(100) }),
]);

export const ContextPolicy = z.object({
  conversation: ConversationContext.default({ mode: 'branch' }),
  sources: SourcesContext.default({ mode: 'retrieved', k: 8 }),
  memory: z.enum(['none', 'pack', 'project']).default('pack'),
  /** What earlier nodes' work this node sees. */
  upstream: z.enum(['none', 'plan', 'previous', 'all']).default('previous'),
  /** Cap for the whole payload; trimmed upstream → sources → conversation → memory. */
  budget_tokens: z.number().int().min(256).max(1_000_000).optional(),
});
export type ContextPolicy = z.infer<typeof ContextPolicy>;

/** Pass everything (the default for a plain chat). */
export const FULL_CONTEXT: ContextPolicy = ContextPolicy.parse({});

/* ---- Rule conditions ---------------------------------------------------------- */

export const RuleCondition = z.object({
  field: z.enum([
    'text', // the message text
    'notebook', // notebook id the thread is in
    'mentions_model', // the composer named a model
    'has_attachment',
    'length', // characters in the message
    'hour', // local hour 0-23
    'budget_left_usd', // what is left of the turn's cost cap
    'branch_depth', // messages on the path
    'language', // detected language, ISO 639-1
    'node_awake', // a GPU node (value: controller node id) is running now
    'month_spend_usd', // spend so far this month, all models
  ]),
  op: z.enum(['contains', 'matches', 'equals', 'not_equals', 'gt', 'lt', 'in']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});
export type RuleCondition = z.infer<typeof RuleCondition>;

/* ---- Nodes ------------------------------------------------------------------- */

const nodeBase = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  label: z.string().max(80).optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  /** Identity-ramp hue for the node chrome. */
  color: z.string().max(20).optional(),
  /** Skipped when executing (edges pass straight through), kept on the canvas. */
  disabled: z.boolean().optional(),
  /** Group this node sits in (a group node's id). */
  parent: z.string().optional(),
  /** Free notes shown on hover; never sent to a model. */
  notes: z.string().max(2000).optional(),
};

export const ModelParams = z.object({
  /** A registry model id: anthropic/…, openai/…, openrouter/…, ollama/…, controller/… */
  model: z.string().min(1),
  role: z.string().max(20_000).default(''),
  temperature: z.number().min(0).max(2).optional(),
  max_output: z.number().int().min(1).max(200_000).optional(),
  reasoning: z.enum(['off', 'low', 'medium', 'high']).optional(),
  /** Tool names it may call (still gated by permissions); [] = none. */
  tools: z.array(z.string()).default([]),
  /** Tried in order when the model fails. */
  fallbacks: z.array(z.string()).max(8).default([]),
  cost_cap_usd: z.number().min(0).optional(),
  /** Its text streams into the visible answer (the last writer usually). */
  speaks: z.boolean().default(false),
  /** A fixed output used instead of calling the model (iterate on the rest cheaply). */
  pinned_output: z.string().max(200_000).optional(),
  /** Reuse an earlier identical call's output for this many seconds. */
  cache_s: z
    .number()
    .int()
    .min(0)
    .max(30 * 86_400)
    .optional(),
  /** For a model on a sleeping GPU node: wait this long for it to wake, else take the fallbacks. */
  wait_for_wake_s: z.number().int().min(0).max(900).optional(),
});
export type ModelParams = z.infer<typeof ModelParams>;

export const RouteOption = z.object({
  /** Matches an outgoing edge's `label`. */
  label: z.string().min(1).max(60),
  /** What belongs on this route, in plain words; the router reads it. */
  when: z.string().max(2000).default(''),
});

export const FlowNode = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('input'), params: z.object({}).default({}) }),
  z.object({
    ...nodeBase,
    kind: z.literal('output'),
    params: z.object({
      /** Compose the answer from several outputs; {{node_id}} placeholders. Empty: pass through. */
      template: z.string().max(20_000).default(''),
    }),
  }),
  z.object({ ...nodeBase, kind: z.literal('model'), params: ModelParams }),
  z.object({
    ...nodeBase,
    kind: z.literal('router'),
    params: z.object({
      model: z.string().min(1),
      instructions: z.string().max(20_000).default(''),
      routes: z.array(RouteOption).min(1).max(20),
      /** Taken when the router is unsure or fails. */
      default_route: z.string().optional(),
      /** Below this confidence the default route is taken. */
      min_confidence: z.number().min(0).max(1).default(0.5),
      /** May choose several routes at once (they run in parallel). */
      multi: z.boolean().default(false),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('rule'),
    params: z.object({
      rules: z
        .array(z.object({ label: z.string().min(1).max(60), all: z.array(RuleCondition).min(1) }))
        .max(50),
      default_route: z.string().optional(),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('manager'),
    params: ModelParams.extend({
      /** How it should plan and delegate; its workers are the nodes on its outgoing edges. */
      instructions: z.string().max(20_000).default(''),
      max_rounds: z.number().int().min(1).max(10).default(3),
    }),
  }),
  z.object({ ...nodeBase, kind: z.literal('parallel'), params: z.object({}).default({}) }),
  z.object({
    ...nodeBase,
    kind: z.literal('join'),
    params: z.object({
      mode: z.enum(['all', 'first', 'judge', 'vote']).default('all'),
      judge_model: z.string().optional(),
      judge_instructions: z.string().max(10_000).default(''),
    }),
  }),
  z.object({ ...nodeBase, kind: z.literal('context'), params: ContextPolicy }),
  z.object({
    ...nodeBase,
    kind: z.literal('tool'),
    params: z.object({
      tool: z.string().min(1),
      /** JSON with {{input}} / {{node_id}} placeholders. */
      args: z.string().max(20_000).default('{}'),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('template'),
    params: z.object({ template: z.string().max(50_000) }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('human'),
    params: z.object({
      /** Pauses the turn and asks you (an approval with your answer as output). */
      question: z.string().max(2000),
      show_upstream: z.boolean().default(true),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('retrieve'),
    params: z.object({
      /** Search query template; {{input}} by default. */
      query: z.string().max(4000).default('{{input}}'),
      k: z.number().int().min(1).max(50).default(8),
      source_ids: z.array(z.string()).max(100).optional(),
      rerank: z.boolean().default(true),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('factcheck'),
    params: z.object({
      /** Below this confidence the 'unsure' edge is taken (escalate, or add a caveat). */
      min_confidence: z.number().min(0).max(1).default(0.7),
      verifier: z.string().optional(),
      /** Add a visible caveat to the answer when it falls below the threshold. */
      caveat: z.boolean().default(true),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('loop'),
    params: z.object({
      /** Repeat the nodes on its 'body' edge until a judge says done, or the cap. */
      max_iterations: z.number().int().min(1).max(10).default(3),
      until_model: z.string().optional(),
      until: z.string().max(4000).default('The answer fully meets the request.'),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('subflow'),
    params: z.object({ flow_id: z.string().min(1) }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('note'),
    params: z.object({ text: z.string().max(10_000) }),
    size: z.object({ w: z.number(), h: z.number() }).optional(),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('group'),
    params: z.object({ collapsed: z.boolean().default(false) }),
    size: z.object({ w: z.number(), h: z.number() }),
  }),
]);
export type FlowNode = z.infer<typeof FlowNode>;
export type FlowNodeKind = FlowNode['kind'];

/** Kinds that run; note and group are canvas furniture. */
export const RUNNABLE_KINDS: FlowNodeKind[] = [
  'input',
  'output',
  'model',
  'router',
  'rule',
  'manager',
  'parallel',
  'join',
  'context',
  'tool',
  'template',
  'human',
  'subflow',
  'retrieve',
  'factcheck',
  'loop',
];

/* ---- Edges ------------------------------------------------------------------- */

export const FlowEdge = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  from: z.string(),
  to: z.string(),
  /** The route a router or rule chooses; a manager's worker name. */
  label: z.string().max(60).optional(),
  /** What crosses this edge; absent means the target's own policy or the default. */
  context: ContextPolicy.optional(),
  /** Bend points the user added on the canvas. */
  waypoints: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .max(20)
    .optional(),
});
export type FlowEdge = z.infer<typeof FlowEdge>;

/* ---- Flow ------------------------------------------------------------------- */

export const FlowScope = z.enum(['workspace', 'notebook', 'thread']);
export type FlowScope = z.infer<typeof FlowScope>;

export const FlowSettings = z.object({
  max_steps: z.number().int().min(1).max(200).default(24),
  cost_cap_usd: z.number().min(0).max(1000).default(1),
  timeout_s: z.number().int().min(10).max(3600).default(600),
  /** Teamwork fold open while the answer streams. */
  show_teamwork: z.enum(['open', 'collapsed', 'hidden']).default('collapsed'),
});
export type FlowSettings = z.infer<typeof FlowSettings>;

export const FlowGraph = z.object({
  nodes: z.array(FlowNode).max(300),
  edges: z.array(FlowEdge).max(1000),
  settings: FlowSettings.default(FlowSettings.parse({})),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
});
export type FlowGraph = z.infer<typeof FlowGraph>;

export const Flow = FlowGraph.extend({
  id: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  scope: FlowScope,
  /** Notebook or thread id for those scopes; null for the workspace. */
  scope_ref: z.string().nullable(),
  version: z.number().int().min(1),
  /** The workspace default, or the one a notebook/thread uses. */
  active: z.boolean(),
  /** The version answers use; later versions are drafts until published. Null: the latest. */
  published_version: z.number().int().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Flow = z.infer<typeof Flow>;

export const FlowSummary = Flow.pick({
  id: true,
  name: true,
  description: true,
  scope: true,
  scope_ref: true,
  version: true,
  active: true,
  updated_at: true,
}).extend({ nodes: z.number().int(), models: z.array(z.string()) });
export type FlowSummary = z.infer<typeof FlowSummary>;

export const SaveFlowRequest = FlowGraph.extend({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  /** Optimistic concurrency: the version you edited. */
  base_version: z.number().int().min(0),
  message: z.string().max(200).optional(),
});

export const CreateFlowRequest = FlowGraph.partial({ nodes: true, edges: true }).extend({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  scope: FlowScope,
  scope_ref: z.string().nullable().default(null),
  /** Start from a template id or another flow's id. */
  from: z.string().optional(),
  activate: z.boolean().default(false),
});

export const FlowVersion = z.object({
  version: z.number().int(),
  at: z.string(),
  message: z.string().nullable(),
  nodes: z.number().int(),
});

/* ---- Validation ---------------------------------------------------------------- */

export const FlowIssue = z.object({
  level: z.enum(['error', 'warning']),
  code: z.string(), // e.g. flow.cycle, flow.unreachable, flow.no_output, flow.model_unready
  message: z.string(),
  node_id: z.string().optional(),
  edge_id: z.string().optional(),
});
export type FlowIssue = z.infer<typeof FlowIssue>;

export const FlowEstimate = z.object({
  /** Per path from input to output: the models on it and a rough cost/latency. */
  paths: z.array(
    z.object({
      nodes: z.array(z.string()),
      models: z.array(z.string()),
      cost_usd: z.number(),
      latency_ms: z.number(),
    }),
  ),
});

export const ValidateFlowResponse = z.object({
  ok: z.boolean(),
  issues: z.array(FlowIssue),
  estimate: FlowEstimate,
});

/* ---- Runtime record (provenance.flow) ------------------------------------------ */

export const FlowDecision = z.object({
  node_id: z.string(),
  chose: z.array(z.string()),
  reason: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
});
export type FlowDecision = z.infer<typeof FlowDecision>;

export const FlowStepRecord = z.object({
  node_id: z.string(),
  kind: z.string(),
  label: z.string().nullable(),
  model_id: z.string().nullable(),
  status: z.enum(['done', 'skipped', 'failed', 'pinned', 'cached']),
  started_at: z.string(),
  ms: z.number(),
  tokens_in: z.number().int().default(0),
  tokens_out: z.number().int().default(0),
  cost_usd: z.number().default(0),
  /** The node's full output text (reasoning excluded), for the Teamwork fold. */
  output: z.string().default(''),
  reasoning: z.string().optional(),
  error: z.string().optional(),
  /** Tools the node called, in order, and how each went. */
  tool_calls: z
    .array(
      z.object({
        call_id: z.string(),
        tool: z.string(),
        args_preview: z.unknown(),
        ok: z.boolean(),
        output: z.string(),
        /** Refused (not in the node's list) or declined by you. */
        refused: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type FlowStepRecord = z.infer<typeof FlowStepRecord>;

export const FlowProvenance = z.object({
  flow_id: z.string(),
  name: z.string(),
  version: z.number().int(),
  scope: FlowScope,
  path: z.array(z.string()),
  decisions: z.array(FlowDecision),
  steps: z.array(FlowStepRecord),
  cost_usd: z.number(),
});
export type FlowProvenance = z.infer<typeof FlowProvenance>;

/** Which flow a thread would use now, and why. */
/** A thread changes a few nodes of its notebook's flow without forking it. */
export const FlowNodeOverrides = z.record(z.string(), z.record(z.string(), z.unknown()));
export type FlowNodeOverrides = z.infer<typeof FlowNodeOverrides>;

/** One router or rule decision, for the confidence heat-map and the close-calls inbox. */
export const RouteDecisionRecord = z.object({
  message_id: z.string(),
  thread_id: z.string(),
  flow_id: z.string(),
  version: z.number().int(),
  node_id: z.string(),
  chose: z.array(z.string()),
  /** Every route's score, when the router gave them. */
  scores: z.record(z.string(), z.number()).optional(),
  confidence: z.number().nullable(),
  /** You said which route was right (from the close-calls inbox). */
  label: z.string().nullable(),
  at: z.string(),
});
export type RouteDecisionRecord = z.infer<typeof RouteDecisionRecord>;

export const ResolvedFlow = z.object({
  flow: Flow.nullable(),
  /** Where it came from: thread override, notebook, workspace default, or none (plain chat). */
  from: z.enum(['message', 'thread', 'notebook', 'workspace', 'none']),
  /**
   * The thread turned flows off ('off'), and this is the flow that would
   * answer otherwise, so the composer can say "Flow paused" and offer it back.
   */
  paused: z
    .object({ id: z.string(), name: z.string(), from: z.enum(['thread', 'notebook', 'workspace']) })
    .nullable()
    .optional(),
});

/**
 * How an answer was routed, and why (DESIGN.md §16.3, "Interactions"): a
 * flow or one model, chosen by the message, the thread, the notebook, the
 * workspace or the default. When a flow would have answered but was set
 * aside, `skipped_flow` says which and why, so the Why panel can tell you.
 */
export const AnswerRoute = z.object({
  kind: z.enum(['flow', 'model']),
  from: z.enum(['message', 'thread', 'notebook', 'workspace', 'default']),
  flow_id: z.string().optional(),
  model_id: z.string().optional(),
  skipped_flow: z
    .object({
      flow_id: z.string(),
      name: z.string(),
      from: z.enum(['thread', 'notebook', 'workspace']),
      /** message_model: you picked a model for this message; thread_paused: the thread turned flows off. */
      because: z.enum(['message_model', 'thread_paused']),
    })
    .optional(),
  /** The thread's model could not answer (no key, switched off, or removed), so it was passed over. */
  thread_model_unready: z.string().optional(),
});
export type AnswerRoute = z.infer<typeof AnswerRoute>;

/** Try a message against a flow (saved or a draft graph) without writing to a thread. */
export const TryFlowRequest = z.object({
  text: z.string().min(1).max(100_000),
  /** A thread for context (its branch path, notebook, memory); none = an empty conversation. */
  thread_id: z.string().optional(),
  head_id: z.string().optional(),
  /** Unsaved graph from the editor; else the saved flow. */
  graph: FlowGraph.optional(),
  /** The saved flow to try (when no graph is given). */
  flow_id: z.string().optional(),
  /** Dry run: every node uses the offline test model, at no cost. */
  mock: z.boolean().optional(),
});

export const TryFlowResponse = z.object({
  run_id: z.string(),
  stream_url: z.string(),
  message_id: z.string(),
});

/** POST /messages/:id/route-again: answer that message again through a flow, as a new sibling. */
export const RouteAgainRequest = z
  .object({
    flow_id: z.string().optional(),
    version: z.number().int().min(1).optional(),
    /** Rerun from this step: earlier nodes keep their recorded outputs. */
    from_node: z.string().optional(),
    /** With from_node: the model that step uses this time. */
    model: z.string().optional(),
  })
  .strict();

/** POST /flows/:id/nodes/:node/run: run one node alone ("run only this" in the editor). */
export const RunNodeRequest = z
  .object({
    input: z.string().max(100_000).default(''),
    thread_id: z.string().optional(),
    head_id: z.string().optional(),
    /** Unsaved graph from the editor; else the saved flow. */
    graph: FlowGraph.optional(),
    mock: z.boolean().optional(),
  })
  .strict();

export const RunNodeResponse = z.object({
  node_id: z.string(),
  output: z.string(),
  model_id: z.string().nullable(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_usd: z.number(),
  ms: z.number(),
  /** Exactly what the node was shown. */
  payload: z.unknown(),
});

/** A node's last run, with the exact payload it saw. */
export const NodeLastRun = z.object({
  node_id: z.string(),
  payload: z.unknown(),
  output: z.string(),
  meta: z.record(z.string(), z.unknown()),
  at: z.string(),
});

export const EstimateContextRequest = z
  .object({ graph: FlowGraph, thread_id: z.string().optional(), text: z.string().max(100_000).optional() })
  .strict();

/** Per edge into a model node: what crosses it and roughly how many tokens. */
export const EstimateContextResponse = z.object({
  edges: z.array(
    z.object({
      edge_id: z.string().nullable(),
      node_id: z.string(),
      tokens: z.object({
        system: z.number(),
        memory: z.number(),
        sources: z.number(),
        conversation: z.number(),
        upstream: z.number(),
        task: z.number(),
      }),
      total: z.number(),
      context_window: z.number().nullable(),
      over: z.boolean(),
    }),
  ),
});

export const PublishFlowRequest = z.object({ version: z.number().int().min(1).nullable() }).strict();
export const ActivateFlowRequest = z.object({ on: z.boolean().default(true) }).strict();
export const RestoreFlowRequest = z.object({ version: z.number().int().min(1) }).strict();
export const LabelDecisionRequest = z.object({ label: z.string().max(60).nullable() }).strict();

/* ---- Templates ---------------------------------------------------------------- */

export const FlowTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  graph: FlowGraph,
});
export type FlowTemplate = z.infer<typeof FlowTemplate>;
