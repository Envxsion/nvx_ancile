/**
 * ------------------------------------------------------------------
 *  Title    |  Core entry point
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Boot in an order that fails early and clearly:
 *           |  environment → tracing → database (with retry) →
 *           |  migrations → owner → configuration → secrets and
 *           |  models → permissions → run worker → supervisor → HTTP.
 *           |  Boot tests have already run (scripts/boot.mjs) before
 *           |  this process is started in strict mode.
 *  Note     |  A stray rejected promise is logged, not fatal: one bad
 *           |  background write must not take every open answer down.
 *           |  An uncaught exception is logged and exits (state may be
 *           |  broken); the supervisor or the dev runner restarts Core.
 * ------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { CircuitBreaker } from '@nvx/resilience';
import { createApp } from './app';
import { AutomationRunner, PgAutomationStore, scheduledJobs } from './automations';
import { automationRoutes } from './automations/routes';
import { startComputeBridge } from './compute/bridge';
import { controllerClient } from './compute/controller';
import { computeRoutes } from './compute/routes';
import { chatTurnHandler } from './conductor/pipeline';
import { knowledgeRetriever } from './conductor/retrieval';
import { type AncileConfig, ConfigError, loadConfig } from './config/load';
import { newTraceId, setFetchSpanHook } from './context';
import { ensureOwner } from './db/bootstrap';
import { connect } from './db/client';
import { migrate } from './db/migrate';
import { buildChecks } from './diagnostics/checks';
import { diagnosticRoutes, PgDiagnosticStore } from './diagnostics/routes';
import { DiagnosticRunner } from './diagnostics/runner';
import { loadEnv } from './env';
import { PgEventBus } from './events/bus';
import { factcheckHandler, startFactcheck } from './factcheck/handler';
import { trustRoutes } from './factcheck/routes';
import { PgFactcheckStore } from './factcheck/store';
import { flowRoutes, memoryText } from './flows/routes';
import { PgFlowStore } from './flows/store';
import { flowTryHandler } from './flows/try';
import { FlowsService } from './flows/turn';
import { FakeProvider } from './gateway/fake';
import { Gateway } from './gateway/gateway';
import { AiSdkClient, languageModelFor } from './gateway/providers';
import { ModelRegistry, RoutingClient } from './gateway/registry';
import { coreProbes } from './health/probes';
import { restartAdapterFor } from './health/restart';
import { healthRoutes, recordHealth, systemHealthOf } from './health/routes';
import { DEFAULT_SUPERVISOR, startSupervisor } from './health/supervisor';
import { cockpitOrigins } from './http/guard';
import { knowledgeClient } from './knowledge/client';
import { HttpEngine } from './lab/engine-client';
import { LabMirror } from './lab/event-mirror';
import { labHandler } from './lab/handler';
import { labRoutes } from './lab/routes';
import { licenseRoutes } from './license/routes';
import { hasFeature, parseKeyMap } from './license/verify';
import { logIngestRoutes, logRoutes } from './logs/routes';
import { mcpClientRoutes } from './mcp/clients';
import { McpManager } from './mcp/manager';
import { toolRoutes } from './mcp/routes';
import { mcpEndpoint, PgMcpClientStore } from './mcp/server';
import { MemoryIndex, PgMemoryIndexSink } from './memory/index';
import { utilityFrom } from './memory/llm';
import { PgProposalStore } from './memory/proposals';
import { GitMemoryProvider } from './memory/repo';
import { memoryRoutes } from './memory/routes';
import { DEFAULT_MEMORY_CONFIG, MemoryService } from './memory/service';
import { PgNotebookRepo } from './notebooks/repo';
import { notebookRoutes } from './notebooks/routes';
import { notificationRoutes, PgNotificationStore, startNotificationSink } from './notifications/routes';
import { log, logFor, setLogTap } from './obs/logger';
import { traceRoutes } from './obs/routes';
import { setSpanSink, startSpan } from './obs/spans';
import { ObsPipeline, PgObsStore, toNewLog } from './obs/store';
import { startTracing, stopTracing } from './obs/tracing';
import { loadCedarEvaluator } from './permissions/cedar';
import type { PolicyEvaluator } from './permissions/decide';
import { createGate } from './permissions/gate';
import { reconcileApprovals, withdrawApprovals } from './permissions/reconcile';
import { permissionRoutes } from './permissions/routes';
import { PgPermissionStore } from './permissions/store';
import { loadPro } from './pro';
import { ownerIdentity, proRoutes } from './pro/routes';
import { proServices } from './pro/services';
import { sqlSyncSource } from './pro/sync-source';
import { GhCliClient, GitHubAccessor, GitHubRestClient, savedToken } from './repos/github';
import { MCP_ADDED_SETTING, repoRoutes } from './repos/routes';
import { RepoService } from './repos/service';
import { repoTools } from './repos/tools';
import { PgRunEventLog } from './runs/events';
import { PgRunStore } from './runs/store';
import { RunWorker } from './runs/worker';
import { importEnvKeys, PgSecretStore, SecretBox } from './secrets';
import { PgSettings, SETTING } from './settings';
import { liveTester, setupRoutes } from './setup/routes';
import { PgStateStore, stateRoutes } from './state/routes';
import { flowShape, observeApi, observeRunEvents, serverEnv, usageOf } from './telemetry/collect';
import { telemetryRoutes } from './telemetry/routes';
import { Telemetry } from './telemetry/service';
import { PgTelemetryStore } from './telemetry/store';
import { PgBranchStore } from './threads/branches';
import { branchRoutes } from './threads/branchRoutes';
import { PgThreadRepo } from './threads/repo';
import { threadRoutes } from './threads/routes';
import { branchSuggester } from './threads/suggest';
import { fsTools, Workspace } from './tools/builtin/fs';
import { overrideFor, ToolRegistry } from './tools/registry';

const supervisorLog = logFor('supervisor');

const VERSION = process.env.npm_package_version ?? '0.1.0';

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'a background task failed and nobody handled it');
});
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Core hit an error it cannot recover from; exiting');
  process.exit(1);
});

/** The names people see for services in notices (the Health screen uses the same). */
const SERVICE_NAMES: Record<string, string> = {
  postgres: 'The database',
  knowledge: 'Knowledge',
  notebook: 'Notebooks',
  agent: 'The lab',
  controller: 'The Controller',
  disk: 'Disk space',
};
const serviceName = (id: string) => SERVICE_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

async function main() {
  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(78); // EX_CONFIG
  }

  startTracing({
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    namespace: env.OTEL_SERVICE_NAMESPACE,
    version: VERSION,
  });
  await mkdir(resolve(env.ANCILE_DATA_DIR), { recursive: true });

  const database = await connect(env.DATABASE_URL, { poolMax: env.DATABASE_POOL_MAX });
  const applied = await migrate(database.sql);
  if (applied.length) log.info({ applied }, 'database migrated');

  let config: AncileConfig;
  try {
    config = await loadConfig(resolve(env.ANCILE_CONFIG_DIR));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(78);
    }
    throw err;
  }
  const { sql } = database;
  const owner = await ensureOwner(sql);

  // ---- Phase 5: every log line and span into the store Admin reads ----
  const obsStore = new PgObsStore(sql);
  const obs = new ObsPipeline(obsStore);
  setLogTap((raw) => {
    const line = toNewLog(raw, 'core');
    if (line) obs.pushLog(line);
  });
  setSpanSink((span) => obs.pushSpan(span));
  setFetchSpanHook((method, url, spanId) => {
    const span = startSpan(
      `${method} ${url.host}${url.pathname}`,
      'client',
      { 'http.url': `${url.origin}${url.pathname}` },
      { spanId },
    );
    return {
      end: (status, error) =>
        span.end(error || (status ?? 0) >= 500 ? 'error' : 'ok', {
          'http.status': status,
          ...(error && { error }),
        }),
    };
  });
  // ---- end Phase 5 observability ----

  const events = await PgEventBus.start(sql);
  // Every notice is kept for the notification centre (90 days).
  const notifications = new PgNotificationStore(sql, owner.userId);
  startNotificationSink(events, notifications);
  const settings = new PgSettings(sql);
  const secrets = new PgSecretStore(sql, new SecretBox(env.ANCILE_SECRET_KEY));
  const imported = await importEnvKeys(secrets, process.env);
  if (imported.length) log.info({ secrets: imported }, 'stored provider keys from the environment');

  // Models: config, plus the offline test model when asked for.
  const registry = new ModelRegistry({
    models: config.models?.models ?? [],
    taskClasses: config.routing?.task_classes ?? {},
    secrets,
    settings,
    offline: env.ANCILE_OFFLINE_MODELS,
  });
  await registry.refresh();
  const endpoints = {
    controllerUrl: env.CONTROLLER_URL,
    controllerToken: env.CONTROLLER_TOKEN,
    ollamaUrl: env.OLLAMA_BASE_URL,
  };
  // ---- Phase 5: remote compute (the Controller) ----
  const compute = controllerClient({ url: env.CONTROLLER_URL, token: env.CONTROLLER_TOKEN });
  const stopCompute = startComputeBridge({ client: compute, registry, bus: events });
  // ---- end Phase 5 ----
  const gateway = new Gateway({
    client: new RoutingClient(new AiSdkClient(secrets, endpoints), new FakeProvider({ wordDelayMs: 25 })),
    breaker: new CircuitBreaker(),
  });
  const chatReady = registry
    .info()
    .filter(
      (m) =>
        m.status === 'ready' && !m.capabilities.includes('embeddings') && !m.capabilities.includes('rerank'),
    );
  log.info(
    { models: chatReady.map((m) => m.id), offline: env.ANCILE_OFFLINE_MODELS },
    chatReady.length ? 'chat models ready' : 'no chat model is ready yet: add a key in onboarding',
  );

  // Tools and permissions.
  const workspace = new Workspace(
    resolve(env.ANCILE_WORKSPACE_DIR ?? resolve(env.ANCILE_DATA_DIR, 'workspace')),
    config.tools?.workspace_root ?? '/workspace',
  );
  await workspace.ensure();
  const tools = new ToolRegistry();
  for (const t of fsTools(workspace)) tools.register(t, overrideFor(config.tools?.tools, t.action));
  const mcp = new McpManager(tools, { secrets, version: VERSION });
  // Servers from config/mcp.yaml, plus ones added from the app (the GitHub
  // preset); a name in the file wins.
  const configured = config.mcp?.servers ?? [];
  const added = ((await settings.get<typeof configured>(MCP_ADDED_SETTING)) ?? []).filter(
    (a) => !configured.some((c) => c.name === a.name),
  );
  // In the background: a slow or broken MCP server never delays boot.
  void mcp.start([...configured, ...added]).catch((err) => log.error({ err }, 'MCP start failed'));
  // Repositories (DESIGN §17): git folders, their state, and gated git and GitHub tools.
  const repos = new RepoService({ settings, bus: events });
  await repos.load();
  repos.start();
  const github = new GitHubAccessor(new GhCliClient(), new GitHubRestClient(savedToken(secrets)));
  for (const t of repoTools(repos, github)) tools.register(t, overrideFor(config.tools?.tools, t.action));
  const permissions = new PgPermissionStore(sql);
  let policy = await loadCedarEvaluator({
    files: config.policies,
    preset: (await settings.get<string>(SETTING.preset)) ?? config.tools?.preset ?? 'balanced',
  });
  const policyRef: PolicyEvaluator = {
    forbids: (r) => policy.forbids(r),
    escalation: (r) => policy.escalation(r),
  };
  const gate = createGate({
    policy: policyRef,
    store: permissions,
    workspaceRoot: workspace.root,
    fs: workspace.probe(),
  });

  // Durable runs.
  const runStore = new PgRunStore(sql);
  // Anonymous usage statistics (docs/telemetry.md): off until you say yes.
  let tierNow: () => 'free' | 'pro' | 'max_access' = () => 'free';
  const telemetry = new Telemetry({
    store: new PgTelemetryStore(sql),
    settings,
    version: VERSION,
    channel: env.NODE_ENV === 'production' && !VERSION.includes('-') ? 'release' : 'dev',
    endpoint: env.NVX_TELEMETRY_URL,
    tier: () => tierNow(),
    env: serverEnv,
  });
  const runEvents = observeRunEvents(new PgRunEventLog(sql), telemetry);
  const threads = new PgThreadRepo(sql);
  const branchStore = new PgBranchStore(sql);
  const notebooks = new PgNotebookRepo(sql);
  const kn = knowledgeClient({ baseUrl: env.KNOWLEDGE_URL, serviceToken: env.ANCILE_SERVICE_TOKEN });

  // Memory: a git repository of markdown files, indexed, injected and learned into.
  const memoryProvider = new GitMemoryProvider({
    root: resolve(env.ANCILE_DATA_DIR, 'memory'),
    author: { name: env.ANCILE_MEMORY_AUTHOR_NAME, email: env.ANCILE_MEMORY_AUTHOR_EMAIL },
    template: resolve(
      env.ANCILE_MEMORY_TEMPLATE_DIR ?? resolve(env.ANCILE_CONFIG_DIR, '..', 'memory-template'),
    ),
  });
  const ownerName =
    (await sql<{ display_name: string }[]>`select display_name from core.users where id = ${owner.userId}`)[0]
      ?.display_name ?? 'You';
  const memory = new MemoryService({
    provider: memoryProvider,
    index: new MemoryIndex(memoryProvider, new PgMemoryIndexSink(sql)),
    proposals: new PgProposalStore(sql),
    config: config.memory ?? DEFAULT_MEMORY_CONFIG,
    user: { name: ownerName, email: `${owner.userId}@ancile.local` },
    settings,
    bus: events,
    utility: utilityFrom({ gateway, registry, promptsDir: resolve(env.ANCILE_PROMPTS_DIR) }),
    threads,
    notebook: async (id) => {
      const n = await notebooks.get(id);
      return n ? { id: n.id, slug: n.slug, title: n.title } : null;
    },
  });
  try {
    await memory.start();
  } catch (err) {
    // Answers still work without memory; Health and the Memory page say why.
    log.error({ err }, 'memory could not start: is git installed?');
  }
  // The lab lane: optional, it needs Bun. Core is its only way to a model.
  const engine =
    env.AGENT_ENGINE_URL && env.AGENT_ENGINE_TOKEN
      ? new HttpEngine(env.AGENT_ENGINE_URL, env.AGENT_ENGINE_TOKEN)
      : null;
  const mirror = engine
    ? new LabMirror({
        engine,
        events: runEvents,
        gate,
        permissions,
        bus: events,
        userId: owner.userId,
        approvalTtlMs: env.ANCILE_APPROVAL_TTL_S * 1000,
      })
    : null;
  mirror?.start();
  const labSnapshots = resolve(env.ANCILE_DATA_DIR, 'lab-snapshots');
  const factchecks = new PgFactcheckStore(sql);
  // ---- Flows (Phase 5b): graphs that decide how a message is answered ----
  const flowStore = new PgFlowStore(sql, owner.workspaceId);
  const flows = new FlowsService({
    store: flowStore,
    repo: threads,
    registry,
    gateway,
    promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
    retriever: knowledgeRetriever(kn),
    kn,
    memory: memoryText((q) => memory.pack(q)),
    monthSpendUsd: async () => {
      const rows = await sql<{ usd: number | null }[]>`
        select sum((usage->>'cost_usd')::float8) as usd from core.messages
        where created_at >= date_trunc('month', now()) and usage is not null`;
      // Model usage, plus what GPU nodes have cost this month (when the Controller answers).
      const gpu = await compute
        .get<{ total_to_date: number }>('/costs')
        .then((c) => Number(c.total_to_date) || 0)
        .catch(() => 0);
      return Number(rows[0]?.usd ?? 0) + gpu;
    },
    // A rule's "node is awake": the Controller's own view of the node.
    nodeAwake: async (nodeId) =>
      compute
        .get<{ items: { id: string; observed_state: string }[] }>('/nodes')
        .then((r) => r.items.some((n) => n.id === nodeId && n.observed_state === 'running'))
        .catch(() => false),
  });
  // ---- end Flows ----
  const familyOf = (id: string | null) => (id ? (registry.get(id)?.family ?? null) : null);

  // The reconciler resumes runs through the worker it belongs to (called only after start()).
  const worker: RunWorker = new RunWorker({
    concurrency: env.ANCILE_RUN_CONCURRENCY,
    store: runStore,
    events: runEvents,
    bus: events,
    reconcile: () =>
      reconcileApprovals({
        permissions,
        runs: runStore,
        events: runEvents,
        bus: events,
        worker,
        userId: owner.userId,
        traceId: newTraceId,
        ...(mirror && { onResolved: (a, status, reason) => mirror.resolved(a, status, reason) }),
      }),
    onSettled: async (run) => {
      await withdrawApprovals({ permissions, bus: events }, run.id);
    },
    handlers: {
      chat_turn: chatTurnHandler({
        repo: threads,
        registry,
        gateway,
        tools,
        gate,
        permissions,
        bus: events,
        userId: owner.userId,
        promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
        approvalTtlMs: env.ANCILE_APPROVAL_TTL_S * 1000,
        retriever: knowledgeRetriever(kn),
        // Only a notebook in this workspace lends its title (an @-mentioned id is user input).
        notebookTitle: async (id) => {
          const nb = await notebooks.get(id);
          return nb && nb.workspace_id === owner.workspaceId ? nb.title : null;
        },
        branches: branchStore,
        flows,
        memory,
        // Grounded mode (DESIGN.md §10.7): every answer in the notebook is fact-checked.
        afterAnswer: async (a) => {
          if (!a.notebookId || !(await notebooks.get(a.notebookId))?.grounded) return;
          await startFactcheck(
            { repo: threads, runs: runStore, store: factchecks, worker, familyOf },
            a.messageId,
            { workspaceId: a.workspaceId, notebookId: a.notebookId },
          );
        },
      }),
      flow_try: flowTryHandler(flows),
      factcheck: factcheckHandler({
        gateway,
        registry,
        promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
        kn,
        repo: threads,
        store: factchecks,
        config: config.factcheck ?? undefined,
      }),
      ...(engine &&
        mirror && {
          agent: labHandler({
            engine,
            mirror,
            repo: threads,
            workspaceDir: workspace.dir,
            workspaceRoot: workspace.root,
            snapshotsDir: labSnapshots,
            deadlineMs: env.ANCILE_LAB_TIMEOUT_S * 1000,
          }),
        }),
    },
  });
  await worker.start();

  const probes = coreProbes({
    sql,
    knowledgeUrl: env.KNOWLEDGE_URL,
    controllerUrl: env.CONTROLLER_URL,
    agent:
      env.AGENT_ENGINE_URL && env.AGENT_ENGINE_TOKEN
        ? { url: env.AGENT_ENGINE_URL, token: env.AGENT_ENGINE_TOKEN }
        : undefined,
    dataDir: resolve(env.ANCILE_DATA_DIR),
  });
  // The dev runner (`pnpm start`) can restart the other services; it passes its address.
  const control =
    process.env.ANCILE_CONTROL_URL && process.env.ANCILE_CONTROL_TOKEN
      ? { url: process.env.ANCILE_CONTROL_URL, token: process.env.ANCILE_CONTROL_TOKEN }
      : null;
  const supervisor = startSupervisor(probes, {
    intervalMs: env.ANCILE_HEALTH_INTERVAL_S * 1000,
    policy: { ...DEFAULT_SUPERVISOR, restartAfter: env.ANCILE_RESTART_AFTER_FAILURES },
    restart: restartAdapterFor(env.ANCILE_RESTART_ADAPTER, control),
    hooks: {
      onChange: async (state, action, remediation) => {
        // Every transition is in the log too, not only on the event bus, so
        // "what happened at 3am" is answerable from Admin → Logs.
        const line = {
          target: state.service,
          status: state.status,
          action,
          failures: state.consecutiveFailures,
          error: state.lastError,
        };
        if (state.status === 'ok') {
          // The last error describes the outage that just ended, not a current fault.
          const { error: lastError, ...rest } = line;
          supervisorLog.info(
            { ...rest, ...(action === 'recovered' && { recovered_from: lastError }) },
            `${state.service} is healthy`,
          );
        } else if (action === 'needs_attention' || state.status === 'down')
          supervisorLog.error({ ...line, remediation }, `${state.service} is down`);
        else supervisorLog.warn(line, `${state.service} is ${state.status}`);
        await events.publish({
          type: 'health.changed',
          service: state.service,
          status: state.status,
          ...(!!state.lastError && { detail: state.lastError }),
        });
        await recordHealth(sql, state, state.status === 'ok' ? null : remediation).catch((err: unknown) =>
          supervisorLog.warn({ err }, 'could not record the health change'),
        );
        if (action === 'restart')
          await events.publish({
            type: 'notification',
            id: `ntf_restart_${state.service}_${Date.now()}`,
            level: 'warn',
            title: `Restarting ${serviceName(state.service).replace(/^The /, 'the ')}`,
            body: state.lastError ? `It stopped answering: ${state.lastError}` : 'Restart requested.',
            action: { label: 'Open health', href: '/admin/health' },
            category: 'health',
          });
        if (action === 'recovered' && state.restarts.length)
          await events.publish({
            type: 'notification',
            id: `ntf_recovered_${state.service}_${Date.now()}`,
            level: 'success',
            title: `${serviceName(state.service)} is back`,
            action: { label: 'Open health', href: '/admin/health' },
            category: 'health',
          });
        if (action === 'needs_attention') {
          await events.publish({
            type: 'notification',
            id: `ntf_health_${state.service}`,
            level: 'error',
            title: `${serviceName(state.service)} needs attention`,
            body: `${state.lastError ?? 'It stopped answering.'} ${remediation}`,
            action: { label: 'Open health', href: '/admin/health' },
            category: 'health',
          });
        }
      },
    },
  });

  // ---- Phase 5: diagnostics, automations, MCP server, licence ----
  const diagnostics = new DiagnosticRunner(
    () =>
      buildChecks({
        sql,
        probes,
        registry,
        memoryCheck: () => memoryProvider.check(),
        box: new SecretBox(env.ANCILE_SECRET_KEY),
        dataDir: env.ANCILE_DATA_DIR,
        serviceToken: env.ANCILE_SERVICE_TOKEN,
        sourceDir: existsSync(resolve('vitest.config.ts')) ? resolve('.') : null,
        bindHost: env.ANCILE_HOST,
      }),
    new PgDiagnosticStore(sql),
  );
  const automations = new AutomationRunner(
    config.automations?.jobs ?? {},
    scheduledJobs({
      sql,
      obs: obsStore,
      kn,
      memoryDir: resolve(env.ANCILE_DATA_DIR, 'memory'),
      memoryRemote: process.env.ANCILE_MEMORY_REMOTE,
      retention: {
        logsDays: env.ANCILE_LOG_RETENTION_DAYS,
        spansDays: env.ANCILE_SPAN_RETENTION_DAYS,
        runEventsDays: env.ANCILE_RUN_EVENT_RETENTION_DAYS,
      },
    }),
    new PgAutomationStore(sql),
  );
  await automations.start().catch((err: unknown) => log.error({ err }, 'automations did not start'));
  const mcpClients = new PgMcpClientStore(sql);
  const mcpServe = mcpEndpoint({
    clients: mcpClients,
    gate,
    permissions,
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    version: VERSION,
    search: ({ query, notebookId, k }) =>
      kn.post('/search', {
        workspace_id: owner.workspaceId,
        ...(notebookId && { notebook_id: notebookId }),
        query,
        k,
        mode: 'hybrid',
        rerank: true,
      }),
    notebooks: async () =>
      (await notebooks.list(owner.workspaceId)).map((n) => ({
        id: n.id,
        title: n.title,
        description: n.description,
      })),
    memorySearch: async (q, limit) => (await memory.search(q, limit)).items,
  });
  // Open core (DESIGN.md §9): Pro from pro/ when this checkout has it, the free build otherwise.
  const pro = await loadPro({
    tier: env.NVX_TIER,
    host: {
      settings,
      secrets,
      keys: parseKeyMap(env.NVX_LICENSE_KEYS),
      licenseUrl: env.NVX_LICENSE_URL,
      version: VERSION,
    },
  });
  const licence = pro.license;
  await licence.start().catch((err: unknown) => log.warn({ err }, 'the licence could not be read'));
  // Pro's features read the licence each time they run, so a lapse locks them at once.
  const hasProFeature = (f: Parameters<typeof hasFeature>[1]) => hasFeature(licence.status(), f);
  const proFeatures = pro.build === 'pro' ? pro : null;
  if (proFeatures?.start)
    await proFeatures
      .start(
        proServices({
          sql,
          controller: compute,
          events,
          hasFeature: hasProFeature,
          owner: { userId: owner.userId, workspaceId: owner.workspaceId },
          sync: sqlSyncSource(sql, { userId: owner.userId, workspaceId: owner.workspaceId }),
        }),
      )
      .catch((err: unknown) =>
        log.warn({ err }, "Pro's features could not start: the free product carries on"),
      );
  const soleOwner = ownerIdentity({ userId: owner.userId, workspaceId: owner.workspaceId });
  tierNow = () => licence.status().tier;
  telemetry.setUsage(() =>
    usageOf({
      notebooks: async () => (await notebooks.list(owner.workspaceId)).length,
      threads: async () =>
        Number(
          (await sql<{ n: string }[]>`select count(*) as n from core.threads where archived_at is null`)[0]
            ?.n ?? 0,
        ),
      sourceKinds: async () =>
        (await kn.get<{ kind: string }[]>(`/sources?workspace_id=${owner.workspaceId}`)).map((s) => s.kind),
      memoryFiles: async () => (await memory.files()).items.length,
      flows: async () =>
        sql<{ active: boolean }[]>`select active from core.flows where deleted_at is null`.then((r) => [
          ...r,
        ]),
      gpuNodes: async () => (await compute.get<{ items: unknown[] }>('/nodes')).items.length,
      mcpServers: async () => mcp.status().length,
      automations: async () =>
        Number((await sql<{ n: string }[]>`select count(*) as n from core.automations`)[0]?.n ?? 0),
      readyModels: async () => registry.all().filter((m) => registry.status(m) === 'ready'),
      activeDays: async () => {
        const [r] = await sql<{ d7: string; d28: string }[]>`
          select count(distinct date(created_at)) filter (where created_at > now() - interval '7 days') as d7,
                 count(distinct date(created_at)) as d28
          from core.messages where role = 'user' and created_at > now() - interval '28 days'`;
        return { d7: Number(r?.d7 ?? 0), d28: Number(r?.d28 ?? 0) };
      },
      preset: () => settings.get<string>(SETTING.preset),
      memoryMode: () => settings.get<string>(SETTING.memoryCapture),
    }),
  );
  await telemetry.start();
  // ---- end Phase 5 services ----

  const cockpitDist = resolve(env.ANCILE_COCKPIT_DIST ?? '../../apps/cockpit/dist');
  const app = createApp({
    version: VERSION,
    serviceToken: env.ANCILE_SERVICE_TOKEN,
    gatewayToken: env.AGENT_GATEWAY_TOKEN,
    events,
    runEvents,
    health: supervisor.snapshot,
    checkHealthNow: supervisor.checkNow,
    license: () => licence.status(),
    identity: () => proFeatures?.identity ?? soleOwner,
    observe: observeApi(telemetry, (o) => {
      // A flow published or turned on: report its shape, never its words.
      const m = /^\/flows\/([^/]+)\/(publish|activate)$/.exec(o.path);
      if (!m?.[1]) return;
      const on = m[2] as 'publish' | 'activate';
      void flows.deps.store.getLive(m[1]).then((f) => {
        if (f) telemetry.flowShape(flowShape(f, f.scope, on));
      });
    }),
    systemHealth: () =>
      systemHealthOf(supervisor, {
        intervalS: env.ANCILE_HEALTH_INTERVAL_S,
        restartAfter: env.ANCILE_RESTART_AFTER_FAILURES,
      }),
    mcp: mcpServe,
    internalRoutes: [logIngestRoutes({ pipeline: obs })],
    ready: async () => {
      const db = await database.sql`select 1`.then(() => true).catch(() => false);
      return { ok: db, checks: { database: db } };
    },
    internal: { registry, gateway },
    runs: runStore,
    allowedOrigins: cockpitOrigins(env.ANCILE_PUBLIC_URL, env.ANCILE_ALLOWED_ORIGINS),
    routes: [
      // Phase 5: operations
      logRoutes({ pipeline: obs }),
      traceRoutes({
        store: obsStore,
        runs: runStore,
        runEvents,
        turn: { repo: threads, runs: runStore, worker, registry, branches: branchStore },
      }),
      healthRoutes({ supervisor: () => supervisor }),
      diagnosticRoutes({ runner: diagnostics }),
      automationRoutes({ runner: automations }),
      mcpClientRoutes({
        clients: mcpClients,
        permissions,
        userId: owner.userId,
        publicUrl: env.ANCILE_PUBLIC_URL,
      }),
      licenseRoutes({ license: licence }),
      telemetryRoutes({ telemetry }),
      flowRoutes({
        workspaceId: owner.workspaceId,
        flows,
        repo: threads,
        runs: runStore,
        worker,
        tools,
        turn: { repo: threads, runs: runStore, worker, registry, branches: branchStore },
      }),
      threadRoutes({
        repo: threads,
        runs: runStore,
        worker,
        registry,
        workspaceId: owner.workspaceId,
        notebookExists: async (id) => (await notebooks.get(id))?.workspace_id === owner.workspaceId,
        flowStore,
        branches: branchStore,
        afterSend: branchSuggester({
          gateway,
          registry,
          promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
          repo: threads,
          bus: events,
        }),
      }),
      branchRoutes({
        workspaceId: owner.workspaceId,
        repo: threads,
        runs: runStore,
        branches: branchStore,
        gateway,
        registry,
        promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
      }),
      notebookRoutes({ workspaceId: owner.workspaceId, notebooks, threads, kn, flowStore }),
      memoryRoutes({ service: memory, threads, registry }),
      trustRoutes({
        workspaceId: owner.workspaceId,
        repo: threads,
        runs: runStore,
        store: factchecks,
        worker,
        permissions,
        familyOf,
        modelName: (id) => (id ? (registry.get(id)?.display_name ?? null) : null),
        actionOf: (tool) => tools.get(tool)?.action,
      }),
      permissionRoutes({
        store: permissions,
        events: runEvents,
        bus: events,
        worker,
        userId: owner.userId,
        ...(mirror && { onResolved: (a, status, reason) => mirror.resolved(a, status, reason) }),
        scopeRefs: async (a) => {
          const t = a.thread_id ? await threads.getThread(a.thread_id) : undefined;
          return {
            threadId: a.thread_id,
            notebookId: t?.notebook_id ?? null,
            workspaceId: owner.workspaceId,
          };
        },
      }),
      setupRoutes({
        registry,
        secrets,
        settings,
        ollamaUrl: env.OLLAMA_BASE_URL,
        tester: liveTester((m, key) => languageModelFor(m, { get: async () => key }, endpoints)),
        onPreset: async (preset) => {
          policy = await loadCedarEvaluator({ files: config.policies, preset });
          log.info({ preset }, 'permission preset changed');
        },
      }),
      stateRoutes(new PgStateStore(sql, owner.userId)),
      notificationRoutes(notifications),
      computeRoutes({ client: compute, hasFeature: hasProFeature }),
      proRoutes({ routes: proFeatures?.routes ?? [], hasFeature: hasProFeature }),
      toolRoutes({ tools, mcp }),
      repoRoutes({ repos, github, secrets, settings, mcp }),
      labRoutes({
        engine,
        repo: threads,
        runs: runStore,
        worker,
        workspaceId: owner.workspaceId,
        workspaceDir: workspace.dir,
        workspaceRoot: workspace.root,
        snapshotsDir: labSnapshots,
      }),
    ],
    ...(env.NODE_ENV === 'production' && existsSync(cockpitDist) && { cockpitDist }),
  });

  const server = serve({ fetch: app.fetch, hostname: env.ANCILE_HOST, port: env.ANCILE_PORT }, (info) => {
    log.info(
      { host: env.ANCILE_HOST, port: info.port, version: VERSION },
      `NVX Ancile Core ready on ${env.ANCILE_PUBLIC_URL}`,
    );
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    supervisor.stop();
    automations.stop();
    licence.stop();
    proFeatures?.stop?.();
    telemetry.stop();
    await obs.stop();
    stopCompute();
    worker.stop();
    mirror?.stop();
    repos.stop();
    await mcp.stop();
    server.close();
    await database.close();
    await stopTracing();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.fatal({ err }, 'Core failed to start');
  process.exit(1);
});
