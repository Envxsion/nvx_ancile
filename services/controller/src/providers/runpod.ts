/**
 * ------------------------------------------------------------------
 *  Title    |  RunPod adapter (REST v2)
 *  Ref      |  https://docs.runpod.io/api-reference-v2 (checked 2026-10)
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Start, stop, restart and terminate pods, and read their
 *           |  state, through RunPod's v2 REST API. v1 is retired on
 *           |  15 Nov 2026, so nothing here touches it.
 *  How      |  POST {base}/v2/pods/{id}/action {action}
 *           |    200 → updated pod · 204 → accepted (terminate)
 *           |    409 → invalid for the current state
 *           |  GET  {base}/v2/pods/{id}
 *           |  Every failure becomes a ProviderError with the provider's
 *           |  own message and a concrete suggestion (mapError).
 *  Note     |  Checked against the v2 reference (Oct 2026): a pod has
 *           |  `status` (PROVISIONING, STARTING, RUNNING, EXITED,
 *           |  ERROR, TERMINATED), `cost` in USD/h (0.0 while EXITED
 *           |  or TERMINATED, so a stopped pod never zeroes the rate
 *           |  we remember), `gpu {id, count}` and `dataCenterId`.
 *           |  Errors are `{title, status, detail, errors[]}`. Older
 *           |  field names (desiredStatus, costPerHr) are still read.
 *           |  The recorded fixture is the docs' own example.
 * ------------------------------------------------------------------
 */

import type { CreateNodeSpec, NodeAction, NodeState } from '@nvx/contracts/controller';
import {
  type ActionAck,
  type ComputeProvider,
  type OperationError,
  ProviderError,
  type ProviderNode,
} from './types';

export interface RunPodOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

const STATE_MAP: Record<string, NodeState> = {
  RUNNING: 'running',
  STARTING: 'starting',
  CREATED: 'starting',
  RESTARTING: 'starting',
  PROVISIONING: 'creating',
  ERROR: 'error',
  EXITED: 'stopped',
  STOPPED: 'stopped',
  STOPPING: 'stopping',
  TERMINATING: 'terminating',
  TERMINATED: 'terminated',
  DEAD: 'error',
  FAILED: 'error',
};

export function mapState(raw: unknown): NodeState {
  if (typeof raw !== 'string') return 'unknown';
  return STATE_MAP[raw.toUpperCase()] ?? 'unknown';
}

function pick(obj: Json, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

export function mapPod(raw: Json): ProviderNode {
  const state = mapState(pick(raw, 'status', 'desiredStatus', 'state'));
  const rate = Number(pick(raw, 'cost', 'costPerHr', 'adjustedCostPerHr'));
  const g = raw.gpu as Json | undefined;
  const count = Number(g?.count ?? 1);
  const gpuId =
    (g && pick(g, 'id', 'displayName')) ??
    pick(raw, 'gpuTypeId', 'gpuDisplayName') ??
    (raw.machine as Json | undefined)?.gpuDisplayName;
  const gpu = gpuId ? `${count > 1 ? `${count}× ` : ''}${String(gpuId)}` : undefined;
  const id = String(pick(raw, 'id') ?? '');
  // Pods expose HTTP ports through the RunPod proxy: https://{id}-{port}.proxy.runpod.net
  const port = Number(process.env.RUNPOD_SERVE_PORT ?? 8000);
  return {
    ref: id,
    name: String(pick(raw, 'name') ?? id),
    state,
    gpuType: gpu ? String(gpu) : null,
    // 0.0 means "not billing right now", not "free": keep the last known rate.
    hourlyRate: Number.isFinite(rate) && rate > 0 ? rate : null,
    region: typeof raw.dataCenterId === 'string' ? raw.dataCenterId : null,
    endpointUrl: id && state === 'running' ? `https://${id}-${port}.proxy.runpod.net/v1` : null,
    raw,
  };
}

const KNOWN: { test: RegExp; error: (msg: string) => Omit<OperationError, 'provider_message'> }[] = [
  {
    // RunPod's own wording: "There are no longer any instances available with the requested specifications"
    test: /(no|not enough|insufficient) (gpus?|capacity|instances?|machines?)|no longer any (gpus?|instances?)|out of stock|unavailable in/i,
    error: () => ({
      code: 'capacity_unavailable',
      suggestion:
        'RunPod has no free GPUs of this type here right now. Retry in a few minutes, or recreate the pod in another region or with another GPU type.',
    }),
  },
  {
    test: /insufficient (funds|balance|credit)|balance (is )?too low|add (funds|credit)/i,
    error: () => ({ code: 'billing', suggestion: 'Add credit to your RunPod account, then retry.' }),
  },
  {
    test: /volume.*(in use|attached|locked)/i,
    error: () => ({
      code: 'volume_busy',
      suggestion: 'The network volume is attached elsewhere. Stop the other pod using it, then retry.',
    }),
  },
];

export function mapError(status: number | null, message: string, action: NodeAction): ProviderError {
  const provider_message = message || (status ? `HTTP ${status}` : 'No response from RunPod');
  for (const k of KNOWN) {
    if (k.test.test(message)) {
      const known = k.error(message);
      return new ProviderError({ ...known, provider_message }, status, known.code === 'capacity_unavailable');
    }
  }
  const e = (code: string, suggestion: string, retryable: boolean) =>
    new ProviderError({ code, provider_message, suggestion }, status, retryable);
  if (status === null)
    return e(
      'unreachable',
      'RunPod could not be reached. Check your connection; the action will be retried automatically.',
      true,
    );
  if (status === 401 || status === 403)
    return e(
      'auth',
      'RunPod rejected the API key. Create a key with pod read/write scope and set RUNPOD_API_KEY.',
      false,
    );
  if (status === 404)
    return e(
      'not_found',
      'RunPod no longer has this pod. Remove the node from Ancile, or create it again.',
      false,
    );
  if (status === 409)
    return e(
      'invalid_state',
      `RunPod cannot ${action} the pod in its current state. Refresh the node; it may already be changing.`,
      false,
    );
  if (status === 429)
    return e('rate_limited', 'RunPod is rate-limiting requests. The action will be retried shortly.', true);
  if (status >= 500)
    return e(
      'provider_unavailable',
      'RunPod returned a server error. The action will be retried; check status.runpod.io if it persists.',
      true,
    );
  return e('rejected', 'RunPod rejected the request. The message above is from RunPod.', false);
}

async function readMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as Json;
    // v2 problem details: {title, status, detail, errors[]}
    const errors = Array.isArray(body.errors) ? body.errors.filter((e) => typeof e === 'string') : [];
    if (typeof body.detail === 'string' || typeof body.title === 'string') {
      const head = String(body.detail ?? body.title);
      return errors.length ? `${head} (${errors.join('; ')})` : head;
    }
    const m = pick(body, 'error', 'message');
    if (typeof m === 'string') return m;
    if (m && typeof m === 'object') return String((m as Json).message ?? JSON.stringify(m));
  } catch {
    /* not JSON */
  }
  return text.slice(0, 500);
}

export class RunPodProvider implements ComputeProvider {
  readonly id = 'runpod';
  private readonly f: typeof fetch;

  constructor(private readonly opts: RunPodOptions) {
    this.f = opts.fetch ?? fetch;
  }

  private async call(
    method: string,
    path: string,
    body: Json | undefined,
    action: NodeAction,
    signal?: AbortSignal,
    idem?: string,
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      accept: 'application/json',
    };
    if (body) headers['content-type'] = 'application/json';
    if (idem) headers['idempotency-key'] = idem;
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.f(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw mapError(null, err instanceof Error ? err.message : String(err), action);
    }
    if (!res.ok) throw mapError(res.status, await readMessage(res), action);
    return res;
  }

  async getNode(ref: string, signal?: AbortSignal): Promise<ProviderNode> {
    const res = await this.call('GET', `/v2/pods/${encodeURIComponent(ref)}`, undefined, 'start', signal);
    return mapPod((await res.json()) as Json);
  }

  async action(
    ref: string,
    action: NodeAction,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ActionAck> {
    const res = await this.call(
      'POST',
      `/v2/pods/${encodeURIComponent(ref)}/action`,
      { action },
      action,
      signal,
      idempotencyKey,
    );
    if (res.status === 204)
      return {
        accepted: true,
        state: action === 'terminate' ? 'terminating' : null,
        detail: 'RunPod accepted the request.',
      };
    const pod = mapPod((await res.json().catch(() => ({}))) as Json);
    return {
      accepted: true,
      state: pod.state === 'unknown' ? null : pod.state,
      detail: `RunPod accepted the request; pod reports ${pod.state}.`,
    };
  }

  /**
   * POST {base}/v2/pods: a new pod from an image or a template. RunPod's
   * v2 create body (CreatePodRequest, checked 2026-10-09): name,
   * image | templateId, gpu {id, count}, cloud (SECURE | COMMUNITY),
   * disk (GB), mounts {persistent {size, path}}, ports[], env{},
   * cmd[], dataCenterIds[]. v1's flat names (imageName, gpuTypeIds,
   * containerDiskInGb, volumeInGb) are not part of v2. The answer is the pod.
   */
  async create(spec: CreateNodeSpec & { name: string }, idempotencyKey: string, signal?: AbortSignal) {
    const body: Json = {
      name: spec.name,
      gpu: { id: spec.gpu_type_id, count: spec.gpu_count },
      cloud: spec.cloud === 'community' ? 'COMMUNITY' : 'SECURE',
      disk: spec.container_disk_gb,
      ports: spec.ports,
      env: spec.env,
      ...(spec.volume_gb > 0 && { mounts: { persistent: { size: spec.volume_gb, path: '/workspace' } } }),
      ...(spec.image && { image: spec.image }),
      ...(spec.template_id && { templateId: spec.template_id }),
      ...(spec.region && { dataCenterIds: [spec.region] }),
      ...(spec.command?.length && { cmd: spec.command }),
    };
    const res = await this.call('POST', '/v2/pods', body, 'start', signal, idempotencyKey);
    return mapPod((await res.json()) as Json);
  }

  async ping(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    // TODO(phase-5): confirm the cheapest authenticated v2 endpoint; listing pods is safe and read-only.
    try {
      await this.call('GET', '/v2/pods?limit=1', undefined, 'start', signal);
      return { ok: true, detail: 'RunPod API reachable and the key is accepted.' };
    } catch (err) {
      const e = err as ProviderError;
      return {
        ok: false,
        detail: `${e.error?.provider_message ?? String(err)}. ${e.error?.suggestion ?? ''}`.trim(),
      };
    }
  }
}
