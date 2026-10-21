/**
 * ------------------------------------------------------------------
 *  Title    |  Flows, from the thread's side
 *  Ref      |  DESIGN.md §16.3 · §16.5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything a conversation asks of Flows: which flow
 *           |  answers this thread and why, the graph a past answer
 *           |  ran through, answering again by the same route or a new
 *           |  one, rerunning one step with another model, and the
 *           |  thread's own flow choice and node overrides.
 *  How      |  TanStack Query for reads (a flow version never changes,
 *           |  so it is cached for good); plain functions for writes,
 *           |  each ending the way regenerate does: the new answer's
 *           |  run is attached and streams in as a sibling.
 *  Note     |  The editor's own client lives in src/flows/ (another
 *           |  owner); this file is only what threads need.
 * ------------------------------------------------------------------
 */

import type {
  Flow,
  FlowGraph,
  FlowNodeOverrides,
  FlowSummary,
  FlowVersion as FlowVersionSchema,
  ResolvedFlow as ResolvedFlowSchema,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { attachRun } from '../lib/run';
import type { ModelView } from '../lib/types';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';

export type ResolvedFlow = z.infer<typeof ResolvedFlowSchema>;
export type FlowVersion = z.infer<typeof FlowVersionSchema>;

interface Started {
  run_id: string;
  user_message_id?: string;
  assistant_message_id: string;
}

export const flowKeys = {
  resolve: (threadId: string) => ['flow-resolve', threadId] as const,
  version: (flowId: string, version: number) => ['flow-version', flowId, version] as const,
  list: ['flows', 'all'] as const,
};

function report(error: unknown, what: string): void {
  if (error instanceof ApiCallError)
    notify({ level: 'error', title: error.body.error.title, body: error.body.error.hint });
  else
    notify({
      level: 'error',
      title: `${what} didn't reach Core`,
      body: 'Check that NVX Ancile is running, then try again.',
    });
}

/** Which flow answers the next message in this thread, and where that choice comes from. */
export function useResolvedFlow(threadId: string | undefined) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: flowKeys.resolve(threadId ?? 'none'),
    enabled: !!threadId && threadId !== 'new' && !demo,
    staleTime: 30_000,
    retry: false,
    queryFn: () => api.get<ResolvedFlow>(`/flows/resolve?thread_id=${encodeURIComponent(threadId ?? '')}`),
  });
}

/** The graph a past answer ran through (a saved version never changes). */
export function useFlowVersion(flowId: string | undefined, version: number | undefined) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: flowKeys.version(flowId ?? 'none', version ?? 0),
    enabled: !!flowId && !!version && !demo,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async (): Promise<FlowGraph & { name?: string }> => {
      const r = await api.get<Flow | { graph: FlowGraph; name?: string }>(
        `/flows/${flowId}/versions/${version}`,
      );
      return 'graph' in r ? { ...r.graph, ...(r.name && { name: r.name }) } : r;
    },
  });
}

/** A flow's saved versions, newest first (for "Route again with" an earlier one). */
export function useFlowVersions(flowId: string | undefined, enabled = true) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: ['flow-versions', flowId ?? 'none'] as const,
    enabled: enabled && !!flowId && !demo,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const r = await api.get<FlowVersion[] | { items: FlowVersion[] }>(`/flows/${flowId}/versions`);
      return (Array.isArray(r) ? r : r.items).sort((a, b) => b.version - a.version);
    },
  });
}

/** Every flow you could pick (for @flow and "Route again with…"). */
export function useFlowList(enabled = true) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: flowKeys.list,
    enabled: enabled && !demo,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const r = await api.get<FlowSummary[] | { items: FlowSummary[] }>('/flows');
      return Array.isArray(r) ? r : r.items;
    },
  });
}

/** After a new answer starts: show it, stream it. */
function follow(threadId: string, s: Started): void {
  void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
  attachRun({ runId: s.run_id, threadId, messageId: s.assistant_message_id });
}

/**
 * Answer again. 'same' replays the recorded route (routers and rules are not
 * asked again); 'again' lets the flow decide afresh.
 */
export async function regenerateRoute(threadId: string, messageId: string, route: 'same' | 'again') {
  try {
    follow(threadId, await api.post<Started>(`/messages/${messageId}/regenerate`, { route }));
  } catch (error) {
    report(error, 'Regenerate');
  }
}

/**
 * Answer a past message again through another flow or version (or a single
 * step rerun with another model). The new answer is a sibling branch; the
 * old one stays exactly as it was.
 */
export async function routeAgain(
  threadId: string,
  messageId: string,
  opts: { flowId?: string; version?: number; fromNode?: string; model?: string },
) {
  try {
    const s = await api.post<Started>(`/messages/${messageId}/route-again`, {
      ...(opts.flowId && { flow_id: opts.flowId }),
      ...(opts.version && { version: opts.version }),
      ...(opts.fromNode && { from_node: opts.fromNode }),
      ...(opts.model && { model: opts.model }),
    });
    follow(threadId, s);
    notify({
      level: 'info',
      title: 'Answering again as a new version',
      body: 'The earlier answer stays one arrow away.',
    });
  } catch (error) {
    report(error, 'Routing again');
  }
}

/** Set (or clear, with null) the thread's own flow and node overrides. */
export async function setThreadFlow(
  threadId: string,
  patch: { flow_id?: string | null; flow_overrides?: FlowNodeOverrides; flow_overrides_flow?: string | null },
): Promise<boolean> {
  try {
    await api.patch(`/threads/${threadId}`, patch);
    void queryClient.invalidateQueries({ queryKey: flowKeys.resolve(threadId) });
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    return true;
  } catch (error) {
    report(error, 'Saving the thread’s flow');
    return false;
  }
}

/** Sentinel the thread stores to mean "no flow here, even if the notebook has one". */
export const FLOW_OFF = 'off';

/** Where the flow that answers comes from, in the words the Who answers menu leads with. */
export const FROM_WORDS: Record<string, string> = {
  message: 'From this message',
  thread: 'From this thread',
  notebook: 'From this notebook',
  workspace: 'From the workspace',
  none: 'No flow',
};

/** Where a flow in the list lives, said quietly beside its name. */
export function flowSource(f: Pick<FlowSummary, 'scope' | 'scope_ref'>, notebookId: string | null): string {
  if (f.scope === 'workspace') return 'Workspace';
  if (f.scope === 'notebook') return f.scope_ref && f.scope_ref === notebookId ? 'This notebook' : 'Notebook';
  return 'This thread';
}

/**
 * The flows this conversation could be answered by: the workspace's, this notebook's and
 * its own. Another notebook's flow is not offered here.
 */
export function flowsFor(
  flows: readonly FlowSummary[] | undefined,
  notebookId: string | null,
): FlowSummary[] {
  return (flows ?? []).filter(
    (f) => f.scope === 'workspace' || (f.scope === 'notebook' && !!notebookId && f.scope_ref === notebookId),
  );
}

/** Use one model instead of the flow: the flow is paused in this thread, nowhere else. */
export async function pauseFlowForModel(threadId: string, model: ModelView, flowName: string): Promise<void> {
  try {
    await api.patch(`/threads/${threadId}`, { model: model.id, flow_id: FLOW_OFF });
    void queryClient.invalidateQueries({ queryKey: flowKeys.resolve(threadId) });
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    notify({
      level: 'success',
      title: `${model.name} answers this thread`,
      body: `${flowName} is paused here only. Choose it again from the chip to turn it back on.`,
    });
  } catch (error) {
    report(error, 'Changing the model');
  }
}

/**
 * Switch one model step of the flow for this thread only (null puts the flow's own choice
 * back). Choices made for another flow do not carry over: they start again from this one's.
 */
export async function setNodeModel(
  threadId: string,
  flowId: string,
  nodeId: string,
  model: string | null,
): Promise<boolean> {
  const t = await api.get<{ settings?: Record<string, unknown> }>(`/threads/${threadId}`).catch(() => null);
  const saved = t?.settings as
    | { flow_overrides?: FlowNodeOverrides; flow_overrides_flow?: string | null }
    | undefined;
  const next: FlowNodeOverrides = {
    ...(saved?.flow_overrides_flow === flowId ? (saved.flow_overrides ?? {}) : {}),
  };
  if (model) next[nodeId] = { ...(next[nodeId] ?? {}), model };
  else delete next[nodeId];
  return setThreadFlow(threadId, { flow_overrides: next, flow_overrides_flow: flowId });
}

/** The models a resolved flow would call, for wake hints and the chip. */
export function flowModels(graph: Pick<FlowGraph, 'nodes'> | null | undefined): string[] {
  if (!graph) return [];
  const out = new Set<string>();
  for (const n of graph.nodes) {
    if (n.disabled) continue;
    if (n.kind === 'model' || n.kind === 'manager' || n.kind === 'router') out.add(n.params.model);
    if (n.kind === 'join' && n.params.judge_model) out.add(n.params.judge_model);
  }
  return [...out];
}
