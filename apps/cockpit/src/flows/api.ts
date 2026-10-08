/**
 * ------------------------------------------------------------------
 *  Title    |  Flows client
 *  Ref      |  DESIGN.md §16 · contracts/flows.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every call the flow editor makes to Core, and the
 *           |  queries that cache them.
 *  How      |  A route Core does not have yet (404, 405 or 501) is a
 *           |  `NeedsCore` result, never a pretend success: the
 *           |  control stays visible and says what it is waiting for.
 *           |  Lists accept a bare array or { items }.
 * ------------------------------------------------------------------
 */

import type {
  Flow,
  FlowGraph,
  FlowIssue,
  FlowSummary,
  FlowTemplate,
  RouteDecisionRecord,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { helpDone } from '../help/store';
import { API_BASE, ApiCallError, api, newTraceparent } from '../lib/api';
import { queryClient } from '../lib/query';
import type { FlowVersion, ValidateFlowResponse } from './types';

export const flowKeys = {
  all: ['flows'] as const,
  list: (scope?: string, ref?: string | null) => ['flows', 'list', scope ?? 'all', ref ?? ''] as const,
  one: (id: string) => ['flows', 'one', id] as const,
  versions: (id: string) => ['flows', 'versions', id] as const,
  version: (id: string, v: number) => ['flows', 'version', id, v] as const,
  templates: ['flows', 'templates'] as const,
  decisions: (id: string, node: string) => ['flows', 'decisions', id, node] as const,
  closeCalls: (id: string) => ['flows', 'close-calls', id] as const,
  lastRun: (id: string, node: string) => ['flows', 'last-run', id, node] as const,
  stats: (id: string) => ['flows', 'stats', id] as const,
};

export interface NodeStats {
  runs: number;
  p50_ms: number;
  p95_ms: number;
  avg_cost_usd: number;
}

/** Typical time and cost per node, from this flow's recent answers (empty until it has answered). */
export function useNodeStats(id: string | undefined) {
  return useQuery({
    queryKey: flowKeys.stats(id ?? 'none'),
    enabled: !!id,
    staleTime: 60_000,
    queryFn: async () => (await api.get<{ nodes: Record<string, NodeStats> }>(`/flows/${id}/stats`)).nodes,
    retry: (n, err) => !needsCore(err) && n < 1,
  });
}

/** Core does not serve this yet (or this version of Core predates it). */
export function needsCore(err: unknown): boolean {
  return err instanceof ApiCallError && [404, 405, 501].includes(err.status) && !isNotFoundOfThing(err);
}

/** A real 404 for a flow that is gone, as opposed to a route that does not exist. */
function isNotFoundOfThing(err: ApiCallError): boolean {
  return err.status === 404 && /^flow\./.test(err.body.error.code);
}

const items = <T>(r: T[] | { items: T[] }): T[] => (Array.isArray(r) ? r : (r?.items ?? []));

/* ---- Flows ------------------------------------------------------------------ */

export function useFlows(scope?: string, ref?: string | null) {
  return useQuery({
    queryKey: flowKeys.list(scope, ref),
    queryFn: async () => {
      const q = new URLSearchParams();
      if (scope) q.set('scope', scope);
      if (ref) q.set('ref', ref);
      return items(await api.get<FlowSummary[] | { items: FlowSummary[] }>(`/flows${q.size ? `?${q}` : ''}`));
    },
    retry: (n, err) => !needsCore(err) && n < 2,
  });
}

export function useFlow(id: string | undefined) {
  return useQuery({
    queryKey: flowKeys.one(id ?? 'none'),
    enabled: !!id,
    queryFn: () => api.get<Flow>(`/flows/${id}`),
    retry: (n, err) => !needsCore(err) && !(err instanceof ApiCallError && err.status === 404) && n < 2,
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: flowKeys.templates,
    queryFn: async () => items(await api.get<FlowTemplate[] | { items: FlowTemplate[] }>('/flows/templates')),
    staleTime: 10 * 60_000,
    retry: (n, err) => !needsCore(err) && n < 2,
  });
}

export function useVersions(id: string | undefined) {
  return useQuery({
    queryKey: flowKeys.versions(id ?? 'none'),
    enabled: !!id,
    queryFn: async () =>
      items(await api.get<FlowVersion[] | { items: FlowVersion[] }>(`/flows/${id}/versions`)),
    retry: (n, err) => !needsCore(err) && n < 2,
  });
}

export const getVersion = (id: string, v: number) =>
  queryClient.fetchQuery({
    queryKey: flowKeys.version(id, v),
    queryFn: () => api.get<Flow>(`/flows/${id}/versions/${v}`),
    staleTime: Number.POSITIVE_INFINITY,
  });

export interface CreateInput {
  name: string;
  description?: string;
  scope: Flow['scope'];
  scope_ref: string | null;
  from?: string;
  activate?: boolean;
  graph?: Partial<FlowGraph>;
}

export async function createFlow(input: CreateInput): Promise<Flow> {
  const f = await api.post<Flow>('/flows', {
    name: input.name,
    description: input.description ?? '',
    scope: input.scope,
    scope_ref: input.scope_ref,
    ...(input.from && { from: input.from }),
    activate: input.activate ?? false,
    ...input.graph,
  });
  void queryClient.invalidateQueries({ queryKey: flowKeys.all });
  return f;
}

export async function saveFlow(
  id: string,
  graph: FlowGraph,
  meta: { name: string; description: string; base_version: number; message?: string },
): Promise<Flow> {
  const f = await api.put<Flow>(`/flows/${id}`, { ...graph, ...meta });
  queryClient.setQueryData(flowKeys.one(id), f);
  void queryClient.invalidateQueries({ queryKey: flowKeys.versions(id) });
  void queryClient.invalidateQueries({ queryKey: ['flows', 'list'] });
  return f;
}

export async function deleteFlow(id: string): Promise<void> {
  await api.del(`/flows/${id}`);
  void queryClient.invalidateQueries({ queryKey: flowKeys.all });
}

export async function activateFlow(id: string, on = true): Promise<void> {
  await api.post(`/flows/${id}/activate`, { on });
  if (on) helpDone('flow');
  void queryClient.invalidateQueries({ queryKey: flowKeys.all });
}

/** Make a version the one answers use; null follows the latest save. */
export async function publishFlow(id: string, version: number | null): Promise<Flow> {
  const f = await api.post<Flow>(`/flows/${id}/publish`, { version });
  queryClient.setQueryData(flowKeys.one(id), f);
  void queryClient.invalidateQueries({ queryKey: ['flows', 'list'] });
  return f;
}

export async function restoreVersion(id: string, version: number): Promise<Flow> {
  const f = await api.post<Flow>(`/flows/${id}/restore`, { version });
  queryClient.setQueryData(flowKeys.one(id), f);
  void queryClient.invalidateQueries({ queryKey: flowKeys.versions(id) });
  return f;
}

export const validateGraph = (graph: FlowGraph) =>
  api.post<ValidateFlowResponse>('/flows/validate', { graph });

/* ---- YAML ------------------------------------------------------------------ */

export async function exportYaml(id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/flows/${id}/export`, {
    headers: { traceparent: newTraceparent().header, accept: 'application/yaml, text/plain' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiCallError(
      res.status,
      body ?? {
        error: {
          code: 'http.unexpected',
          title: 'Export failed',
          hint: '',
          retryable: false,
          trace_id: '',
          attempts: [],
          context: {},
        },
      },
    );
  }
  return res.text();
}

export async function importYaml(
  yaml: string,
  scope: Flow['scope'],
  scope_ref: string | null,
): Promise<Flow> {
  const f = await api.post<Flow>('/flows/import', { yaml, scope, scope_ref });
  void queryClient.invalidateQueries({ queryKey: flowKeys.all });
  return f;
}

/* ---- Running and debugging -------------------------------------------- */

export interface Started {
  run_id: string;
  stream_url: string;
  message_id: string;
}

/**
 * Try a message against a graph (or a saved flow) without writing to a thread.
 * Core validates first; an invalid flow fails with flow.invalid and its issues.
 */
export const tryFlow = (input: {
  text: string;
  graph?: FlowGraph;
  flow_id?: string;
  thread_id?: string;
  head_id?: string;
  /** Mock models: wiring and context sizes at zero cost. */
  mock?: boolean;
}) =>
  api.post<Started>('/flows/try', input).then((s) => {
    helpDone('flow');
    return s;
  });

/** The issues of a flow.invalid error, if that is what it was. */
export function invalidIssues(err: unknown): FlowIssue[] | null {
  if (!(err instanceof ApiCallError) || err.body.error.code !== 'flow.invalid') return null;
  const issues = (err.body.error.context as { issues?: FlowIssue[] } | undefined)?.issues;
  return Array.isArray(issues) ? issues : [];
}

export interface RunNodeResult {
  node_id: string;
  output: string;
  model_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  ms: number;
  payload: unknown;
}

/** Run one node on its own (with its workers, for a manager or loop). Answers when done. */
export async function runNode(
  id: string,
  node: string,
  input: { graph: FlowGraph; input: string; thread_id?: string; mock?: boolean },
): Promise<RunNodeResult> {
  const r = await api.post<RunNodeResult>(`/flows/${id}/nodes/${node}/run`, input);
  void queryClient.invalidateQueries({ queryKey: flowKeys.lastRun(id, node) });
  return r;
}

/** Everything a node needs, to run "up to here": the node, its ancestors, and an answer after it. */
export function upToHere(g: FlowGraph, nodeId: string): FlowGraph {
  const keep = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const e of g.edges)
      if (e.to === id && !keep.has(e.from)) {
        keep.add(e.from);
        queue.push(e.from);
      }
  }
  const nodes = g.nodes.filter(
    (n) => keep.has(n.id) && n.kind !== 'output' && n.kind !== 'note' && n.kind !== 'group',
  );
  const out = '__here';
  return {
    ...g,
    nodes: [...nodes, { id: out, kind: 'output', position: { x: 0, y: 0 }, params: { template: '' } }],
    edges: [
      ...g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
      { id: '__to-here', from: nodeId, to: out },
    ],
  };
}

export interface LastRun {
  node_id: string;
  at: string;
  /** Exactly what the node was shown. */
  payload: unknown;
  output: string;
  meta: {
    model_id?: string | null;
    cost_usd?: number;
    tokens_in?: number;
    tokens_out?: number;
    ms?: number;
    trimmed?: unknown;
  };
}

/** A node's last run; null when it has not run yet (Core answers 404). */
export function useLastRun(id: string | undefined, node: string | undefined) {
  return useQuery({
    queryKey: flowKeys.lastRun(id ?? 'none', node ?? 'none'),
    enabled: !!id && !!node,
    queryFn: async () => {
      try {
        return await api.get<LastRun>(`/flows/${id}/nodes/${node}/last`);
      } catch (err) {
        if (err instanceof ApiCallError && err.status === 404) return null;
        throw err;
      }
    },
    retry: false,
  });
}

export interface EdgeEstimate {
  edge_id: string | null;
  node_id: string;
  tokens: {
    system: number;
    memory: number;
    sources: number;
    conversation: number;
    upstream: number;
    task: number;
  };
  total: number;
  context_window: number | null;
  over: boolean;
}

export const estimateContext = (input: { graph: FlowGraph; thread_id?: string; text?: string }) =>
  api.post<{ edges: EdgeEstimate[] }>('/flows/estimate-context', input);

export function useDecisions(id: string | undefined, node: string | undefined) {
  return useQuery({
    queryKey: flowKeys.decisions(id ?? 'none', node ?? 'none'),
    enabled: !!id && !!node,
    queryFn: async () =>
      items(
        await api.get<RouteDecisionRecord[] | { items: RouteDecisionRecord[] }>(
          `/flows/${id}/decisions?node=${encodeURIComponent(node ?? '')}`,
        ),
      ),
    retry: (n, err) => !needsCore(err) && n < 1,
  });
}

/** Decisions where the top two routes were within a whisker. */
export function useCloseCalls(id: string | undefined) {
  return useQuery({
    queryKey: flowKeys.closeCalls(id ?? 'none'),
    enabled: !!id,
    queryFn: async () =>
      items(
        await api.get<RouteDecisionRecord[] | { items: RouteDecisionRecord[] }>(
          `/flows/${id}/decisions?close=1`,
        ),
      ),
    retry: (n, err) => !needsCore(err) && n < 1,
  });
}

export async function labelDecision(id: string, d: RouteDecisionRecord, label: string | null): Promise<void> {
  await api.post(
    `/flows/decisions/${encodeURIComponent(d.message_id)}/${encodeURIComponent(d.node_id)}/label`,
    { label },
  );
  void queryClient.invalidateQueries({ queryKey: flowKeys.closeCalls(id) });
  void queryClient.invalidateQueries({ queryKey: flowKeys.decisions(id, d.node_id) });
}
