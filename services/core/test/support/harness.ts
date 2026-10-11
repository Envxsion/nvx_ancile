/**
 * An in-memory Core for tests: real conductor, worker, gate, permission
 * routes and thread routes, with memory stores, the fake provider and a
 * temporary workspace directory. Nothing touches a network or Postgres.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelConfig, RunEvent } from '@nvx/contracts';
import { CircuitBreaker } from '@nvx/resilience';
import { createApp } from '../../src/app';
import { chatTurnHandler } from '../../src/conductor/pipeline';
import { credentialRoutes } from '../../src/credentials/routes';
import { MemoryEventBus } from '../../src/events/bus';
import { factcheckHandler, startFactcheck } from '../../src/factcheck/handler';
import { trustRoutes } from '../../src/factcheck/routes';
import { MemoryFactcheckStore } from '../../src/factcheck/store';
import { flowRoutes } from '../../src/flows/routes';
import { MemoryFlowStore } from '../../src/flows/store';
import { flowTryHandler } from '../../src/flows/try';
import { FlowsService } from '../../src/flows/turn';
import { FakeProvider } from '../../src/gateway/fake';
import { Gateway } from '../../src/gateway/gateway';
import { ModelRegistry } from '../../src/gateway/registry';
import type { KnowledgeClient } from '../../src/knowledge/client';
import { FREE } from '../../src/license/verify';
import { logIngestRoutes, logRoutes } from '../../src/logs/routes';
import { mcpClientRoutes } from '../../src/mcp/clients';
import { MemoryMcpClientStore, mcpEndpoint } from '../../src/mcp/server';
import { MemoryIndex } from '../../src/memory/index';
import { utilityFrom } from '../../src/memory/llm';
import { MemoryProposalStore } from '../../src/memory/proposals';
import { GitMemoryProvider } from '../../src/memory/repo';
import { memoryRoutes } from '../../src/memory/routes';
import { DEFAULT_MEMORY_CONFIG, MemoryService } from '../../src/memory/service';
import { traceRoutes } from '../../src/obs/routes';
import { MemoryObsStore, ObsPipeline } from '../../src/obs/store';
import { BuiltinPolicy, loadCedarEvaluator } from '../../src/permissions/cedar';
import type { PolicyEvaluator } from '../../src/permissions/decide';
import { createGate } from '../../src/permissions/gate';
import { reconcileApprovals, withdrawApprovals } from '../../src/permissions/reconcile';
import { permissionRoutes } from '../../src/permissions/routes';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { RunWorker } from '../../src/runs/worker';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';
import { type ProviderTester, setupRoutes } from '../../src/setup/routes';
import { MemoryStateStore, stateRoutes } from '../../src/state/routes';
import { MemoryBranchStore } from '../../src/threads/branches';
import { branchRoutes } from '../../src/threads/branchRoutes';
import { MemoryThreadRepo } from '../../src/threads/repo';
import { threadRoutes } from '../../src/threads/routes';
import { branchSuggester } from '../../src/threads/suggest';
import { fsTools, Workspace } from '../../src/tools/builtin/fs';
import { ToolRegistry } from '../../src/tools/registry';

export const WORKSPACE_ID = 'wsp_01TESTWORKSPACE000000000000';
export const USER_ID = 'usr_01TESTUSER00000000000000000';
export const TOKEN = 'x'.repeat(32);
export const GATEWAY = 'g'.repeat(32);

export interface HarnessOptions {
  /** Notebook retrieval for grounded turns. */
  retriever?: import('../../src/conductor/retrieval').Retriever;
  models?: ModelConfig[];
  taskClasses?: Record<string, string[]>;
  offline?: boolean;
  cedar?: Record<string, string>;
  tester?: ProviderTester;
  /** A real git memory repository (seeded from memory-template/) and its routes. */
  memory?: boolean;
  /** Model catalogues for Settings → Models (recorded fixtures). */
  catalogue?: import('../../src/gateway/catalogue').CatalogueSource;
  /** Knowledge's /evidence for fact-checks; without it, every claim lacks evidence. */
  kn?: Pick<KnowledgeClient, 'post'>;
  /** Notebooks in grounded mode: their answers are fact-checked when they finish. */
  grounded?: string[];
  /** Phase 5 operations: logs, traces and replay, MCP server and its apps. */
  ops?: boolean;
  /** Flows: spend so far this month, for rule tests. */
  monthSpendUsd?: number;
  /** Settings → API keys: environment overrides, the service check, RunPod via a Controller. */
  credentials?: {
    env?: Record<string, string | undefined>;
    serviceCheck?: import('../../src/credentials/routes').ServiceCheck;
    runpod?: import('../../src/credentials/routes').CredentialRouteDeps['runpod'];
  };
}

/** memory-template/ at the repository root. */
export const MEMORY_TEMPLATE = fileURLToPath(new URL('../../../../memory-template', import.meta.url));

/** The repository's own prompts, so fact-check tests run the real templates. */
const PROMPTS_DIR = join(import.meta.dirname, '../../../../prompts');

export async function harness(opts: HarnessOptions = {}) {
  /** A clock tests can move (subtree delete Undo). */
  const clock = { now: Date.now() };
  const dir = await mkdtemp(join(tmpdir(), 'ancile-ws-'));
  const repo = new MemoryThreadRepo();
  const branches = new MemoryBranchStore();
  branches.isLive = (id) => {
    const m = repo.msgs.get(id);
    return !!m && !m.deleted_at;
  };
  const runs = new MemoryRunStore();
  const events = new MemoryRunEventLog();
  const bus = new MemoryEventBus();
  const perms = new MemoryPermissionStore();
  const factchecks = new MemoryFactcheckStore();
  const settings = new MemorySettings();
  const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
  const provider = new FakeProvider();
  const registry = new ModelRegistry({
    models: opts.models ?? [],
    taskClasses: opts.taskClasses ?? {},
    secrets,
    settings,
    offline: opts.offline ?? true,
  });
  await registry.refresh();
  const gateway = new Gateway({ client: provider, breaker: new CircuitBreaker() });
  // Flows (Phase 5b)
  const flowStore = new MemoryFlowStore();
  const flows = new FlowsService({
    store: flowStore,
    repo,
    registry,
    gateway,
    promptsDir: PROMPTS_DIR,
    ...(opts.retriever && { retriever: opts.retriever }),
    ...(opts.kn && { kn: opts.kn }),
    monthSpendUsd: async () => opts.monthSpendUsd ?? 0,
  });
  const workspace = new Workspace(dir);
  await workspace.ensure();
  const tools = new ToolRegistry();
  for (const t of fsTools(workspace)) tools.register(t);
  const policy: PolicyEvaluator = opts.cedar
    ? await loadCedarEvaluator({ files: opts.cedar, preset: 'balanced' })
    : new BuiltinPolicy();
  const gate = createGate({ policy, store: perms, workspaceRoot: workspace.root, fs: workspace.probe() });

  let memory: MemoryService | undefined;
  if (opts.memory) {
    const memoryProvider = new GitMemoryProvider({
      root: join(dir, 'memory'),
      author: { name: 'NVX Ancile', email: 'memory@ancile.local' },
      template: MEMORY_TEMPLATE,
    });
    memory = new MemoryService({
      provider: memoryProvider,
      index: new MemoryIndex(memoryProvider),
      proposals: new MemoryProposalStore(),
      config: DEFAULT_MEMORY_CONFIG,
      user: { name: 'You', email: 'you@ancile.local' },
      settings,
      bus,
      utility: utilityFrom({ gateway, registry, promptsDir: join(dir, 'no-prompts') }),
      threads: repo,
      notebook: async (id) => ({ id, slug: 'test-notebook', title: 'Test notebook' }),
    });
    await memory.start();
  }

  // Routes and the reconciler reach whichever worker is current (restart() swaps it).
  const workerRef = {
    kick: () => worker.kick(),
    cancel: (id: string) => worker.cancel(id),
    resume: (id: string, cp?: unknown) => worker.resume(id, cp),
  };

  const makeWorker = (): RunWorker =>
    new RunWorker({
      store: runs,
      events,
      bus,
      pollMs: 20,
      sweepMs: 60_000,
      // Tests call reconcileNow() themselves.
      reconcileMs: 60_000,
      reconcile: () =>
        reconcileApprovals({
          permissions: perms,
          runs,
          events,
          bus,
          worker: workerRef,
          userId: USER_ID,
          traceId: () => 't'.repeat(32),
        }),
      onSettled: async (run) => {
        await withdrawApprovals({ permissions: perms, bus }, run.id);
      },
      handlers: {
        chat_turn: chatTurnHandler({
          repo,
          registry,
          gateway,
          tools,
          gate,
          permissions: perms,
          bus,
          userId: USER_ID,
          promptsDir: join(dir, 'no-prompts'),
          deltaMs: 0,
          ...(opts.retriever && { retriever: opts.retriever }),
          notebookTitle: async () => 'Test notebook',
          branches,
          flows,
          ...(memory && { memory }),
          afterAnswer: async (a) => {
            if (!a.notebookId || !opts.grounded?.includes(a.notebookId)) return;
            await startFactcheck(
              { repo, runs, store: factchecks, worker: workerRef, familyOf },
              a.messageId,
              { workspaceId: a.workspaceId, notebookId: a.notebookId },
            );
          },
        }),
        flow_try: flowTryHandler(flows),
        factcheck: factcheckHandler({
          gateway,
          registry,
          promptsDir: PROMPTS_DIR,
          ...(opts.kn && { kn: opts.kn }),
          repo,
          store: factchecks,
        }),
      },
    });
  const familyOf = (id: string | null) => (id ? (registry.get(id)?.family ?? null) : null);
  let worker = makeWorker();
  await worker.start();

  // Phase 5 operations (opts.ops)
  const obsStore = new MemoryObsStore();
  const obs = new ObsPipeline(obsStore, { flushMs: 5 });
  const mcpClients = new MemoryMcpClientStore();
  const opsRoutes = opts.ops
    ? [
        logRoutes({ pipeline: obs }),
        traceRoutes({
          store: obsStore,
          runs,
          runEvents: events,
          turn: { repo, runs, worker: workerRef, registry, branches },
        }),
        mcpClientRoutes({
          clients: mcpClients,
          permissions: perms,
          userId: USER_ID,
          publicUrl: 'http://core.test',
        }),
      ]
    : [];

  const app = createApp({
    version: 'test',
    serviceToken: TOKEN,
    gatewayToken: GATEWAY,
    events: bus,
    runEvents: events,
    ready: async () => ({ ok: true, checks: {} }),
    health: () => [],
    license: () => FREE,
    internal: { registry, gateway },
    runs,
    ...(opts.ops && {
      internalRoutes: [logIngestRoutes({ pipeline: obs })],
      mcp: mcpEndpoint({
        clients: mcpClients,
        gate,
        permissions: perms,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        version: 'test',
        notebooks: async () => [{ id: 'nbk_pumps', title: 'Pumps', description: null }],
        search: async ({ query }) => ({
          hits: [
            {
              kind: 'chunk',
              chunk_id: 'chk_1',
              source_id: 'src_1',
              source_title: 'P-300 sheet',
              text: `The P-300 pump moves 42 litres a minute. (${query})`,
              heading_path: [],
              page: 2,
              char_start: 0,
              char_end: 40,
              score: 1,
              rerank_score: null,
              ranks: { vector: 1, text: 1 },
            },
          ],
          mode: 'hybrid',
          embedder: 'test',
          ms: 1,
        }),
      }),
    }),
    routes: [
      ...opsRoutes,
      flowRoutes({
        workspaceId: WORKSPACE_ID,
        flows,
        repo,
        runs,
        worker: workerRef,
        tools,
        turn: { repo, runs, worker: workerRef, registry, branches },
      }),
      threadRoutes({
        repo,
        runs,
        worker: workerRef,
        registry,
        workspaceId: WORKSPACE_ID,
        branches,
        flowStore,
        afterSend: branchSuggester({ gateway, registry, promptsDir: PROMPTS_DIR, repo, bus }),
      }),
      branchRoutes({
        workspaceId: WORKSPACE_ID,
        repo,
        runs,
        branches,
        gateway,
        registry,
        promptsDir: PROMPTS_DIR,
        now: () => clock.now,
      }),
      permissionRoutes({
        store: perms,
        preset: (() => {
          let now: 'careful' | 'balanced' | 'hands_off' = 'balanced';
          return {
            get: async () => now,
            set: async (p: typeof now) => {
              now = p;
            },
          };
        })(),
        events,
        bus,
        worker: workerRef,
        userId: USER_ID,
        scopeRefs: async (a) => ({
          threadId: a.thread_id,
          notebookId: (a.thread_id && (await repo.getThread(a.thread_id))?.notebook_id) || null,
          workspaceId: WORKSPACE_ID,
        }),
      }),
      setupRoutes({
        registry,
        secrets,
        settings,
        tester: opts.tester ?? (async ({ model }) => ({ model: model?.id ?? 'x' })),
        ...(opts.catalogue && { catalogue: opts.catalogue }),
      }),
      credentialRoutes({
        secrets,
        env: opts.credentials?.env ?? {},
        registry,
        tester: opts.tester ?? (async ({ model }) => ({ model: model?.id ?? 'x' })),
        serviceCheck: opts.credentials?.serviceCheck ?? (async () => undefined),
        runpod: opts.credentials?.runpod,
      }),
      stateRoutes(new MemoryStateStore()),
      ...(memory ? [memoryRoutes({ service: memory, threads: repo, registry })] : []),
      trustRoutes({
        workspaceId: WORKSPACE_ID,
        repo,
        runs,
        store: factchecks,
        worker: workerRef,
        permissions: perms,
        familyOf,
        modelName: (id) => (id ? (registry.get(id)?.display_name ?? null) : null),
        actionOf: (tool) => tools.get(tool)?.action,
      }),
    ],
  });

  const call = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  /** Wait until the run is no longer queued or running. */
  const settle = async (runId: string, timeoutMs = 3_000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await runs.get(runId);
      if (r && !['queued', 'running'].includes(r.status)) return r;
      if (Date.now() > end) throw new Error(`run ${runId} did not settle (status ${r?.status})`);
      await new Promise((res) => setTimeout(res, 10));
    }
  };

  const eventsOf = async (runId: string): Promise<RunEvent[]> => events.since(runId, 0);

  const text = (evs: RunEvent[]) => evs.flatMap((e) => (e.type === 'text.delta' ? [e.delta] : [])).join('');

  const newThread = async (body: Record<string, unknown> = {}) =>
    (await call<{ id: string }>('POST', '/threads', body)).body.id;

  const send = async (threadId: string, text: string, extra: Record<string, unknown> = {}) => {
    const r = await call<{ run_id: string; user_message_id: string; assistant_message_id: string }>(
      'POST',
      `/threads/${threadId}/messages`,
      {
        parent_id: null,
        parts: [{ type: 'text', text }],
        ...extra,
      },
    );
    if (r.status !== 202) throw new Error(`send failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  return {
    dir,
    app,
    repo,
    runs,
    events,
    bus,
    perms,
    factchecks,
    settings,
    secrets,
    registry,
    provider,
    workspace,
    memory,
    branches,
    flows,
    flowStore,
    clock,
    obs,
    obsStore,
    mcpClients,
    get worker() {
      return worker;
    },
    /** Simulate a Core restart: a fresh worker over the same stores. */
    async restart() {
      worker.stop();
      worker = makeWorker();
      await worker.start();
    },
    call,
    settle,
    eventsOf,
    text,
    newThread,
    send,
    async close() {
      worker.stop();
      await worker.drain();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
