/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry collectors
 *  Ref      |  docs/telemetry.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Where the numbers come from, without touching the code
 *           |  that does the work: the API (which feature was used,
 *           |  which error answered), the run event log (time to
 *           |  first token, answers, fallbacks, flows), the machine
 *           |  (os, memory) and the workspace (how many of each).
 *  How      |  observeApi() is a Hono observer, observeRunEvents()
 *           |  wraps the run event log, usageOf() counts once a day.
 *           |  Only routes and event types are read, never bodies,
 *           |  text, names or ids.
 * ------------------------------------------------------------------
 */

import { arch, cpus, platform, totalmem } from 'node:os';
import { AncileError, type FlowGraph, type ModelConfig, type telemetry } from '@nvx/contracts';
import type { RunEventInput, RunEventLog } from '../runs/events';
import * as B from './buckets';
import type { Telemetry } from './service';

type Data = Record<string, string | number | boolean>;
type Feature = telemetry.Feature;

/* ---- API: route → feature ------------------------------------------------------ */

const ROUTES: [method: string, path: RegExp, feature: Feature][] = [
  ['POST', /^\/threads\/[^/]+\/messages$/, 'send'],
  ['POST', /^\/messages\/[^/]+\/regenerate$/, 'regenerate_same'],
  ['POST', /^\/messages\/[^/]+\/route-again$/, 'flow_route_again'],
  ['POST', /^\/messages\/[^/]+\/edit$/, 'edit_question'],
  ['POST', /^\/messages\/[^/]+\/branch$/, 'branch'],
  ['PATCH', /^\/branches\/[^/]+$/, 'branch_rename'],
  ['POST', /^\/merge$/, 'merge'],
  ['POST', /^\/threads\/[^/]+\/compare$/, 'compare'],
  ['POST', /^\/threads\/[^/]+\/compact$/, 'compact'],
  ['GET', /^\/threads\/[^/]+\/tree$/, 'tree_full'],
  ['POST', /^\/messages\/[^/]+\/factcheck$/, 'factcheck'],
  ['GET', /^\/messages\/[^/]+\/explain$/, 'why'],
  ['POST', /^\/memory\/revert$/, 'memory_restore'],
  ['PUT', /^\/memory\/files\//, 'memory_edit'],
  ['POST', /^\/messages\/[^/]+\/lab$/, 'lab_run'],
  ['POST', /^\/runs\/[^/]+\/undo$/, 'lab_undo'],
  ['POST', /^\/flows$/, 'flow_create'],
  ['POST', /^\/flows\/import$/, 'flow_yaml'],
  ['GET', /^\/flows\/[^/]+\/export$/, 'flow_yaml'],
  ['POST', /^\/flows\/try$/, 'flow_try'],
  ['POST', /^\/flows\/[^/]+\/publish$/, 'flow_publish'],
  ['POST', /^\/flows\/[^/]+\/activate$/, 'flow_activate'],
  ['POST', /^\/messages\/[^/]+\/to-note$/, 'note_save'],
  ['POST', /^\/notebooks\/[^/]+\/notes$/, 'note_save'],
  ['POST', /^\/notebooks$/, 'notebook_create'],
  ['POST', /^\/models$/, 'model_add'],
  ['POST', /^\/runs\/[^/]+\/use-cloud$/, 'compute_cloud_instead'],
  ['POST', /^\/mcp\/clients$/, 'mcp_add'],
  ['POST', /^\/mcp\/presets\//, 'mcp_add'],
  ['POST', /^\/system\/diagnostics$/, 'diagnostics_run'],
  ['GET', /^\/logs$/, 'logs_open'],
  ['GET', /^\/traces$/, 'traces_open'],
  ['GET', /^\/(runs|traces)\/[^/]+\/replay$/, 'replay'],
  ['GET', /^\/logs\/export$/, 'export'],
];

export interface ApiObservation {
  method: string;
  /** The path under /api/v1. */
  path: string;
  status: number;
  ms: number;
  error?: unknown;
  /** The request body, when it was JSON and already read by the handler. */
  body?: () => Promise<unknown>;
}

const field = (b: unknown, k: string): unknown =>
  b && typeof b === 'object' ? (b as Record<string, unknown>)[k] : undefined;

/** Hono observer for /api/v1: features used, errors answered, and API latency. */
export function observeApi(t: Telemetry, extra?: (o: ApiObservation) => void) {
  return (o: ApiObservation): void => {
    try {
      if (o.path.startsWith('/telemetry') || o.path === '/events' || o.path.endsWith('/stream')) return;
      if (o.method !== 'GET') t.timing('api', o.ms);
      if (o.error instanceof AncileError) t.error(o.error.code, o.status >= 500 ? '5xx' : '4xx');
      else if (o.error) {
        const kind = (o.error as { constructor?: { name?: string } }).constructor?.name ?? 'Error';
        t.exception('core', kind);
      }
      if (o.status >= 400) return;
      const hit = ROUTES.find(([m, re]) => m === o.method && re.test(o.path));
      if (!hit) return;
      let feature = hit[2];
      void (async () => {
        const body = o.body ? await o.body().catch(() => undefined) : undefined;
        if (feature === 'regenerate_same') {
          const route = field(body, 'route');
          if (field(body, 'model')) feature = 'regenerate_model';
          else if (route === 'again') feature = 'regenerate_again';
        }
        if (feature === 'send') {
          t.funnel('first_question');
          const mentions = field(body, 'mentions');
          if (Array.isArray(mentions)) {
            const kinds = new Set(mentions.map((m) => field(m, 'kind')));
            if (kinds.has('source')) t.feature('mention_source');
            if (kinds.has('model')) t.feature('mention_model');
            if (kinds.has('flow')) t.feature('mention_flow');
          }
          if (field(body, 'model')) t.feature('model_switch');
        }
        if (feature === 'branch') t.funnel('first_branch');
        if (feature === 'flow_try') t.funnel('first_flow_try');
        if (feature === 'notebook_create') t.funnel('notebook_created');
        if (feature === 'flow_activate' && field(body, 'on') !== false) t.funnel('first_flow_active');
        t.feature(feature);
        extra?.(o);
      })();
      if (o.method === 'POST' && /^\/(notebooks\/[^/]+\/)?sources$/.test(o.path)) t.funnel('source_added');
      if (o.method === 'POST' && /^\/approvals\/[^/]+$/.test(o.path))
        void (async () => {
          const body = o.body ? await o.body().catch(() => undefined) : undefined;
          const d = field(body, 'decision') ?? field(body, 'status');
          t.feature(typeof d === 'string' && /deny|reject/.test(d) ? 'approval_deny' : 'approval_allow');
        })();
      if (o.method === 'POST' && /^\/memory\/proposals\/[^/]+$/.test(o.path))
        void (async () => {
          const body = o.body ? await o.body().catch(() => undefined) : undefined;
          const a = field(body, 'action') ?? field(body, 'decision');
          t.feature(
            typeof a === 'string' && /reject|dismiss|deny/.test(a) ? 'memory_reject' : 'memory_accept',
          );
        })();
      if (o.method === 'POST' && /^\/compute\/nodes\/[^/]+\/actions$/.test(o.path))
        void (async () => {
          const body = o.body ? await o.body().catch(() => undefined) : undefined;
          t.feature(field(body, 'action') === 'stop' ? 'compute_stop' : 'compute_start');
        })();
    } catch {
      /* statistics never break a request */
    }
  };
}

/* ---- Runs: timings and outcomes ------------------------------------------------- */

interface Live {
  start: number;
  firstToken: boolean;
  flowStart?: number;
  grounded: boolean;
}

/** Wrap the run event log so every answer reports its timings. Nothing else changes. */
export function observeRunEvents(log: RunEventLog, t: Telemetry, now = () => Date.now()): RunEventLog {
  const live = new Map<string, Live>();
  const get = (runId: string) => {
    let l = live.get(runId);
    if (!l) {
      if (live.size > 500) live.delete(live.keys().next().value as string);
      l = { start: now(), firstToken: false, grounded: false };
      live.set(runId, l);
    }
    return l;
  };
  const see = (runId: string, e: RunEventInput) => {
    try {
      switch (e.type) {
        case 'run.status':
          if (e.status === 'running') get(runId);
          else if (e.status === 'cancelled') {
            t.count('answers_stopped');
            live.delete(runId);
          }
          break;
        case 'text.delta': {
          const l = get(runId);
          if (!l.firstToken) {
            l.firstToken = true;
            t.timing('first_token', now() - l.start);
          }
          break;
        }
        case 'retrieval.done':
          t.timing('retrieval', e.ms);
          break;
        case 'citation':
          get(runId).grounded = true;
          break;
        case 'fallback':
          t.count('fallbacks');
          break;
        case 'tool.call':
          t.count('tool_calls');
          break;
        case 'approval.required':
          t.count('approvals_asked');
          break;
        case 'compute.waiting':
          t.count('compute_waits');
          break;
        case 'flow.started':
          get(runId).flowStart = now();
          t.count('flow_turns');
          t.feature('flow_turn');
          break;
        case 'flow.node.finished':
          t.count('flow_nodes');
          if (e.status === 'done') t.timing('flow_node', e.ms);
          break;
        case 'error':
          t.count('answers_failed');
          t.error(e.code, 'stream');
          if (/^flow\.(budget|steps|timeout)$/.test(e.code)) t.count('flow_guard_stops');
          live.delete(runId);
          break;
        case 'done': {
          const l = live.get(runId);
          if (l) {
            t.count('answers');
            t.timing('answer', now() - l.start);
            if (l.flowStart !== undefined) t.timing('flow_answer', now() - l.flowStart);
            if (l.grounded) {
              t.count('grounded_answers');
              t.funnel('first_grounded_answer');
            }
          }
          live.delete(runId);
          break;
        }
        default:
          break;
      }
    } catch {
      /* never */
    }
  };
  return {
    async append(runId, event) {
      const r = await log.append(runId, event);
      see(runId, event);
      return r;
    },
    since: (runId, after) => log.since(runId, after),
    subscribe: (runId, fn) => log.subscribe(runId, fn),
  };
}

/* ---- The machine ------------------------------------------------------------------ */

export function serverEnv(): Data {
  const os = platform();
  const a = arch();
  return {
    os: os === 'win32' ? 'windows' : os === 'darwin' ? 'macos' : os === 'linux' ? 'linux' : 'other',
    arch: a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : 'other',
    ram: B.ramBucket(totalmem()),
    cores: B.coresBucket(cpus().length || 1),
  };
}

/* ---- Flows: shape only ------------------------------------------------------------- */

export function flowShape(
  graph: Pick<FlowGraph, 'nodes' | 'edges'>,
  scope: 'workspace' | 'notebook' | 'thread',
  on: 'publish' | 'activate',
): Data {
  const kinds = new Set(graph.nodes.map((n) => n.kind));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const input = graph.nodes.find((n) => n.kind === 'input');
  let depth = 0;
  if (input) {
    const seen = new Map<string, number>([[input.id, 0]]);
    const queue = [input.id];
    while (queue.length) {
      const id = queue.shift() as string;
      const d = seen.get(id) ?? 0;
      depth = Math.max(depth, d);
      for (const to of out.get(id) ?? []) {
        if (seen.has(to)) continue;
        seen.set(to, d + 1);
        queue.push(to);
      }
    }
  }
  const models = new Set(
    graph.nodes.flatMap((n) => {
      const m = (n.params as { model?: unknown }).model;
      return typeof m === 'string' && m ? [m] : [];
    }),
  );
  const narrowed = graph.edges.filter((e) => {
    const c = e.context as
      | { conversation?: { mode?: string }; upstream?: string; budget?: unknown }
      | undefined;
    return !!c && (c.conversation?.mode === 'none' || c.upstream === 'plan' || c.budget !== undefined);
  }).length;
  const data: Data = {
    nodes: B.count(graph.nodes.length),
    depth: B.count(depth),
    models: B.count(models.size),
    scope,
    on,
    narrowed_edges: B.count(narrowed),
  };
  for (const k of kinds) data[`k_${k}`] = true;
  return data;
}

/* ---- The workspace: how many of each, bucketed ------------------------------------ */

export function providerKind(m: Pick<ModelConfig, 'provider' | 'via' | 'base_url'>): string {
  if (m.via === 'controller') return 'node';
  const p = m.provider.toLowerCase();
  if (['anthropic', 'openai', 'google', 'openrouter', 'ollama'].includes(p)) return p;
  if (p === 'fake' || p === 'offline' || p === 'test') return 'offline';
  return 'endpoint';
}

export interface UsageDeps {
  notebooks: () => Promise<number>;
  threads: () => Promise<number>;
  /** Source kinds as Knowledge reports them (file, url, text, ...). */
  sourceKinds: () => Promise<string[]>;
  memoryFiles: () => Promise<number>;
  flows: () => Promise<{ active: boolean }[]>;
  gpuNodes: () => Promise<number>;
  mcpServers: () => Promise<number>;
  automations: () => Promise<number>;
  readyModels: () => Promise<Pick<ModelConfig, 'provider' | 'via' | 'base_url'>[]>;
  /** Distinct days with a message you sent, in the last 7 and 28 days. */
  activeDays: () => Promise<{ d7: number; d28: number }>;
  preset: () => Promise<string | null | undefined>;
  memoryMode: () => Promise<string | null | undefined>;
}

const settle = async <T>(p: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p();
  } catch {
    return fallback;
  }
};

export async function usageOf(d: UsageDeps): Promise<Data> {
  const [nb, th, kinds, mem, flows, nodes, mcp, autos, models, days, preset, mode] = await Promise.all([
    settle(d.notebooks, 0),
    settle(d.threads, 0),
    settle(d.sourceKinds, [] as string[]),
    settle(d.memoryFiles, 0),
    settle(d.flows, [] as { active: boolean }[]),
    settle(d.gpuNodes, 0),
    settle(d.mcpServers, 0),
    settle(d.automations, 0),
    settle(d.readyModels, [] as Pick<ModelConfig, 'provider' | 'via' | 'base_url'>[]),
    settle(d.activeDays, { d7: 0, d28: 0 }),
    settle(d.preset, null),
    settle(d.memoryMode, null),
  ]);
  const byKind = (k: string) => kinds.filter((x) => x === k).length;
  const data: Data = {
    notebooks: B.count(nb),
    threads: B.wide(th),
    sources: B.wide(kinds.length),
    sources_file: B.wide(byKind('file')),
    sources_url: B.wide(byKind('url') + byKind('youtube')),
    sources_text: B.wide(byKind('text')),
    memory_files: B.count(mem),
    flows: B.count(flows.length),
    flows_active: B.count(flows.filter((f) => f.active).length),
    gpu_nodes: B.count(nodes),
    mcp_servers: B.count(mcp),
    automations: B.count(autos),
    days_7: String(Math.min(7, Math.max(0, days.d7))),
    days_28: B.days28(days.d28),
    permission_preset:
      preset === 'careful' || preset === 'balanced' || preset === 'hands_off' ? preset : 'custom',
    memory_mode:
      mode === 'propose_all'
        ? 'ask'
        : mode === 'auto_confident'
          ? 'confident'
          : mode === 'off'
            ? 'off'
            : 'unknown',
  };
  const counts = new Map<string, number>();
  for (const m of models) counts.set(providerKind(m), (counts.get(providerKind(m)) ?? 0) + 1);
  for (const k of ['anthropic', 'openai', 'google', 'openrouter', 'endpoint', 'node', 'ollama', 'offline'])
    data[`models_${k}`] = B.count(counts.get(k) ?? 0);
  return data;
}
