/**
 * ------------------------------------------------------------------
 *  Title    |  ComputeProvider
 *  Ref      |  DESIGN.md §2 (remote compute), §12 (extensibility)
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  The seam that keeps Ancile free of any one GPU vendor.
 *           |  RunPod is the first adapter; Lambda, Vast, Modal or a
 *           |  box under the desk implement the same four methods.
 *  Note     |  Adapters never throw raw HTTP errors: they throw
 *           |  ProviderError carrying an OperationError whose
 *           |  suggestion a person can act on.
 * ------------------------------------------------------------------
 */

import type { CreateNodeSpec, NodeAction, NodeState, Operation } from '@nvx/contracts/controller';

export type OperationError = NonNullable<Operation['error']>;

export interface ProviderNode {
  ref: string;
  name: string;
  state: NodeState;
  gpuType: string | null;
  hourlyRate: number | null;
  /** Data centre or LAN location, when the provider reports one. */
  region?: string | null;
  /** OpenAI-compatible base URL when the node serves models (e.g. RunPod proxy URL). */
  endpointUrl: string | null;
  /** Models the node reports serving, when the provider can tell. */
  servedModels?: string[];
  raw: unknown;
}

export interface ActionAck {
  /** The provider accepted the request (it may still be in progress). */
  accepted: true;
  /** State reported in the response, when the provider returns one. */
  state: NodeState | null;
  detail: string;
}

export interface ComputeProvider {
  readonly id: string;
  getNode(ref: string, signal?: AbortSignal): Promise<ProviderNode>;
  action(ref: string, action: NodeAction, idempotencyKey: string, signal?: AbortSignal): Promise<ActionAck>;
  /**
   * Create a node (e.g. a RunPod pod) and return it as first seen. Optional:
   * providers that only manage existing machines leave it out.
   */
  create?(
    spec: CreateNodeSpec & { name: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ProviderNode>;
  /** Cheap reachability probe for /ready and the self-diagnostic. */
  ping(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /**
   * Answer a data-plane request itself (the fake provider's sample nodes,
   * whose endpoint URL starts with fake://). Real providers leave it out.
   */
  serve?(ref: string, path: string, body: Record<string, unknown>): Response | Promise<Response>;
}

export class ProviderError extends Error {
  constructor(
    readonly error: OperationError,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(error.provider_message);
    this.name = 'ProviderError';
  }
}
