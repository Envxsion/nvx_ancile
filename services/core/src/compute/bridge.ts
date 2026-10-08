/**
 * ------------------------------------------------------------------
 *  Title    |  Compute bridge
 *  Ref      |  DESIGN.md §4.3, §7.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep Core in step with the Controller: every model a
 *           |  node serves appears in the model switcher (as "… on
 *           |  Studio A100"), and the Controller's operations and
 *           |  notices reach the Cockpit as Core's own global events.
 *  How      |  One long-lived SSE read of /control/v1/events, resumed
 *           |  with backoff when the Controller restarts, plus a node
 *           |  list refresh on every node change (and once a minute).
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { ulid } from 'ulid';
import type { EventBus } from '../events/bus';
import type { ModelRegistry } from '../gateway/registry';
import { logFor } from '../obs/logger';
import type { ControllerClient } from './controller';

const log = logFor('compute');

interface WireNode {
  id: string;
  name: string;
  gpu_type: string;
  provider: string;
  served_models: string[];
  observed_state: string;
}

/** `node/<model>` model ids are made safe for the provider/model id rule. */
export const nodeModelId = (model: string) => `node/${model.replace(/[^A-Za-z0-9._:-]+/g, '-')}`;

export function nodeModels(nodes: WireNode[]): ModelConfig[] {
  const out: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.observed_state === 'terminated') continue;
    for (const model of n.served_models) {
      const id = nodeModelId(model);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        provider: 'node',
        provider_model: `node/${model}`,
        display_name: `${model} on ${n.name}`,
        via: 'controller',
        family: model.split(/[-:/.]/)[0]?.toLowerCase() || 'node',
        context_window: 32_000,
        max_output: 4_096,
        capabilities: [],
        price: { input_per_mtok: 0, output_per_mtok: 0 },
        enabled: true,
      });
    }
  }
  return out;
}

export function startComputeBridge(deps: {
  client: ControllerClient;
  registry: ModelRegistry;
  bus: EventBus;
}): () => void {
  if (!deps.client.configured) return () => {};
  const { client, registry, bus } = deps;
  let stopped = false;
  const abort = new AbortController();

  const refresh = async () => {
    try {
      const { items } = await client.get<{ items: WireNode[] }>('/nodes');
      registry.setNodeModels(nodeModels(items));
    } catch (err) {
      log.debug({ err }, 'node list unavailable');
    }
  };

  const relay = async (raw: string) => {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (e.type === 'node.operation') {
      await bus.publish({
        type: 'node.operation',
        operation_id: String(e.operation_id),
        node_id: String(e.node_id),
        action: String(e.action),
        status: e.status as never,
        detail: String(e.detail ?? ''),
      });
    } else if (e.type === 'node.updated') {
      await refresh();
    } else if (e.type === 'notice') {
      await bus.publish({
        type: 'notification',
        id: `ntf_${ulid()}`,
        level: e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info',
        title: String(e.title ?? 'Compute'),
        ...(typeof e.body === 'string' && { body: e.body }),
        action: { label: 'Open Compute', href: '/admin/compute' },
        category: 'health',
      });
    }
  };

  const listen = async () => {
    let backoff = 1_000;
    while (!stopped) {
      try {
        const res = await client.raw('/events', abort.signal);
        if (!res.ok || !res.body) throw new Error(`events answered ${res.status}`);
        backoff = 1_000;
        await refresh();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i = buf.indexOf('\n\n');
          while (i >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (data) await relay(data).catch((err) => log.warn({ err }, 'compute event not relayed'));
            i = buf.indexOf('\n\n');
          }
        }
      } catch (err) {
        if (stopped) return;
        log.debug({ err }, 'controller events stream ended; reconnecting');
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  };

  void refresh();
  void listen();
  const tick = setInterval(() => void refresh(), 60_000);
  tick.unref?.();
  return () => {
    stopped = true;
    clearInterval(tick);
    abort.abort();
  };
}
