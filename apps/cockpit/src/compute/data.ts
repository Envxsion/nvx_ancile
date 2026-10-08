/**
 * ------------------------------------------------------------------
 *  Title    |  Compute data
 *  Ref      |  DESIGN.md §7.3, §13.3 · services/core/src/compute
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything Admin → Compute reads and does: nodes, costs,
 *           |  rules, actions, and a live view of each operation as it
 *           |  walks the confirmation chain.
 *  How      |  React Query reads (nodes every 10 s, costs every 30 s);
 *           |  an action returns its operation id at once, and
 *           |  watchOperation() follows it over SSE until it settles.
 * ------------------------------------------------------------------
 */

import type { ComputeNode, CostSummary, Operation, Rule } from '@nvx/contracts/controller';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { API_BASE, ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';

export type { ComputeNode, CostSummary, Operation, Rule };

export const computeKeys = {
  status: ['compute', 'status'] as const,
  nodes: ['compute', 'nodes'] as const,
  costs: ['compute', 'costs'] as const,
  rules: ['compute', 'rules'] as const,
  ops: (nodeId: string) => ['compute', 'ops', nodeId] as const,
};

export interface ComputeStatus {
  configured: boolean;
  reachable: boolean;
  sample: boolean;
  provider: string | null;
}

export const useComputeStatus = () =>
  useQuery({
    queryKey: computeKeys.status,
    queryFn: () => api.get<ComputeStatus>('/compute/status'),
    refetchInterval: 30_000,
  });

export const useNodes = () =>
  useQuery({
    queryKey: computeKeys.nodes,
    queryFn: () => api.get<{ items: ComputeNode[] }>('/compute/nodes').then((r) => r.items),
    refetchInterval: 10_000,
  });

export const useCosts = () =>
  useQuery({
    queryKey: computeKeys.costs,
    queryFn: () => api.get<CostSummary>('/compute/costs'),
    refetchInterval: 30_000,
  });

export const useRules = () =>
  useQuery({
    queryKey: computeKeys.rules,
    queryFn: () => api.get<{ items: Rule[] }>('/compute/rules').then((r) => r.items),
  });

export const useNodeOperations = (nodeId: string, enabled = true) =>
  useQuery({
    queryKey: computeKeys.ops(nodeId),
    queryFn: () =>
      api.get<{ items: Operation[] }>(`/compute/nodes/${nodeId}/operations`).then((r) => r.items),
    enabled,
  });

function failed(error: unknown, what: string) {
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : `${what} didn't reach Core`,
    body:
      error instanceof ApiCallError
        ? error.body.error.hint
        : 'Check that NVX Ancile is running, then try again.',
  });
}

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: ['compute'] });
};

/* ---- Live operations ---------------------------------------------------- */

interface LiveOps {
  /** node id → the operation in flight (or the last one, until dismissed). */
  byNode: Record<string, Operation>;
  put: (op: Operation) => void;
  clear: (nodeId: string) => void;
}

export const useLiveOps = create<LiveOps>((set) => ({
  byNode: {},
  put: (op) => set((s) => ({ byNode: { ...s.byNode, [op.node_id]: op } })),
  clear: (nodeId) =>
    set((s) => {
      const { [nodeId]: _gone, ...rest } = s.byNode;
      return { byNode: rest };
    }),
}));

const TERMINAL = new Set(['confirmed', 'failed', 'timed_out']);

/** Follow an operation until it settles; every step lands in useLiveOps. */
export function watchOperation(opId: string): void {
  let op: Operation | null = null;
  const es = new EventSource(`${API_BASE}/compute/operations/${opId}/stream`);
  const load = async () => {
    try {
      op = await api.get<Operation>(`/compute/operations/${opId}`);
      useLiveOps.getState().put(op);
      if (TERMINAL.has(op.status)) settle();
    } catch {
      /* the stream carries on */
    }
  };
  const settle = () => {
    es.close();
    refresh();
    if (!op) return;
    if (op.status === 'confirmed') {
      const cleared = op;
      setTimeout(() => {
        if (useLiveOps.getState().byNode[cleared.node_id]?.id === cleared.id)
          useLiveOps.getState().clear(cleared.node_id);
      }, 6_000);
    }
  };
  es.addEventListener('step', () => void load());
  es.addEventListener('done', (e) => {
    try {
      op = JSON.parse((e as MessageEvent<string>).data) as Operation;
      useLiveOps.getState().put(op);
    } catch {
      /* fall back to the last read */
    }
    settle();
  });
  es.onerror = () => {
    // The stream drops when Core or the Controller restarts: read once, then stop.
    es.close();
    void load().then(refresh);
  };
  void load();
}

/* ---- Actions ------------------------------------------------------------ */

export async function nodeAction(
  node: Pick<ComputeNode, 'id' | 'name'>,
  action: 'start' | 'stop' | 'restart' | 'terminate',
): Promise<boolean> {
  try {
    const r = await api.post<{ operation_id: string }>(`/compute/nodes/${node.id}/actions`, {
      action,
      idempotency_key: `ui-${action}-${node.id}-${crypto.randomUUID()}`,
      reason: `Asked in Admin → Compute`,
    });
    watchOperation(r.operation_id);
    return true;
  } catch (error) {
    failed(error, `${action[0]?.toUpperCase()}${action.slice(1)} ${node.name}`);
    return false;
  }
}

export async function addNode(input: {
  provider_ref: string;
  name?: string;
  served_models?: string[];
  storage_rate_month?: number;
}): Promise<ComputeNode | null> {
  try {
    const n = await api.post<ComputeNode>('/compute/nodes', input);
    refresh();
    notify({ level: 'success', title: `Added ${n.name}`, body: 'Its models are in the model switcher now.' });
    return n;
  } catch (error) {
    failed(error, 'Adding the node');
    return null;
  }
}

export async function forgetNode(node: Pick<ComputeNode, 'id' | 'name'>): Promise<void> {
  try {
    await api.del(`/compute/nodes/${node.id}`);
    refresh();
    notify({
      level: 'info',
      title: `Removed ${node.name} from NVX Ancile`,
      body: 'The machine itself was not touched.',
    });
  } catch (error) {
    failed(error, `Removing ${node.name}`);
  }
}

export async function saveRule(rule: Omit<Rule, 'id'> & { id?: string }): Promise<boolean> {
  try {
    await api.post('/compute/rules', rule);
    void queryClient.invalidateQueries({ queryKey: computeKeys.rules });
    return true;
  } catch (error) {
    failed(error, 'Saving the rule');
    return false;
  }
}

export async function deleteRule(id: string): Promise<void> {
  try {
    await api.del(`/compute/rules/${id}`);
    void queryClient.invalidateQueries({ queryKey: computeKeys.rules });
  } catch (error) {
    failed(error, 'Removing the rule');
  }
}

/** "Use a cloud model instead" for a turn waiting on a node. */
export async function chooseCloud(runId: string): Promise<void> {
  try {
    await api.post(`/runs/${runId}/use-cloud`, {});
  } catch (error) {
    failed(error, 'Switching to a cloud model');
  }
}

/* ---- Chain view --------------------------------------------------------- */

const CHAIN_INDEX: Record<string, number> = { requested: 0, acknowledged: 1, in_progress: 2, confirmed: 3 };

const hhmmss = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** An operation as the four-link chain draws it. */
export function chainOf(op: Operation) {
  const times: string[] = [];
  let reached = 0;
  for (const s of op.timeline) {
    const i = CHAIN_INDEX[s.status];
    if (i === undefined) continue;
    reached = Math.max(reached, i);
    times[i] ??= hhmmss(s.at);
  }
  const failed = op.status === 'failed' || op.status === 'timed_out';
  return {
    reached,
    failed,
    timeline: times,
    detail: op.error?.provider_message ?? op.timeline.at(-1)?.detail ?? '',
    suggestion: op.error?.suggestion,
  };
}

export const ACTION_WORD: Record<Operation['action'], string> = {
  create: 'Create',
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  terminate: 'Terminate',
};
