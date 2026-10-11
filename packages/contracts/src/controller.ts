/**
 * The Controller contract (DESIGN.md §4.3). The Controller is a separate
 * deployable; this file is the whole surface Ancile depends on. Anything
 * that passes services/controller/test/contract can stand in for it.
 *
 * Data plane:    OpenAI-compatible /v1/* (model name = route alias)
 * Control plane: /control/v1/*
 */
import { z } from 'zod';
import { OperationStatus } from './events';

export const CONTROLLER_CONTRACT_VERSION = '1.0.0';

export const NodeState = z.enum([
  'creating',
  'starting',
  'running',
  'stopping',
  'stopped',
  'terminating',
  'terminated',
  'error',
  'unknown',
]);
export type NodeState = z.infer<typeof NodeState>;

export const NodeAction = z.enum(['start', 'stop', 'restart', 'terminate']);
export type NodeAction = z.infer<typeof NodeAction>;

export const ComputeNode = z.object({
  id: z.string(),
  provider: z.string(),
  provider_ref: z.string(),
  name: z.string(),
  gpu_type: z.string(),
  region: z.string().nullable(),
  observed_state: NodeState,
  desired_state: NodeState,
  endpoint_url: z.string().nullable(),
  served_models: z.array(z.string()),
  hourly_rate: z.number().nonnegative(),
  storage_rate_month: z.number().nonnegative(),
  healthy: z.boolean(),
  last_activity_at: z.string().nullable(),
});
export type ComputeNode = z.infer<typeof ComputeNode>;

export const OperationStep = z.object({
  status: OperationStatus,
  at: z.string(),
  /** In the provider's own words where we have them. */
  detail: z.string(),
});

export const OperationError = z.object({
  code: z.string(),
  provider_message: z.string(),
  /** A concrete next step, e.g. "No A100 capacity in EU-RO-1. Try EU-SE-1 or an H100." */
  suggestion: z.string(),
});

export const Operation = z.object({
  id: z.string(),
  node_id: z.string(),
  action: z.union([NodeAction, z.literal('create')]),
  status: OperationStatus,
  timeline: z.array(OperationStep),
  requested_by: z.string(),
  reason: z.string().nullable(),
  error: OperationError.nullable(),
  trace_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Operation = z.infer<typeof Operation>;

/**
 * Create a new node at the provider (a RunPod pod) and manage it. Optional:
 * a provider that cannot create answers 501 (provider.cannot_create).
 */
export const CreateNodeSpec = z.object({
  /** The provider's GPU type id, e.g. "NVIDIA RTX A6000". */
  gpu_type_id: z.string().min(1).max(120),
  gpu_count: z.number().int().min(1).max(8).default(1),
  /** A container image, or a provider template id; one of them. */
  image: z.string().min(1).max(300).optional(),
  template_id: z.string().min(1).max(120).optional(),
  /** Data centre / region id, e.g. "EU-RO-1". Absent: the provider chooses. */
  region: z.string().min(1).max(60).optional(),
  cloud: z.enum(['secure', 'community']).default('secure'),
  container_disk_gb: z.number().int().min(5).max(2_000).default(40),
  /** A persistent volume at /workspace; 0 for none. RunPod's smallest is 10 GB. */
  volume_gb: z
    .number()
    .int()
    .max(4_000)
    .refine((v) => v === 0 || v >= 10, 'A volume is 0 (none) or at least 10 GB.')
    .default(0),
  /** "8000/http" style; the first http port serves the OpenAI-compatible API. */
  ports: z
    .array(z.string().regex(/^\d{2,5}\/(http|tcp)$/))
    .max(10)
    .default(['8000/http']),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4_000)).default({}),
  /** Arguments for the image's entrypoint, e.g. vLLM's ["--model", "Qwen/…", "--port", "8000"]. */
  command: z.array(z.string().max(1_000)).max(50).optional(),
});
export type CreateNodeSpec = z.infer<typeof CreateNodeSpec>;

export const CreateNodeRequest = z.object({
  name: z.string().min(1).max(120),
  spec: CreateNodeSpec,
  idempotency_key: z.string().min(8).max(200),
  served_models: z.array(z.string().min(1).max(200)).max(50).optional(),
  storage_rate_month: z.number().nonnegative().max(100_000).optional(),
  reason: z.string().max(500).optional(),
});

/**
 * GET /control/v1/node-setup: what a pod set up by hand needs (start
 * command and environment), so its key matches the one the Controller
 * sends. `node_token` is null when CONTROLLER_NODE_TOKEN is not set.
 */
export const NodeSetup = z.object({
  start_command: z.string(),
  env: z.record(z.string(), z.string()),
  node_token: z.string().nullable(),
});
export type NodeSetup = z.infer<typeof NodeSetup>;

export const ActionRequest = z.object({
  action: NodeAction,
  idempotency_key: z.string().min(8),
  reason: z.string().optional(),
});

export const CostSummary = z.object({
  month: z.string(),
  nodes: z.array(
    z.object({
      node_id: z.string(),
      hourly_rate: z.number(),
      hours_this_month: z.number(),
      compute_cost: z.number(),
      storage_cost: z.number(),
      projected_month_cost: z.number(),
    }),
  ),
  total_to_date: z.number(),
  projected_total: z.number(),
  cap: z.number().nullable(),
});
export type CostSummary = z.infer<typeof CostSummary>;

export const Rule = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('idle_timeout'),
    enabled: z.boolean(),
    config: z.object({
      node_ids: z.array(z.string()).or(z.literal('*')),
      idle_minutes: z.number().int().min(5),
    }),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('schedule'),
    enabled: z.boolean(),
    config: z.object({
      node_ids: z.array(z.string()).or(z.literal('*')),
      cron: z.string(),
      action: NodeAction,
      tz: z.string(),
    }),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('cost_cap'),
    enabled: z.boolean(),
    config: z.object({
      monthly_usd: z.number().positive(),
      on_reach: z.enum(['stop_nodes', 'block_routing', 'notify_only']),
    }),
  }),
]);
export type Rule = z.infer<typeof Rule>;

/** Data-plane error bodies Core must understand. */
export const ControllerRoutingError = z.object({
  error: z.object({
    code: z.enum(['node_waking', 'queue_full', 'cost_cap', 'route_unknown', 'node_failed']),
    message: z.string(),
    eta_s: z.number().nullable().optional(),
    node_id: z.string().optional(),
  }),
});
