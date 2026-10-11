/**
 * ------------------------------------------------------------------
 *  Title    |  Models, as the flow editor sees them
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything a model picker on the canvas needs: name,
 *           |  provider, price per million tokens, context window,
 *           |  whether it is ready, and for a GPU node's model
 *           |  whether that node is awake right now.
 *  How      |  /models (with prices) plus /compute/nodes. A model on a
 *           |  node is awake when a running node serves it.
 * ------------------------------------------------------------------
 */

import type { ModelInfo } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useNodes } from '../compute/data';
import { api } from '../lib/api';
import { hideTryout, hueFor } from '../lib/mappers';
import type { Hue } from '../lib/types';
import { usePrefs } from '../state/prefs';

export interface FlowModel {
  id: string;
  name: string;
  provider: string;
  family: string;
  hue: Hue;
  via: 'direct' | 'controller';
  window: number;
  maxOutput: number;
  priceIn: number;
  priceOut: number;
  status: ModelInfo['status'];
  offline: boolean;
  /** For GPU node models: awake (true), asleep (false); null for everything else. */
  awake: boolean | null;
  nodeName: string | null;
  chat: boolean;
}

export function useFlowModels(): { list: FlowModel[]; byId: Map<string, FlowModel>; loading: boolean } {
  const models = useQuery({
    queryKey: ['flows', 'models'],
    staleTime: 60_000,
    queryFn: () => api.get<{ items: ModelInfo[] }>('/models').then((r) => r.items),
  });
  const nodes = useNodes();
  const keepTryout = usePrefs((s) => s.prefs.advanced.tryoutModels);
  return useMemo(() => {
    const list: FlowModel[] = (models.data ?? []).map((m) => {
      const short = m.id.replace(/^controller\//, '');
      const node =
        m.via === 'controller'
          ? (nodes.data ?? []).find((n) => n.served_models.some((s) => s === short || s === m.id))
          : undefined;
      return {
        id: m.id,
        name: m.display_name,
        provider: m.provider,
        family: m.family,
        hue: hueFor(m.family),
        via: m.via,
        window: m.context_window,
        maxOutput: m.max_output,
        priceIn: m.price.input_per_mtok,
        priceOut: m.price.output_per_mtok,
        status: m.status,
        offline: m.offline,
        awake: m.via === 'controller' ? node?.observed_state === 'running' : null,
        nodeName: node?.name ?? null,
        chat: !m.capabilities.includes('embeddings') && !m.capabilities.includes('rerank'),
      };
    });
    // A flow that already names a try-out model still resolves it; only the picker list hides it.
    return {
      list: hideTryout(list, keepTryout),
      byId: new Map(list.map((m) => [m.id, m])),
      loading: models.isPending,
    };
  }, [models.data, models.isPending, nodes.data, keepTryout]);
}

/** "$3 / $15 per M" or "Free". */
export function priceText(m: FlowModel | undefined): string {
  if (!m) return '';
  if (!m.priceIn && !m.priceOut) return m.via === 'controller' ? 'Billed by the hour' : 'Free';
  const f = (v: number) => (v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2).replace(/\.?0+$/, '')}`);
  return `${f(m.priceIn)} in · ${f(m.priceOut)} out per M`;
}

export function windowText(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(tokens / 1000)}k`;
}
