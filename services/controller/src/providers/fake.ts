/**
 * ------------------------------------------------------------------
 *  Title    |  Fake provider
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  A deterministic in-memory provider for development,
 *           |  tests, the e2e suite, the contract suite and the sample
 *           |  nodes shown before a real provider is connected. Nodes
 *           |  move through real states with configurable delays, and
 *           |  any action can be made to fail with a scripted error.
 *  How      |  A running fake node also answers the OpenAI data plane
 *           |  itself (serve()), streaming a short reply that says it
 *           |  is a sample, so the whole wake-queue-answer path can be
 *           |  tried with no GPU and no key.
 * ------------------------------------------------------------------
 */

import type { CreateNodeSpec, NodeAction, NodeState } from '@nvx/contracts/controller';
import { targetState } from '../operations/machine';
import { mapError } from './runpod';
import type { ActionAck, ComputeProvider, ProviderNode } from './types';

export interface FakeNode {
  ref: string;
  name: string;
  state: NodeState;
  gpuType: string;
  hourlyRate: number;
  endpointUrl: string | null;
  region?: string | null;
}

/** Endpoint URLs with this scheme are answered by the provider itself. */
export const FAKE_SCHEME = 'fake://';

export class FakeProvider implements ComputeProvider {
  readonly id: string = 'fake';
  readonly nodes = new Map<string, FakeNode>();
  /** Scripted failures: ref → { status, message } consumed on the next action. */
  readonly failNext = new Map<string, { status: number | null; message: string }>();
  private readonly pending = new Map<string, { to: NodeState; at: number }>();

  constructor(
    private readonly transitionMs = 50,
    private readonly now: () => number = Date.now,
  ) {}

  add(node: FakeNode): this {
    this.nodes.set(node.ref, { ...node });
    return this;
  }

  private settle(ref: string) {
    const p = this.pending.get(ref);
    const node = this.nodes.get(ref);
    if (p && node && this.now() >= p.at) {
      node.state = p.to;
      this.pending.delete(ref);
    }
  }

  async getNode(ref: string): Promise<ProviderNode> {
    this.settle(ref);
    const n = this.nodes.get(ref);
    if (!n) throw mapError(404, 'pod not found', 'start');
    return {
      ...n,
      region: n.region ?? null,
      endpointUrl: n.state === 'running' ? n.endpointUrl : null,
      raw: { ...n },
    };
  }

  async action(ref: string, action: NodeAction): Promise<ActionAck> {
    this.settle(ref);
    const scripted = this.failNext.get(ref);
    if (scripted) {
      this.failNext.delete(ref);
      throw mapError(scripted.status, scripted.message, action);
    }
    const n = this.nodes.get(ref);
    if (!n) throw mapError(404, 'pod not found', action);
    if (n.state === 'terminated') throw mapError(409, 'pod is terminated', action);
    const transitional: Record<NodeAction, NodeState> = {
      start: 'starting',
      restart: 'starting',
      stop: 'stopping',
      terminate: 'terminating',
    };
    n.state = transitional[action];
    this.pending.set(ref, { to: targetState(action), at: this.now() + this.transitionMs });
    return { accepted: true, state: n.state, detail: `Sample provider: ${action} accepted.` };
  }

  private created = 0;

  /** A new sample pod: provisioning, then running after the transition time. */
  async create(spec: CreateNodeSpec & { name: string }): Promise<ProviderNode> {
    const ref = `sample-${String(++this.created).padStart(3, '0')}`;
    const node: FakeNode = {
      ref,
      name: spec.name,
      state: 'starting',
      gpuType: `${spec.gpu_count > 1 ? `${spec.gpu_count}× ` : ''}${spec.gpu_type_id}`,
      hourlyRate: 0.79 * spec.gpu_count,
      endpointUrl: `${FAKE_SCHEME}${ref}/v1`,
      region: spec.region ?? null,
    };
    this.nodes.set(ref, node);
    this.pending.set(ref, { to: 'running', at: this.now() + this.transitionMs });
    return this.getNode(ref);
  }

  async ping() {
    return { ok: true, detail: 'Sample provider (no real GPUs).' };
  }

  /** Answer an OpenAI request for a running fake node. */
  serve(ref: string, path: string, body: Record<string, unknown>): Response {
    const n = this.nodes.get(ref);
    const name = n?.name ?? ref;
    const model = String(body.model ?? 'node');
    if (path.endsWith('/embeddings')) {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({
        object: 'list',
        model,
        data: input.map((t, index) => ({
          object: 'embedding',
          index,
          embedding: Array.from({ length: 8 }, (_, i) => ((String(t).length * (i + 3)) % 97) / 97),
        })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    }
    const messages = Array.isArray(body.messages) ? (body.messages as { content?: unknown }[]) : [];
    const last = messages.at(-1)?.content;
    const asked = typeof last === 'string' ? last.slice(0, 120) : 'your message';
    const text = `This answer came from ${name}, a sample GPU node: it woke up, took your request ("${asked}") and replied. Connect RunPod or a machine on your network in Admin → Compute to run a real model here.`;
    const id = `chatcmpl-fake-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    if (!body.stream) {
      return Response.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: text.split(/\s+/).length, total_tokens: 0 },
      });
    }
    const words = text.split(/(?<=\s)/);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' } }],
        });
        for (const w of words) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: w } }],
          });
          await new Promise((r) => setTimeout(r, 25));
        }
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: words.length, total_tokens: 12 + words.length },
        });
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
}
