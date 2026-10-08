/**
 * ------------------------------------------------------------------
 *  Title    |  Local network provider
 *  Ref      |  DESIGN.md §7.3 · ROADMAP.md Phase 5 (research notes)
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  The free path: a GPU box you already own (Ollama, vLLM,
 *           |  LM Studio or any OpenAI-compatible server on your LAN)
 *           |  becomes a node with routing, queueing and the idle
 *           |  rule, at no hourly cost.
 *  How      |  Nodes come from CONTROLLER_LOCAL_NODES, a JSON list of
 *           |  {name, url, gpu?, models?}. `url` is the OpenAI base
 *           |  (…/v1). State is read by probing, cheapest first:
 *           |    vLLM    GET {root}/health        200 when serving
 *           |    any     GET {base}/models        lists served models
 *           |    Ollama  GET {root}/api/version   200 when running
 *           |  Reachable is running; unreachable is stopped.
 *  Note     |  NVX Ancile cannot power a machine on or off, so actions
 *           |  fail with a suggestion to do it on the machine itself.
 *           |  TODO(phase-6): wake-on-LAN for start, an SSH hook for
 *           |  stop.
 * ------------------------------------------------------------------
 */

import type { NodeAction } from '@nvx/contracts/controller';
import { z } from 'zod';
import { type ActionAck, type ComputeProvider, ProviderError, type ProviderNode } from './types';

export const LocalNodeSpec = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  gpu: z.string().default('Local GPU'),
  models: z.array(z.string()).default([]),
});
export type LocalNodeSpec = z.infer<typeof LocalNodeSpec>;

export function parseLocalNodes(raw: string | undefined): LocalNodeSpec[] {
  if (!raw?.trim()) return [];
  return z.array(LocalNodeSpec).parse(JSON.parse(raw));
}

const rootOf = (base: string) => base.replace(/\/+$/, '').replace(/\/v1$/, '');

export class LocalNetworkProvider implements ComputeProvider {
  readonly id = 'local';
  private readonly f: typeof fetch;

  constructor(
    readonly specs: LocalNodeSpec[],
    opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 2_500;
  }
  private readonly timeoutMs: number;

  private spec(ref: string): LocalNodeSpec {
    const s = this.specs.find((x) => x.url === ref);
    if (!s)
      throw new ProviderError(
        {
          code: 'not_found',
          provider_message: `No local node is configured at ${ref}.`,
          suggestion: 'Add it to CONTROLLER_LOCAL_NODES in .env, then restart NVX Ancile.',
        },
        404,
        false,
      );
    return s;
  }

  private async get(url: string, signal?: AbortSignal): Promise<Response | null> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.f(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      return res.ok ? res : null;
    } catch {
      return null;
    }
  }

  /** Probe the server: which models it serves, or null when it does not answer. */
  async probe(spec: LocalNodeSpec, signal?: AbortSignal): Promise<string[] | null> {
    const base = spec.url.replace(/\/+$/, '');
    const models = await this.get(`${base}/models`, signal);
    if (models) {
      const body = (await models.json().catch(() => ({}))) as { data?: { id?: string }[] };
      return (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    }
    const root = rootOf(base);
    if (await this.get(`${root}/health`, signal)) return spec.models;
    if (await this.get(`${root}/api/version`, signal)) return spec.models;
    return null;
  }

  async getNode(ref: string, signal?: AbortSignal): Promise<ProviderNode> {
    const spec = this.spec(ref);
    const served = await this.probe(spec, signal);
    return {
      ref,
      name: spec.name,
      state: served ? 'running' : 'stopped',
      gpuType: spec.gpu,
      hourlyRate: 0,
      region: 'Local network',
      endpointUrl: served ? spec.url.replace(/\/+$/, '') : null,
      servedModels: served?.length ? served : spec.models,
      raw: { probed: served !== null },
    };
  }

  async action(ref: string, action: NodeAction): Promise<ActionAck> {
    const spec = this.spec(ref);
    throw new ProviderError(
      {
        code: 'manual_node',
        provider_message: `${spec.name} is a machine on your network; NVX Ancile cannot ${action} it.`,
        suggestion:
          action === 'start' || action === 'restart'
            ? `Turn ${spec.name} on and start Ollama or vLLM on it. NVX Ancile notices within a minute.`
            : `Stop the model server on ${spec.name} yourself, or leave it: a local node costs nothing per hour.`,
      },
      null,
      false,
    );
  }

  async ping(signal?: AbortSignal) {
    if (this.specs.length === 0)
      return { ok: true, detail: 'No local nodes configured (CONTROLLER_LOCAL_NODES is empty).' };
    const up = await Promise.all(this.specs.map(async (s) => (await this.probe(s, signal)) !== null));
    const n = up.filter(Boolean).length;
    return { ok: true, detail: `${n} of ${this.specs.length} local nodes answering.` };
  }
}
