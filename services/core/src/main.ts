/**
 * ------------------------------------------------------------------
 *  Title    |  Core entry point
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Boot in an order that fails early and clearly:
 *           |  environment → tracing → database (with retry) →
 *           |  backup and migrations (db/prepare.ts; a database it
 *           |  cannot safely open shows the start-up screen instead,
 *           |  system/startup.ts) → owner → configuration → secrets and
 *           |  models → permissions → run worker → supervisor → HTTP.
 *           |  Boot tests have already run (scripts/boot.mjs) before
 *           |  this process is started in strict mode.
 *           |  `--preflight` (the desktop app, before Knowledge
 *           |  migrates): check and back up only, then exit 0, or 3
 *           |  for a newer database, 4 for anything else that stops.
 *  Note     |  A stray rejected promise is logged, not fatal: one bad
 *           |  background write must not take every open answer down.
 *           |  An uncaught exception is logged and exits (state may be
 *           |  broken); the supervisor or the dev runner restarts Core.
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { totalmem as osTotalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { AncileError, CLAUDE_CODE_PROVIDER, isClaudeCodeModel, type SearchResponse } from '@nvx/contracts';
import { CircuitBreaker } from '@nvx/resilience';
import { createActivity } from './activity';
import { activityRoutes } from './activity/routes';
import { createApp } from './app';
import { artifactRoutes } from './artifacts/routes';
import { PgArtifactStore } from './artifacts/store';
import { attachmentRoutes } from './attachments/routes';
import { AttachmentService } from './attachments/service';
import {
  AutomationRunner,
  builtinOptions,
  jobSetup,
  memoryCaptureLink,
  PgAutomationStore,
  scheduledJobs,
  testMemoryPush,
  userJobs,
} from './automations';
import { automationRoutes } from './automations/routes';
import { BuiltinSettings, KnowledgeSync } from './automations/settings';
import { appVersion, chosenTier, RELEASE_BUILD, telemetryEndpoint, trustedKeys } from './build';
import { chatImportRoutes } from './chatimport/routes';
import { ChatImportService } from './chatimport/service';
import { PgChatImportStore } from './chatimport/store';
import { createClaudeCode } from './claudecode';
import { ClaudeCodeLive, nativeProbe } from './claudecode/live';
import { ClaudeCodeMcpList } from './claudecode/mcp-list';
import { ClaudeCodeMcpManage } from './claudecode/mcp-manage';
import { ClaudeMcpEndpoint } from './claudecode/mcp-server';
import { PlanLimits } from './claudecode/plan-limits';
import { PgPlanSampleStore, PlanSamples } from './claudecode/plan-samples';
import { TurnQueue } from './claudecode/queue';
import { claudeCodeRoutes } from './claudecode/routes';
import { PgRepoPairStore, SameRepoFinder } from './claudecode/same-repo';
import { PgClaudeCodeStore } from './claudecode/store';
import { startComputeBridge } from './compute/bridge';
import { controllerClient } from './compute/controller';
import { computeRoutes, connectRunPod, disconnectRunPod, providerSync } from './compute/routes';
import { type EndContextSwitch, endContextOn, PgEpochStore } from './conductor/epoch';
import { chatTurnHandler } from './conductor/pipeline';
import { capPerSource, DEFAULT_LIMITS, fetchK, knowledgeRetriever } from './conductor/retrieval';
import { SteerBus } from './conductor/steer';
import { type AncileConfig, ConfigError, loadConfig } from './config/load';
import { newTraceId, setFetchSpanHook } from './context';
import {
  CREDENTIALS,
  credentialRoutes,
  ENV_FOR_SECRET,
  GIT_REMOTE,
  MEMORY_REMOTE_SECRET,
} from './credentials/routes';
import { takeBackup } from './db/backup';
import { ensureOwner } from './db/bootstrap';
import { connect } from './db/client';
import { type Prepared, prepareDatabase } from './db/prepare';
import { controllerMigrationsDir, knowledgeVersionsDir, schemaState } from './db/version';
import { buildChecks } from './diagnostics/checks';
import { clientErrorRoutes } from './diagnostics/client-errors';
import { diagnosticRoutes, PgDiagnosticStore } from './diagnostics/routes';
import { DiagnosticRunner } from './diagnostics/runner';
import { ClaudeCodeEngine, Engines, GatewayEngine, scopeFromDb } from './engines';
import { claudeHooks } from './engines/claude';
import { gatewayContextHook } from './engines/gateway';
import { ClaudeMemoryMirror } from './engines/memory';
import { ClaudeCodeModelClient, syncClaudeCodeModels } from './engines/mode-a';
import { engineRoutes } from './engines/routes';
import { isLocalModel } from './engines/select';
import { PgEngineStore } from './engines/store';
import { loadEnv } from './env';
import { PgEventBus } from './events/bus';
import { preflightJudge } from './factcheck/allow';
import { factcheckHandler, startFactcheck } from './factcheck/handler';
import { trustRoutes } from './factcheck/routes';
import { checkSelection } from './factcheck/selection';
import { canonicalFamily, familyFromModelId, JudgeSlots } from './factcheck/steps';
import { PgFactcheckStore } from './factcheck/store';
import { searxngSearch, webPolicy } from './factcheck/web';
import { nativeProbe as filesProbe, rootSource } from './files/roots';
import { fileRoutes } from './files/routes';
import { FileService } from './files/service';
import { flowRoutes, memoryText } from './flows/routes';
import { PgFlowStore } from './flows/store';
import { flowTryHandler } from './flows/try';
import { FlowsService } from './flows/turn';
import { paidFromCredit } from './gateway/billing';
import { CreditLedger, PgCreditSpend } from './gateway/credit';
import { creditRoutes } from './gateway/credit-routes';
import { installLiveGuard, installSendGuard, liveStatus } from './gateway/e2e-guard';
import { FakeProvider } from './gateway/fake';
import { Gateway } from './gateway/gateway';
import { AiSdkClient, DEFAULT_SECRET, languageModelFor } from './gateway/providers';
import { ModelRegistry, RoutingClient } from './gateway/registry';
import { coreProbes } from './health/probes';
import { restartAdapterFor } from './health/restart';
import { healthRoutes, recordHealth, systemHealthOf } from './health/routes';
import { DEFAULT_SUPERVISOR, startSupervisor } from './health/supervisor';
import { cockpitOrigins } from './http/guard';
import { imageRoutes } from './images/routes';
import { ImageService } from './images/service';
import { ImageStore, PgImageRows } from './images/store';
import { imageTool } from './images/tool';
import { attachedFiles } from './interpreter/attached';
import { interpreterRoutes } from './interpreter/routes';
import { PyodideRuntime } from './interpreter/runtime';
import { InterpreterService, PgFigureStore } from './interpreter/service';
import { pythonTool } from './interpreter/tool';
import { knowledgeClient } from './knowledge/client';
import { PgTombstoneStore, sourceIntegrity } from './knowledge/integrity';
import { HttpEngine } from './lab/engine-client';
import { LAB_PRINCIPAL, LabMirror } from './lab/event-mirror';
import { labHandler } from './lab/handler';
import { LabPasses } from './lab/hosted';
import { LabMcpEndpoint } from './lab/mcp-server';
import { labRoutes } from './lab/routes';
import { LicenceClock } from './license/clock';
import { licenseRoutes } from './license/routes';
import { hasFeature, OFFICIAL_LICENSE_KEYS, parseKeyMap } from './license/verify';
import { linkRoutes } from './links/routes';
import { LinkService, type LinkServiceDeps } from './links/service';
import { PgLinkStore } from './links/store';
import { threadSummary } from './links/summary';
import { LoadedModels } from './localmodels/loaded';
import { OllamaClient } from './localmodels/ollama';
import { localModelRoutes } from './localmodels/routes';
import { LocalModels } from './localmodels/service';
import { logIngestRoutes, logRoutes } from './logs/routes';
import { watchClaudeCodeMcp } from './mcp/claude-code-watch';
import { mcpClientRoutes } from './mcp/clients';
import { McpToolGuard, PgMcpApprovalStore } from './mcp/guard';
import { McpManager } from './mcp/manager';
import { McpPresets } from './mcp/presets';
import { toolRoutes } from './mcp/routes';
import { mcpEndpoint, PgMcpClientStore } from './mcp/server';
import { McpService } from './mcp/service';
import { PgMcpServerStore } from './mcp/store';
import { MemoryIndex, PgMemoryIndexSink } from './memory/index';
import { utilityFrom } from './memory/llm';
import { PgProposalStore } from './memory/proposals';
import { GitMemoryProvider } from './memory/repo';
import { memoryRoutes } from './memory/routes';
import { DEFAULT_MEMORY_CONFIG, MemoryService } from './memory/service';
import { MemoryTransfer } from './memory/transfer';
import { modelWatchRoutes } from './models/watch/routes';
import { ModelWatch } from './models/watch/service';
import { PgWatchStore } from './models/watch/store';
import { gatewayTestCall } from './models/watch/testcall';
import { NotebookMergeService } from './notebooks/merge';
import { PgMergeStore } from './notebooks/merge-store';
import { PgNotebookRepo } from './notebooks/repo';
import { notebookRoutes } from './notebooks/routes';
import { notificationRoutes, PgNotificationStore, startNotificationSink } from './notifications/routes';
import { log, logFor, setLogTap } from './obs/logger';
import { traceRoutes } from './obs/routes';
import { setSpanSink, startSpan } from './obs/spans';
import { ObsPipeline, PgObsStore, toNewLog } from './obs/store';
import { startTracing, stopTracing } from './obs/tracing';
import { fromInfo } from './openrouter/advisor';
import { EndpointsCache } from './openrouter/endpoints';
import { openRouterRoutes } from './openrouter/routes';
import { OpenRouterService } from './openrouter/service';
import { AutoReview, PgPlanStore } from './permissions/auto';
import { ReviewerCheck } from './permissions/auto/check';
import { autoRoutes } from './permissions/auto/routes';
import { coreReviewers } from './permissions/auto/wire';
import { loadCedarEvaluator } from './permissions/cedar';
import type { PolicyEvaluator } from './permissions/decide';
import { createGate } from './permissions/gate';
import { reconcileApprovals, withdrawApprovals } from './permissions/reconcile';
import { permissionRoutes } from './permissions/routes';
import { PgPermissionStore } from './permissions/store';
import { PrivacyPolicies } from './privacy/policy';
import { privacyRoutes } from './privacy/routes';
import { loadPro } from './pro';
import { proAnswers } from './pro/answers';
import { proDataRoutes } from './pro/data';
import { proExportSource } from './pro/exportsource';
import { proPackHost } from './pro/packs';
import { lockedProRoutes, ownerIdentity, proRoutes } from './pro/routes';
import { proServices } from './pro/services';
import { sqlSyncSource } from './pro/sync-source';
import type { ProHooks } from './pro/types';
import { GhCliClient, GitHubAccessor, GitHubRestClient, savedToken } from './repos/github';
import { repoRoutes } from './repos/routes';
import { RepoService } from './repos/service';
import { repoTools } from './repos/tools';
import { PgRunEventLog } from './runs/events';
import { PgRunStore } from './runs/store';
import { RunWorker } from './runs/worker';
import { PgScopeStore, scopeResolver } from './scopes';
import { classifier, PgSharedHistoryStore, SharedHistory } from './scopes/history';
import { scopeRoutes } from './scopes/routes';
import { EnvFirstSecretStore, importEnvKeys, PgSecretStore, SecretBox } from './secrets';
import { PgSettings, SETTING } from './settings';
import { liveTester, setupRoutes } from './setup/routes';
import { PgStateStore, stateRoutes } from './state/routes';
import { bootRestore } from './system/bootRestore';
import { DesktopHost, desktopInternalRoutes, desktopRoutes } from './system/desktop';
import { sourceDiskGuard } from './system/disk';
import { mustApply, readStaged } from './system/stagedRestore';
import { startupInternalRoutes, startupRoutes, stoppedApp } from './system/startup';
import { themeRoutes } from './system/theme';
import { type TidyDeps, tidyRoutes, tidyStorage } from './system/tidy';
import { UpdateOfferBox, updateInternalRoutes, updateRoutes } from './system/updates';
import { WakeWatch } from './system/wake';
import { flowShape, observeApi, observeRunEvents, serverEnv, usageOf } from './telemetry/collect';
import { telemetryRoutes } from './telemetry/routes';
import { Telemetry } from './telemetry/service';
import { PgTelemetryStore } from './telemetry/store';
import { PgBranchStore } from './threads/branches';
import { branchRoutes } from './threads/branchRoutes';
import { scheduleTrashPurge } from './threads/bulk';
import { PgThreadRepo } from './threads/repo';
import { threadRoutes } from './threads/routes';
import { PgSendLocks } from './threads/send-lock';
import { branchSuggester } from './threads/suggest';
import { fsTools, Workspace } from './tools/builtin/fs';
import { overrideFor, ToolRegistry } from './tools/registry';
import { PgUsageSource, spendUsd, usageHistory } from './usage/report';
import { usageRoutes } from './usage/routes';

const supervisorLog = logFor('supervisor');

// The desktop app says which NVX Ancile this is; otherwise the version Core was built as (build.ts).
const VERSION = appVersion();

/** Reasons Core stops before opening the database, and shows its start-up screen instead. */
const STOPS = new Set([
  'system.database_newer',
  'system.backup_failed',
  'system.disk_full',
  'system.migration_failed',
]);
/** `--preflight` (the desktop app, before Knowledge migrates): exit codes. */
const PREFLIGHT_NEWER = 3;
const PREFLIGHT_FAILED = 4;

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
  /** Pro's part in answering (set once Pro has loaded; absent in the free build). */
  let proHooks: ProHooks | undefined;
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
  // Never backwards, never without a backup, never onto a full disk (db/prepare.ts).
  const preflight = process.argv.includes('--preflight');
  const dataDir = resolve(env.ANCILE_DATA_DIR);
  const knowledgeDir = knowledgeVersionsDir(env.ANCILE_KNOWLEDGE_MIGRATIONS_DIR);
  const controllerDir = controllerMigrationsDir(env.ANCILE_CONTROLLER_MIGRATIONS_DIR);
  // A restore chosen in setup is applied first, before the database is opened for anything else (SU1).
  if (!preflight && mustApply(await readStaged(dataDir))) {
    const seen = await schemaState(database.sql, { knowledgeDir }).catch(() => null);
    await bootRestore({
      sql: database.sql,
      url: env.DATABASE_URL,
      dataDir,
      version: VERSION,
      schema: () => ({ expected: seen?.expected ?? '', current: seen?.current ?? null }),
      allowedOrigins: cockpitOrigins(env.ANCILE_PUBLIC_URL, env.ANCILE_ALLOWED_ORIGINS),
      managed: env.ANCILE_RUNTIME === 'desktop',
      ...(env.NODE_ENV === 'production' &&
        existsSync(resolve(env.ANCILE_COCKPIT_DIST ?? '../../apps/cockpit/dist')) && {
          cockpitDist: resolve(env.ANCILE_COCKPIT_DIST ?? '../../apps/cockpit/dist'),
        }),
      listen: (fetch) =>
        serve({ fetch, hostname: env.ANCILE_HOST, port: env.ANCILE_PORT }, () =>
          log.warn({}, 'applying a restore chosen in setup: showing its progress'),
        ),
    });
    return;
  }
  let prepared: Prepared;
  try {
    prepared = await prepareDatabase({
      sql: database.sql,
      url: env.DATABASE_URL,
      dataDir,
      appVersion: VERSION,
      knowledgeDir,
      controllerDir,
      preflight,
      allowNewer: !RELEASE_BUILD && env.ANCILE_ALLOW_NEWER_DATABASE,
    });
  } catch (err) {
    if (!(err instanceof AncileError) || !STOPS.has(err.code)) throw err;
    log.error({ code: err.code, detail: err.detail }, err.title);
    if (preflight) {
      await database.close();
      process.exit(err.code === 'system.database_newer' ? PREFLIGHT_NEWER : PREFLIGHT_FAILED);
    }
    const cockpit = resolve(env.ANCILE_COCKPIT_DIST ?? '../../apps/cockpit/dist');
    const seen = await schemaState(database.sql, { knowledgeDir }).catch(() => null);
    const stopped = stoppedApp({
      error: err,
      sql: database.sql,
      url: env.DATABASE_URL,
      dataDir,
      version: VERSION,
      schema: () => ({ expected: seen?.expected ?? '', current: seen?.current ?? null }),
      allowedOrigins: cockpitOrigins(env.ANCILE_PUBLIC_URL, env.ANCILE_ALLOWED_ORIGINS),
      managed: env.ANCILE_RUNTIME === 'desktop',
      ...(env.NODE_ENV === 'production' && existsSync(cockpit) && { cockpitDist: cockpit }),
    });
    serve({ fetch: stopped.fetch, hostname: env.ANCILE_HOST, port: env.ANCILE_PORT }, () =>
      log.warn({ code: err.code }, 'Core stopped before opening the database: showing the start-up screen'),
    );
    return;
  }
  if (preflight) {
    log.info(
      { backup: prepared.backup?.name ?? null, skipped: prepared.skipped },
      'preflight: the database is ready to update',
    );
    await database.close();
    process.exit(0);
  }
  if (prepared.applied.length) log.info({ applied: prepared.applied }, 'database migrated');
  const schemaNow = () => ({ expected: prepared.state.expected, current: prepared.state.expected });

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
  // The built-in automations' switches and settings, read by the features they serve.
  const automationStore = new PgAutomationStore(sql);
  const builtinSettings = new BuiltinSettings(config.automations?.jobs ?? {}, automationStore);
  await builtinSettings
    .refresh()
    .catch((err: unknown) => log.warn({ err }, 'automation settings not read; using the defaults'));
  const savedSecrets = new PgSecretStore(sql, new SecretBox(env.ANCILE_SECRET_KEY));
  const imported = await importEnvKeys(savedSecrets, process.env);
  // A key set in the environment wins over the saved one (Settings → API keys shows it read-only).
  const secrets = new EnvFirstSecretStore(savedSecrets, process.env, ENV_FOR_SECRET);
  if (imported.length) log.info({ secrets: imported }, 'stored provider keys from the environment');

  // Models: config, plus the offline test model when asked for.
  const registry = new ModelRegistry({
    models: config.models?.models ?? [],
    taskClasses: config.routing?.task_classes ?? {},
    secrets,
    settings,
    offline: env.ANCILE_OFFLINE_MODELS,
    // An Ollama model Ollama has not pulled is never offered or chosen (it could not answer).
    ollamaTags: async () => {
      const ollama = new OllamaClient({ baseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434' });
      const tags = await Promise.race([
        ollama.tags(),
        new Promise<never>((_, no) => setTimeout(() => no(new Error('slow')), 1_500).unref()),
      ]);
      return tags.map((t) => t.name).filter(Boolean);
    },
    // The chat models Ollama has are listed by themselves: what each can do (tools, vision, its window).
    ollamaFacts: (name) =>
      Promise.race([
        new OllamaClient({ baseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434' }).facts(name),
        new Promise<null>((ok) => setTimeout(() => ok(null), 1_500).unref()),
      ]),
  });
  await registry.refresh();
  // CR1: the plan's monthly API credit. Models paid from it follow the ledger (registry.setCredit).
  const creditLedger = new CreditLedger({
    settings,
    spend: new PgCreditSpend(sql, owner.workspaceId),
    onState: (s) => registry.setCredit(s),
    notify: (n) =>
      events.publish({
        type: 'notification',
        id: n.id,
        level: n.level,
        title: n.title,
        body: n.body,
        action: { label: 'Open usage', href: '/settings/usage' },
        category: 'health',
      }),
  });
  await creditLedger.load().catch((err: unknown) => log.warn({ err }, 'the monthly credit was not read'));
  await registry.refresh();
  // Late in a cycle the goal can switch on by itself, and 80% can be passed: look every few minutes.
  setInterval(
    () =>
      void creditLedger
        .check()
        .then(() => creditLedger.refreshGoal())
        .catch(() => undefined),
    5 * 60_000,
  ).unref();
  events.subscribe(Number.MAX_SAFE_INTEGER, (e) => {
    if (e.type === 'run.updated' && e.status === 'succeeded' && creditLedger.enabled)
      void creditLedger.check().catch(() => undefined);
  });
  // The first raw usage each provider sends is logged (numbers only), so what it
  // really reports for cache hits and writes can be checked against our counts.
  const usageSeen = new Set<string>();
  const endpoints = {
    controllerUrl: env.CONTROLLER_URL,
    controllerToken: env.CONTROLLER_TOKEN,
    ollamaUrl: env.OLLAMA_BASE_URL,
    onRawUsage: (provider: string, usage: Record<string, number>) => {
      if (usageSeen.has(provider)) return;
      usageSeen.add(provider);
      log.info({ provider, usage }, 'first raw usage from this provider');
    },
  };
  // ---- Phase 5: remote compute (the Controller) ----
  const compute = controllerClient({ url: env.CONTROLLER_URL, token: env.CONTROLLER_TOKEN });
  // A saved RunPod key goes back to the Controller whenever it has none: it
  // holds the key only in memory, so every restart of it (every launch of the
  // desktop app) starts keyless. At start, when its events reconnect, and each minute.
  const syncProvider = providerSync(compute, secrets);
  const stopCompute = startComputeBridge({
    client: compute,
    registry,
    bus: events,
    onConnect: () => void syncProvider(),
  });
  void syncProvider();
  setInterval(() => void syncProvider(), 60_000).unref();
  // ---- end Phase 5 ----
  // Engines (docs/engines.md): Claude Code as a model registers its own client here once it is built.
  // Images (docs/images.md): kept by content in the data folder; vision models read them by id.
  const imageStore = new ImageStore(resolve(env.ANCILE_DATA_DIR, 'images'), new PgImageRows(sql));
  // OpenRouter (docs/openrouter.md): endpoint lists, routing presets, served provider, cost.
  const usageSource = new PgUsageSource(sql);
  const openRouter = new OpenRouterService({
    settings,
    endpoints: new EndpointsCache({ settings, config: () => config.openrouter }),
    config: () => config.openrouter,
    models: (id) => registry.get(id),
    usageHistory: () => usageHistory(usageSource, owner.workspaceId, Date.now()),
    planUsed: async () => {
      const p = await planLimits.get({ refresh: false });
      const used = p.windows.map((w) => w.percent).filter((n): n is number => n !== null);
      return { known: p.available === true, percent: used.length ? Math.max(...used) : null };
    },
  });
  const sdkClient = new AiSdkClient(
    secrets,
    endpoints,
    async (id) => {
      const got = await imageStore.get(id);
      return got ? { bytes: got.bytes, mime: got.record.mime } : null;
    },
    (m, req) => openRouter.forCall(m, req),
  );
  // CR1: a key marked as drawing on the plan's credit reads "out of credit" as the credit being spent.
  sdkClient.planCredit = (m) => paidFromCredit(m, creditLedger.enabled);
  sdkClient.onCreditExhausted = () => void creditLedger.markExhausted().catch(() => undefined);
  const routingClient = new RoutingClient(sdkClient, new FakeProvider({ wordDelayMs: 25 }));
  const gateway = new Gateway({
    client: routingClient,
    breaker: new CircuitBreaker(),
    // A cold node says how long it needs; wait that long plus two minutes.
    computeEtaMarginMs: 120_000,
  });
  // The daily model watch (MD4, MD5): live model lists, prices, and "follow latest" lines.
  const modelWatch = new ModelWatch({
    registry,
    store: new PgWatchStore(sql),
    settings,
    secrets,
    testCall: gatewayTestCall(gateway),
    publish: (e) => events.publish(e),
    bundledPricesDate: config.models?.prices_as_of ?? null,
  });
  const chatReady = registry
    .info()
    .filter(
      (m) =>
        !m.alias_of &&
        m.status === 'ready' &&
        !m.capabilities.includes('embeddings') &&
        !m.capabilities.includes('rerank'),
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
  const permissions = new PgPermissionStore(sql);
  // The rug-pull guard (docs/plugins.md): each MCP server's approved tool list.
  // Auto mode's verdict cache is filled in below, once it exists.
  let forgetVerdicts: (prefix: string) => void = () => undefined;
  const mcpGuard = new McpToolGuard({
    store: new PgMcpApprovalStore(sql),
    grants: permissions,
    forgetVerdicts: (prefix) => forgetVerdicts(prefix),
    bus: events,
  });
  const mcp = new McpManager(tools, { secrets, version: VERSION, events, guard: mcpGuard });
  // Servers from config/mcp.yaml (read-only in the app) and ones added in
  // Admin → Plugins (core.mcp_servers); a name in the file wins.
  const mcpServers = new McpService({
    store: new PgMcpServerStore(sql),
    secrets,
    settings,
    manager: mcp,
    files: config.mcp?.servers ?? [],
    guard: mcpGuard,
  });
  // In the background: a slow or broken MCP server never delays boot.
  void mcpServers.start().catch((err) => log.error({ err }, 'MCP start failed'));
  // Repositories (DESIGN §17): git folders, their state, and gated git and GitHub tools.
  const repos = new RepoService({ settings, bus: events });
  await repos.load();
  repos.start();
  const github = new GitHubAccessor(new GhCliClient(), new GitHubRestClient(savedToken(secrets)));
  for (const t of repoTools(repos, github)) tools.register(t, overrideFor(config.tools?.tools, t.action));
  let policy = await loadCedarEvaluator({
    files: config.policies,
    preset: (await settings.get<string>(SETTING.preset)) ?? config.tools?.preset ?? 'balanced',
  });
  // Scopes (docs/scopes.md) are floors in every preset; Auto mode (docs/auto-mode.md) is the `auto` preset.
  const scopeStore = new PgScopeStore(sql);
  const scopes = scopeResolver(scopeStore);
  // What private notebooks may use beyond the floor (docs/privacy.md); every feature asks this one object.
  const privacy = new PrivacyPolicies({ settings, isPrivate: (id) => scopeStore.isPrivate(id) });
  const autoPlans = new PgPlanStore(sql);
  let presetNow = (await settings.get<string>(SETTING.preset)) ?? config.tools?.preset ?? 'balanced';
  const gateAuto = {
    review: new AutoReview({
      reviewers: coreReviewers({ secrets, gateway, registry }),
      plans: autoPlans,
      emit: (runId, event) => runEvents.append(runId, event),
      // Reviewer offline: once per outage, quietly (no toast); the Cockpit shows one line.
      onReviewerStatus: (st) =>
        void events
          .publish({
            type: 'auto.reviewer',
            status: st.status === 'offline' ? 'offline' : 'online',
            outage_id: st.outage_id,
            reason: st.reason,
            local_only: st.local_only,
          })
          .catch(() => undefined),
    }),
    enabled: () => presetNow === 'auto',
  };
  forgetVerdicts = (prefix) => void gateAuto.review.forget(prefix);
  const applyPreset = async (preset: string) => {
    presetNow = preset;
    policy = await loadCedarEvaluator({ files: config.policies, preset });
    log.info({ preset }, 'permission preset changed');
  };
  const policyRef: PolicyEvaluator = {
    forbids: (r) => policy.forbids(r),
    escalation: (r) => policy.escalation(r),
    relax: (r) => policy.relax?.(r) ?? null,
  };
  const gate = createGate({
    policy: policyRef,
    store: permissions,
    workspaceRoot: workspace.root,
    fs: workspace.probe(),
    scopes,
    auto: gateAuto,
    mcpTools: mcpGuard,
  });

  // Durable runs.
  const runStore = new PgRunStore(sql);
  // One sender per thread across windows (threads/send-lock.ts).
  const sendLocks = new PgSendLocks(sql);
  // One repository in two folders: folder notebooks that are one repository (claudecode/same-repo.ts).
  const sameRepo = new SameRepoFinder({
    projects: () => claudeCodeStore.projects(owner.workspaceId),
    notebook: async (id) => {
      const n = await notebooks.get(id);
      return n && n.workspace_id === owner.workspaceId && !n.archived_at ? { title: n.title } : null;
    },
    pairs: new PgRepoPairStore(sql),
    // Notebook merge (notebooks/merge.ts) is wired below, so a pair can be merged.
    canMerge: true,
  });
  // Anonymous usage statistics (docs/telemetry.md): off until you say yes.
  let tierNow: () => 'free' | 'pro' | 'max_access' = () => 'free';
  const telemetry = new Telemetry({
    store: new PgTelemetryStore(sql),
    settings,
    version: VERSION,
    channel: env.NODE_ENV === 'production' && !VERSION.includes('-') ? 'release' : 'dev',
    endpoint: telemetryEndpoint(env.NVX_TELEMETRY_URL),
    tier: () => tierNow(),
    env: serverEnv,
  });
  const runEvents = observeRunEvents(new PgRunEventLog(sql), telemetry);
  const threads = new PgThreadRepo(sql);
  const branchStore = new PgBranchStore(sql);
  const notebooks = new PgNotebookRepo(sql);
  // Works with Claude Code (docs/claude-code.md): the person's own CLI, read
  // through the Claude bridge (a separate MIT program holding Anthropic's SDK).
  const claudeCodeStore = new PgClaudeCodeStore(sql);
  // The test profile (ANCILE_PROFILE=e2e) never reaches a real model, and ANCILE_CLAUDE_CODE=off switches
  // the whole Claude Code module off: no bridge, no detection, no import, no models (e2e-guard.ts).
  installSendGuard(env.ANCILE_PROFILE);
  // A live test run (`pnpm test:live`) lists the only models Core may call and the most it may spend (LT1).
  if (installLiveGuard(env.ANCILE_LIVE_ALLOW, env.ANCILE_LIVE_CAP_USD)) {
    const g = liveStatus();
    log.warn(
      { allow: g?.allow, cap_usd: g?.cap_usd },
      'Live test guard is on: only the listed models can be called',
    );
  }
  const claudeOff: string | null =
    env.ANCILE_PROFILE === 'e2e'
      ? 'Off in the test profile'
      : env.ANCILE_CLAUDE_CODE === 'off'
        ? 'Switched off (ANCILE_CLAUDE_CODE=off)'
        : null;
  const claudeCode = createClaudeCode({
    off: claudeOff,
    workspaceId: owner.workspaceId,
    dataDir: resolve(env.ANCILE_DATA_DIR),
    logLevel: env.ANCILE_LOG_LEVEL,
    settings,
    bus: events,
    threads,
    notebooks,
    store: claudeCodeStore,
  });
  // Claude Code's own MCP servers get the same rug-pull guard as NVX Ancile's (docs/plugins.md).
  watchClaudeCodeMcp(claudeCode.bridge, mcpGuard);
  const kn = knowledgeClient({ baseUrl: env.KNOWLEDGE_URL, serviceToken: env.ANCILE_SERVICE_TOKEN });
  // The code interpreter (docs/interpreter.md): python_run runs in a Cockpit window's sandbox.
  const pyodide = new PyodideRuntime({ dataDir: resolve(env.ANCILE_DATA_DIR) });
  const interpreterFigures = new PgFigureStore(sql);
  const interpreter = new InterpreterService({
    figures: interpreterFigures,
    publish: (e) => events.publish(e),
  });
  tools.register(
    pythonTool(interpreter, attachedFiles({ threads, kn, scopes })),
    overrideFor(config.tools?.tools, 'code.run'),
  );
  // image_generate (docs/images.md): a provider from config/images.yaml, behind the permission gate.
  const images = new ImageService({
    store: imageStore,
    config: () => config.images,
    secrets,
    scopes,
    threads,
    onImage: (source, kind) => {
      telemetry.feature(`image_${source}`);
      if (kind) telemetry.feature(`image_provider_${kind}`);
    },
  });
  await images.providers().catch(() => undefined);
  tools.register(imageTool(images), overrideFor(config.tools?.tools, 'image.generate'));
  setInterval(() => void imageStore.sweep().catch(() => undefined), 60 * 60_000).unref();
  // Passages per turn and per source (config/retrieval.yaml), and what became of cited sources (track G).
  const retrievalLimits = {
    k: config.retrieval?.k ?? DEFAULT_LIMITS.k,
    perSource: config.retrieval?.per_source_max ?? DEFAULT_LIMITS.perSource,
  };
  const tombstones = new PgTombstoneStore(sql);
  const integrity = sourceIntegrity({ workspaceId: owner.workspaceId, tombstones, kn });

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
  const memoryIndex = new MemoryIndex(memoryProvider, new PgMemoryIndexSink(sql));
  const memoryProposals = new PgProposalStore(sql);
  const memory = new MemoryService({
    provider: memoryProvider,
    index: memoryIndex,
    proposals: memoryProposals,
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
  // One-click local models (docs/models.md): Ollama's pull, or fastembed via Knowledge.
  const localModels = new LocalModels({
    catalogue: config.localModels?.models ?? [],
    ollamaUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    registry,
    kn,
  });
  // SU1: chats brought in from ChatGPT, Claude or Open WebUI; unfinished imports carry on after a restart.
  const chatImports = new ChatImportService({
    store: new PgChatImportStore(sql),
    threads,
    workspaceId: owner.workspaceId,
    dir: join(dataDir, 'imports'),
  });
  void chatImports.resume().catch((err: unknown) => log.warn({ err }, 'chat imports did not resume'));
  // LM1: which Ollama models are in memory, with Unload, Keep loaded and warm-on-pick.
  const loadedModels = new LoadedModels({
    ollama: new OllamaClient({ baseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434' }),
    registry,
    probe: { totalmem: () => osTotalmem() },
  });
  // Export and import (docs/memory.md): imports only ever propose.
  const memoryTransfer = new MemoryTransfer({
    service: memory,
    provider: memoryProvider,
    index: memoryIndex,
    proposals: memoryProposals,
    user: { name: ownerName, email: `${owner.userId}@ancile.local` },
    notebooks: async () =>
      Promise.all(
        (await notebooks.list(owner.workspaceId)).map(async (n) => ({
          id: n.id,
          slug: n.slug,
          title: n.title,
          private: await scopeStore.isPrivate(n.id),
        })),
      ),
    memoryWritable: async (id) => (await scopes.effective({ notebookId: id })).scope.memory_write,
  });
  // The lab lane: optional, it needs Bun. Core is its only way to a model.
  const engine =
    env.AGENT_ENGINE_URL && env.AGENT_ENGINE_TOKEN
      ? new HttpEngine(env.AGENT_ENGINE_URL, env.AGENT_ENGINE_TOKEN)
      : null;
  const labPasses = new LabPasses();
  const mirror = engine
    ? new LabMirror({
        engine,
        events: runEvents,
        gate,
        permissions,
        bus: events,
        userId: owner.userId,
        approvalTtlMs: env.ANCILE_APPROVAL_TTL_S * 1000,
        tools,
        passes: labPasses,
      })
    : null;
  mirror?.start();
  // The hosted MCP tools, offered to the lab as one server behind its gateway token.
  const labMcp =
    engine && env.AGENT_GATEWAY_TOKEN
      ? new LabMcpEndpoint({
          registry: tools,
          gate,
          passes: labPasses,
          token: env.AGENT_GATEWAY_TOKEN,
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          version: VERSION,
        })
      : null;
  const labSnapshots = resolve(env.ANCILE_DATA_DIR, 'lab-snapshots');
  // Live Claude Code sessions (docs/claude-code.md): turns run in the person's own
  // Claude Code through the bridge; Ancile's MCP server gives them the notebook's sources.
  const claudePasses = new LabPasses();
  const claudeSecret = randomBytes(32).toString('base64url');
  // ---- Phase 3 (C): context links and notebook merge (docs/notebooks.md) ----
  /** Context packs attached to a thread or its notebook (Pro); set once Pro has loaded. */
  let proTurnContext: NonNullable<LinkServiceDeps['packs']> = async () => [];
  const summaryOf = threadSummary({ threads, branches: branchStore });
  const contextLinks = new LinkService({
    workspaceId: owner.workspaceId,
    store: new PgLinkStore(sql),
    scopes,
    lookup: {
      thread: async (id) => {
        const t = await threads.getThread(id);
        return t ? { title: t.title, notebook_id: t.notebook_id, workspace_id: t.workspace_id } : null;
      },
      notebook: async (id) => {
        const n = await notebooks.get(id);
        return n ? { title: n.title, workspace_id: n.workspace_id } : null;
      },
    },
    summaryOf,
    packs: (q) => proTurnContext(q),
  });
  const notebookMerge = new NotebookMergeService({
    workspaceId: owner.workspaceId,
    store: new PgMergeStore(sql),
    scopes: scopeStore,
    kn,
    memory: {
      read: async (path) => {
        try {
          const f = await memory.file(path);
          return { content: f.content, version: f.version };
        } catch {
          return null;
        }
      },
      save: async (path, content, base, message) => {
        const r = await memory.save(path, { content, base_sha: base, message });
        return { version: r.version };
      },
      revert: async (sha) => {
        await memory.revert(sha);
      },
    },
  });
  // ---- end Phase 3 (C) ----
  const ccHost = env.ANCILE_HOST === '0.0.0.0' || env.ANCILE_HOST === '::' ? '127.0.0.1' : env.ANCILE_HOST;
  /** A notebook's sources, id and title (the MCP server's list, and what a live session is told changed). */
  const notebookSources = async (id: string) =>
    (
      await kn.get<{ id: string; title: string }[]>(
        `/notebooks/${encodeURIComponent(id)}/sources?workspace_id=${encodeURIComponent(owner.workspaceId)}`,
      )
    ).map((s) => ({ id: s.id, title: s.title }));
  const claudeMcp = new ClaudeMcpEndpoint({
    secret: claudeSecret,
    registry: tools,
    gate,
    passes: claudePasses,
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    version: VERSION,
    thread: async (id) => {
      const t = await threads.getThread(id);
      if (!t || t.workspace_id !== owner.workspaceId) return null;
      const nb = t.notebook_id ? await notebooks.get(t.notebook_id) : undefined;
      return { notebookId: t.notebook_id, notebookTitle: nb?.title ?? null };
    },
    search: ({ notebookId, query, k, sourceIds }) =>
      kn.post('/search', {
        workspace_id: owner.workspaceId,
        notebook_id: notebookId,
        ...(sourceIds?.length && { source_ids: sourceIds }),
        query,
        k,
        mode: 'hybrid',
        rerank: true,
      }),
    notebookSources,
    sourceContent: (id) =>
      kn.get<{ markdown: string }>(
        `/sources/${encodeURIComponent(id)}/content?workspace_id=${encodeURIComponent(owner.workspaceId)}`,
      ),
    memorySearch: async (q, limit) => (await memory.search(q, limit)).items,
    passages: (threadId, hits) => claudeLive.passages(threadId, hits),
    traceOf: (threadId) => claudeLive.traceOf(threadId),
    sourceIdsOf: (threadId) => claudeLive.sourceIdsOf(threadId),
    limits: retrievalLimits,
    // Claude Code reads through a link only where its scope and the linked one allow Claude Code.
    linkedNotebooks: async (threadId) =>
      (await contextLinks.forTurn(threadId, { engine: 'claude_code', local: false })).notebooks,
  });
  // ---- Engines (docs/engines.md): one thread, any model ----
  const engineStore = new PgEngineStore(sql);
  /** Bridge handles Claude Code as a model drives (their events are not a live session's). */
  const modeAHandles = new Set<string>();
  // ---- end Engines ----
  const planLimits = new PlanLimits({
    settings,
    bridge: claudeCode.bridge,
    cli: () => claudeCode.service.cliPath(),
    env: () => claudeCode.service.cliEnv(),
    openHandle: () => claudeLive.openHandle(),
    samples: new PlanSamples(new PgPlanSampleStore(sql)),
    bus: events,
  });
  // Admin → Plugins: the MCP servers you have in Claude Code, read-only (claudecode/mcp-list.ts).
  const claudeMcpList = new ClaudeCodeMcpList({
    settings,
    bridge: claudeCode.bridge,
    cli: () => claudeCode.service.cliPath(),
    env: () => claudeCode.service.cliEnv(),
    folders: async () => (await claudeCode.service.projects()).map((p) => p.cwd),
    ignoreHandle: (h) => modeAHandles.has(h),
    bus: events,
  });
  claudeMcpList.watch();
  // Use, add and remove Claude Code's MCP servers, only through its own `claude mcp` command.
  const claudeMcpManage = new ClaudeCodeMcpManage({
    cli: claudeCode.cli,
    servers: mcpServers,
    settings,
    sourceOf: async (name) =>
      (await claudeMcpList.get()).servers.find((s) => s.name === name)?.source ?? null,
    changed: () => void claudeMcpList.get({ refresh: true }).catch(() => undefined),
  });
  const mcpPresets = new McpPresets(mcpServers);
  const claudeLive: ClaudeCodeLive = new ClaudeCodeLive({
    images,
    limits: planLimits,
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    bridge: claudeCode.bridge,
    service: claudeCode.service,
    sessionInfo: (id) => claudeCode.bridge.sessionInfo(id),
    threads,
    store: claudeCodeStore,
    runs: runStore,
    events: runEvents,
    worker: { kick: () => worker.kick() },
    bus: events,
    idleCloseMs: env.ANCILE_CC_LIVE_IDLE_MS,
    permissions,
    gateFor: (root) =>
      createGate({
        policy: policyRef,
        store: permissions,
        workspaceRoot: root,
        fs: nativeProbe(),
        scopes,
        auto: gateAuto,
        mcpTools: mcpGuard,
      }),
    tools,
    billing: (id) => registry.billingFor(id),
    creditKey: async () => (await secrets.get(DEFAULT_SECRET.anthropic ?? 'ANTHROPIC_API_KEY')) ?? null,
    onCreditExhausted: () => void creditLedger.markExhausted().catch(() => undefined),
    passes: claudePasses,
    mcp: {
      url: `http://${ccHost.includes(':') ? `[${ccHost}]` : ccHost}:${env.ANCILE_PORT}/mcp/claude`,
      secret: claudeSecret,
    },
    notebook: async (id) => {
      const nb = await notebooks.get(id);
      return nb && nb.workspace_id === owner.workspaceId
        ? { title: nb.title, grounded: !!nb.grounded }
        : null;
    },
    afterAnswer: async (a) => {
      await startFactcheck(
        { repo: threads, runs: runStore, store: factchecks, worker, familyOf, webFor },
        a.messageId,
        { workspaceId: a.workspaceId, notebookId: a.notebookId },
      );
    },
    approvalTtlMs: env.ANCILE_APPROVAL_TTL_S * 1000,
    folderExists: async (cwd) => existsSync(cwd),
    holders: claudeCode.holders,
    noFilesDir: claudeCode.noFilesDir,
    engines: claudeHooks({
      threads,
      branches: branchStore,
      store: engineStore,
      modelName: (id) => (id ? (registry.get(id)?.display_name ?? null) : null),
      memory: new ClaudeMemoryMirror({
        memory,
        notebook: async (id) => {
          const n = await notebooks.get(id);
          return n ? { id: n.id, slug: n.slug, title: n.title } : null;
        },
      }),
      allow: (thread, model) => engines.allowClaude(thread, model),
      scopeOf: (notebookId) => scopeFromDb(sql)({ id: '', notebook_id: notebookId }),
      sources: notebookSources,
    }),
    foreignHandle: (h) => modeAHandles.has(h),
    keepAlive: () => modeAHandles.size > 0,
  });
  // One writer at a time (CC6): messages sent while a thread answers, or while its
  // session is open in a terminal, wait here and go into the same session when free.
  const turnQueue = new TurnQueue({
    threads,
    workspaceId: owner.workspaceId,
    busy: (thread) => claudeLive.waitingFor(thread),
    send: (threadId, req) => claudeLive.send(threadId, req),
  });
  claudeLive.attachQueue(turnQueue);
  void turnQueue
    .start()
    .catch((err: unknown) => log.warn({ err: (err as Error).message }, 'the turn queue did not start'));
  /** An answered approval goes to whoever is waiting on it: the lab, or a live Claude Code turn. */
  const relayAnswer = async (
    a: Parameters<ClaudeCodeLive['resolved']>[0],
    status: 'approved' | 'denied' | 'expired',
    reason: string | null,
    updatedArgs?: unknown,
  ) => {
    if (await claudeLive.resolved(a, status, reason, updatedArgs)) return true;
    return mirror ? mirror.resolved(a, status, reason) : false;
  };
  const factchecks = new PgFactcheckStore(sql);
  // ---- Flows (Phase 5b): graphs that decide how a message is answered ----
  const flowStore = new PgFlowStore(sql, owner.workspaceId);
  // The Trash keeps deleted threads 30 days; a daily pass removes older ones, and never during a run.
  scheduleTrashPurge({
    repo: threads,
    runs: runStore,
    workspaceId: owner.workspaceId,
    afterPurge: async (id) => {
      await flowStore.orphan('thread', id);
      await imageStore.deleteThread(id);
    },
  });
  const flows = new FlowsService({
    store: flowStore,
    repo: threads,
    registry,
    gateway,
    promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
    retriever: knowledgeRetriever(kn, retrievalLimits),
    kn,
    memory: memoryText((q) => memory.pack(q)),
    monthSpendUsd: async () => {
      const now = new Date();
      // Billed model usage (not Claude Code: your Claude plan covers it), plus what GPU
      // nodes have cost this month (when the Controller answers).
      const models = await spendUsd(sql, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
      const gpu = await compute
        .get<{ total_to_date: number }>('/costs')
        .then((c) => Number(c.total_to_date) || 0)
        .catch(() => 0);
      return models + gpu;
    },
    // A rule's "node is awake": the Controller's own view of the node.
    nodeAwake: async (nodeId) =>
      compute
        .get<{ items: { id: string; observed_state: string }[] }>('/nodes')
        .then((r) => r.items.some((n) => n.id === nodeId && n.observed_state === 'running'))
        .catch(() => false),
  });
  // ---- end Flows ----
  // One name per family (Claude Code's `claude` is the Anthropic API's `anthropic`), so a judge is never the writer's family by another spelling (GR24).
  const familyOf = (id: string | null) =>
    id ? (canonicalFamily(registry.get(id)?.family) ?? familyFromModelId(id)) : null;
  // Every fact-check shares these: at most "fact-check judges at once" Claude Code sessions (Settings → Claude Code).
  const factcheckJudges = new JudgeSlots(async () => (await claudeCode.service.settings()).factcheck_judges);
  // Fact-checks on the web (FC4): the notebook's setting, this check's allow, and the scope's keep-local rules.
  const factcheckWeb = env.SEARXNG_URL ? searxngSearch({ baseUrl: env.SEARXNG_URL }) : null;
  const webFor: NonNullable<Parameters<typeof startFactcheck>[0]['webFor']> = async (a) =>
    webPolicy({
      scope: await scopes.effective({ threadId: a.threadId }).catch(() => null),
      notebookWeb:
        config.factcheck?.web_search === true ||
        (a.notebookId ? ((await notebooks.get(a.notebookId))?.check_on_web ?? false) : false),
      requested: a.requested,
      configured: !!factcheckWeb,
    });
  // Engines (docs/engines.md): a turn in any thread with any model, its scope checked first.
  // CH6 (Pro): a token estimate on each chip; read at each attachment, so a lapse stops it at once.
  const attachments = new AttachmentService({
    knowledge: kn,
    estimate: (f) =>
      proHooks?.attachmentTokens && hasProFeature('attachment_pages')
        ? proHooks.attachmentTokens(f)
        : undefined,
  });
  // CH7 (Pro): notes added while a model works reach it at the next step. Pro's route offers them.
  const steerBus = new SteerBus();
  const engines: Engines = new Engines({
    images,
    attachments,
    // CH6 (Pro): only the relevant pages when the message is over the model's budget.
    trimAttachments: (q) =>
      proHooks?.trimAttachments && hasProFeature('attachment_pages')
        ? proHooks.trimAttachments(q)
        : Promise.resolve(null),
    registry,
    gateway: new GatewayEngine({
      repo: threads,
      runs: runStore,
      worker: { kick: () => worker.kick() },
      registry,
      branches: branchStore,
    }),
    claudeCode: new ClaudeCodeEngine({
      live: () => claudeLive,
      installed: async () => {
        const st = await claudeCode.service.status();
        if (st.off_reason) return { available: false, reason: st.off_reason };
        if (!st.installed)
          return { available: false, reason: 'Claude Code is not installed on this computer' };
        if (st.verification.state === 'failed')
          return { available: false, reason: 'This Claude Code install could not be verified' };
        return { available: true, reason: null };
      },
    }),
    scopeOf: scopeFromDb(sql),
  });

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
        onResolved: (a, status, reason) => relayAnswer(a, status, reason),
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
        automationApprovalTtlMs: env.ANCILE_APPROVAL_TTL_AUTOMATION_S * 1000,
        retriever: knowledgeRetriever(kn, retrievalLimits),
        retrievalLimits,
        scopes,
        // Only a notebook in this workspace lends its title (an @-mentioned id is user input).
        notebookTitle: async (id) => {
          const nb = await notebooks.get(id);
          return nb && nb.workspace_id === owner.workspaceId ? nb.title : null;
        },
        hasRepos: () => repos.hasAny(),
        notebookSourceCount: async (id) => {
          const s = await kn.get<{ sources: number }>(`/notebooks/${encodeURIComponent(id)}/stats`);
          return typeof s.sources === 'number' ? s.sources : null;
        },
        branches: branchStore,
        flows,
        memory,
        engineContext: gatewayContextHook({ threads, store: engineStore }),
        links: contextLinks,
        // EN1 (Pro): a notebook's effort default, or auto effort. Read at each turn, so a lapse stops it.
        localModelFor: (q) =>
          proHooks?.localModelFor && hasProFeature('flow_lab')
            ? proHooks.localModelFor(q)
            : Promise.resolve(null),
        effortFor: (q) =>
          proHooks?.effortFor && hasProFeature('flow_lab') ? proHooks.effortFor(q) : Promise.resolve(null),
        switches: builtinSettings,
        steer: steerBus,
        epochs: new PgEpochStore(sql),
        endContext: async (family) =>
          endContextOn(
            await settings.get<EndContextSwitch>(SETTING.endContext).catch(() => undefined),
            family,
          ),
        // Grounded mode (DESIGN.md §10.7): every answer in the notebook is fact-checked.
        afterAnswer: async (a) => {
          // Pro (Flow lab): a shadow flow answers the same question off the record. Never awaited.
          if (proHooks?.afterAnswer)
            void proHooks
              .afterAnswer(a)
              .catch((err: unknown) => log.warn({ err }, 'a Pro after-answer step failed'));
          if (!a.notebookId || !(await notebooks.get(a.notebookId))?.grounded) return;
          await startFactcheck(
            { repo: threads, runs: runStore, store: factchecks, worker, familyOf, webFor },
            a.messageId,
            { workspaceId: a.workspaceId, notebookId: a.notebookId },
          );
        },
      }),
      flow_try: flowTryHandler(flows),
      claude_code: claudeLive.handler(),
      factcheck: factcheckHandler({
        gateway,
        registry,
        promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
        kn,
        // Each Claude Code judge is a session on your Claude plan: Settings → Claude Code caps them.
        judges: factcheckJudges,
        repo: threads,
        store: factchecks,
        config: config.factcheck ?? undefined,
        scopeOf: (ref) => scopes.effective(ref),
        web: factcheckWeb,
        gate,
        userId: owner.userId,
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
            // LB2: only a repository the owner registered and linked is theirs to take instructions from.
            projectRoot: async (threadId) => {
              const t = await threads.getThread(threadId);
              const linked = await repos.linkedFor({ threadId, notebookId: t?.notebook_id ?? null });
              return linked ? { root: await repos.root(linked.id), name: linked.name } : null;
            },
            formatOnEdit: async () => (await settings.get<boolean>(SETTING.labFormat)) === true,
            // LB3: the formatter is a command like any other, so the gate decides it, on the real command.
            allowFormat: async (line, who) =>
              (
                await gate.check({
                  userId: owner.userId,
                  principal: LAB_PRINCIPAL,
                  action: 'shell.exec',
                  resource: `shell:${line}`,
                  toolTier: 'gated',
                  destructive: false,
                  scope: { threadId: who.threadId, notebookId: null, workspaceId: who.workspaceId },
                  runId: who.runId,
                  traceId: who.traceId,
                })
              ).outcome === 'allow',
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
  const memoryRemote = process.env.ANCILE_MEMORY_REMOTE || config.memory?.remote?.url || undefined;
  // A remote saved in Settings → API keys, kept to hand for the "Not set up" check (read again each minute).
  let savedRemote: string | undefined;
  const readSavedRemote = async () => {
    savedRemote = (await secrets.get(MEMORY_REMOTE_SECRET).catch(() => undefined)) ?? undefined;
  };
  await readSavedRemote();
  setInterval(() => void readSavedRemote(), 60_000).unref();
  const retention = {
    logsDays: env.ANCILE_LOG_RETENTION_DAYS,
    spansDays: env.ANCILE_SPAN_RETENTION_DAYS,
    runEventsDays: env.ANCILE_RUN_EVENT_RETENTION_DAYS,
  };
  const notebookInWorkspace = async (id: string) =>
    (await notebooks.get(id))?.workspace_id === owner.workspaceId;
  const flowExists = async (id: string) => !!(await flowStore.get(id));
  let desktopHost: DesktopHost | null = null;
  // Tidy storage (MT1): Admin's button and the built-in automation share these.
  const tidyDeps: TidyDeps = {
    sql,
    dataDir,
    kn,
    // Queued or running. A run that waits for an approval or a GPU reads and writes nothing meanwhile.
    activeRuns: async () =>
      Number(
        (
          await sql<{ n: string }[]>`
            select count(*) as n from core.runs where status in ('queued', 'running')`
        )[0]?.n ?? 0,
      ),
    lastRunActivity: async () => {
      const [r] = await sql<{ t: Date | null }[]>`select max(updated_at) as t from core.runs`;
      return r?.t ? new Date(r.t) : null;
    },
    backup: () =>
      takeBackup({
        url: env.DATABASE_URL,
        sql,
        dataDir,
        reason: 'before-tidy',
        appVersion: VERSION,
        coreSchema: schemaNow().current,
        knowledgeRevision: null,
      }),
  };
  const automations = new AutomationRunner(
    config.automations?.jobs ?? {},
    scheduledJobs({
      sql,
      obs: obsStore,
      kn,
      memoryDir: resolve(env.ANCILE_DATA_DIR, 'memory'),
      // Read when the backup runs: the env or config value, else the one saved in Settings → API keys.
      memoryRemote: async () => memoryRemote ?? (await secrets.get(MEMORY_REMOTE_SECRET)),
      retention,
      tidy: (o) => tidyStorage(tidyDeps, o),
    }),
    automationStore,
    undefined,
    {
      // The window is hidden to the tray and Pro's background mode is off: your own schedules wait (DK1).
      hold: () => desktopHost?.holdsSchedules() ?? false,
      setup: jobSetup({ memoryRemote: () => memoryRemote ?? savedRemote }),
      options: builtinOptions(retention),
      // "Learn from corrections" is memory capture's own mode (Admin → Memory).
      linked: { memory_capture: memoryCaptureLink({ memory, settings }) },
      // A switch or a setting changed here reaches the features (and the knowledge service) at once.
      onChange: () => builtinSettings.refresh(),
      userHandlers: userJobs({
        turn: {
          repo: threads,
          runs: runStore,
          worker,
          registry,
          branches: branchStore,
          switches: builtinSettings,
        },
        workspaceId: owner.workspaceId,
        kn,
        bus: events,
        flowExists,
        notebookTitle: async (id) => {
          const nb = await notebooks.get(id);
          return nb && nb.workspace_id === owner.workspaceId ? nb.title : null;
        },
      }),
    },
  );
  await automations.start().catch((err: unknown) => log.error({ err }, 'automations did not start'));
  // Now every built-in has its row: read them, keep reading, and tell the knowledge service its own.
  await builtinSettings.refresh().catch((err: unknown) => log.warn({ err }, 'automation settings not read'));
  builtinSettings.start();
  const knowledgeSync = new KnowledgeSync(builtinSettings, kn);
  knowledgeSync.start();
  const mcpClients = new PgMcpClientStore(sql);
  const mcpServe = mcpEndpoint({
    clients: mcpClients,
    gate,
    permissions,
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    version: VERSION,
    search: async ({ query, notebookId, k }) => {
      const res = await kn.post<SearchResponse>('/search', {
        workspace_id: owner.workspaceId,
        ...(notebookId && { notebook_id: notebookId }),
        query,
        k: fetchK(k, retrievalLimits.perSource),
        mode: 'hybrid',
        rerank: true,
      });
      return { ...res, hits: capPerSource(res.hits, k, retrievalLimits.perSource) };
    },
    notebooks: async () =>
      (await notebooks.list(owner.workspaceId)).map((n) => ({
        id: n.id,
        title: n.title,
        description: n.description,
      })),
    memorySearch: async (q, limit) => (await memory.search(q, limit)).items,
  });
  // Open core (DESIGN.md §9): Pro from pro/ when this checkout has it, the free build otherwise.
  // A release build trusts only the keys built in, and its edition is what
  // was bundled: NVX_LICENSE_KEYS and NVX_TIER are for development and tests.
  if (RELEASE_BUILD && (env.NVX_LICENSE_KEYS || env.NVX_TIER))
    log.warn({}, 'NVX_LICENSE_KEYS and NVX_TIER are ignored in a release build');
  const licenceClock = new LicenceClock(settings);
  await licenceClock.load().catch((err: unknown) => log.warn({ err }, 'the licence clock could not be read'));
  const pro = await loadPro({
    tier: chosenTier(env.NVX_TIER),
    clock: licenceClock,
    host: {
      settings,
      secrets,
      keys: trustedKeys(
        OFFICIAL_LICENSE_KEYS,
        env.NVX_LICENSE_KEYS ? parseKeyMap(env.NVX_LICENSE_KEYS) : null,
      ),
      licenseUrl: env.NVX_LICENSE_URL,
      version: VERSION,
      // Where the Cockpit is opened, and the origins that may make changes (Teams' links).
      publicUrl: env.ANCILE_PUBLIC_URL,
      allowedOrigins: cockpitOrigins(env.ANCILE_PUBLIC_URL, env.ANCILE_ALLOWED_ORIGINS),
    },
  });
  const licence = pro.license;
  // The update the desktop host offers in its tray (Pro arrives and leaves by update).
  const updateOffer = new UpdateOfferBox(() => pro.build === 'pro');
  await licence.start().catch((err: unknown) => log.warn({ err }, 'the licence could not be read'));
  // Pro's features read the licence each time they run, so a lapse locks them at once.
  const hasProFeature = (f: Parameters<typeof hasFeature>[1]) => hasFeature(licence.status(), f);
  const proFeatures = pro.build === 'pro' ? pro : null;
  // Pro's notification buttons answer through Core's own approval route, bound once it exists.
  let decideApprovalOnce:
    | ((id: string, decision: 'approve' | 'deny', reason?: string) => Promise<string>)
    | null = null;
  if (proFeatures?.start)
    await proFeatures
      .start(
        proServices({
          sql,
          approvals: {
            get: async (id) => {
              const a = await permissions.getApproval(id);
              return a
                ? {
                    id: a.id,
                    status: a.status,
                    tier: a.tier,
                    tool: a.tool,
                    resource: a.resource,
                    thread_id: a.thread_id,
                  }
                : null;
            },
            decideOnce: async (id, decision, reason) => {
              if (!decideApprovalOnce) throw new Error('approvals are not ready yet');
              return { status: await decideApprovalOnce(id, decision, reason) };
            },
          },
          controller: compute,
          events,
          hasFeature: hasProFeature,
          owner: { userId: owner.userId, workspaceId: owner.workspaceId },
          sync: sqlSyncSource(sql, { userId: owner.userId, workspaceId: owner.workspaceId }),
          packs: proPackHost({
            workspaceId: owner.workspaceId,
            kn,
            scopes,
            threads,
            notebooks,
            engines: engineStore,
            summaryOf,
            memoryEntries: async (ids) =>
              ids.length
                ? [
                    ...(await sql<{ id: string; path: string; text: string }[]>`
                      select id, path, text from core.memory_entries where id = any(${ids})`),
                  ]
                : [],
          }),
          localModels: { loaded: () => loadedModels.view() },
          steer: steerBus,
          exports: proExportSource({
            workspaceId: owner.workspaceId,
            repo: threads,
            scopes,
            images,
            imageThread: async (id) => (await imageStore.rows.get(id))?.thread_id ?? null,
            kn,
          }),
          answers: proAnswers({
            workspaceId: owner.workspaceId,
            repo: threads,
            runs: runStore,
            worker,
            registry,
            gateway,
            branches: branchStore,
            flows,
            flowStore,
            notebooks,
            memory,
            // Claude Code as a model inside Beam and the Flow lab is Pro (docs/engines.md).
            allowModel: (id) => !isClaudeCodeModel(id) || hasProFeature('beam') || hasProFeature('flow_lab'),
          }),
        }),
      )
      .catch((err: unknown) =>
        log.warn({ err }, "Pro's features could not start: the free product carries on"),
      );
  // Where Pro takes part in answering: read when each answer runs, so a lapse stops it at once.
  proHooks = proFeatures?.hooks;
  if (proHooks?.turnContext) {
    const packsFor = proHooks.turnContext.bind(proHooks);
    proTurnContext = (q) => (hasProFeature('context_packs') ? packsFor(q) : Promise.resolve([]));
  }
  if (proHooks?.routeHint) {
    const hint = proHooks.routeHint.bind(proHooks);
    flows.deps.routeHint = (q) => (hasProFeature('flow_lab') ? hint(q) : Promise.resolve(null));
  }
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
  const startupDeps = {
    sql,
    url: env.DATABASE_URL,
    dataDir,
    version: VERSION,
    schema: schemaNow,
    managed: env.ANCILE_RUNTIME === 'desktop',
  };
  // What is running (docs/activity.md): runs, Claude Code sessions elsewhere, subagents, shells.
  const activity = createActivity({
    sql,
    workspaceId: owner.workspaceId,
    runs: runStore,
    threads,
    bus: events,
    claude: {
      service: claudeCode.service,
      store: claudeCodeStore,
      holders: claudeCode.holders,
      ownWriteAt: (id) => claudeLive.ownWriteAt(id),
    },
  });
  // What the desktop shell needs of Core: notifications, commands, counts (docs/desktop.md).
  const stateStore = new PgStateStore(sql, owner.userId);
  const desktop = new DesktopHost({
    settings,
    bus: events,
    approvals: permissions,
    runningRuns: async () =>
      (await activity.list()).items.filter(
        (i) => i.kind === 'run' && (i.state === 'running' || i.state === 'waiting'),
      ).length,
    threads,
    scopes,
    prefs: () => stateStore.getUi('prefs'),
    pro: () => (hasProFeature('desktop') ? (proFeatures?.desktop ?? null) : null),
  });
  desktopHost = desktop;
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
    ...(labMcp && { labMcp: labMcp.handle }),
    claudeMcp: claudeMcp.handle,
    internalRoutes: [
      logIngestRoutes({ pipeline: obs }),
      // The desktop host asks here before checking nvx.sh for updates.
      updateInternalRoutes({ settings, offer: updateOffer, canBeta: () => hasProFeature('desktop') }),
      // …and every few seconds for notifications, commands and what is running (docs/desktop.md).
      desktopInternalRoutes(desktop),
      // …and for a backup before it installs an older build.
      startupInternalRoutes(startupDeps),
    ],
    ready: async () => {
      const db = await database.sql`select 1`.then(() => true).catch(() => false);
      return { ok: db, checks: { database: db } };
    },
    internal: { registry, gateway },
    runs: runStore,
    allowedOrigins: cockpitOrigins(env.ANCILE_PUBLIC_URL, env.ANCILE_ALLOWED_ORIGINS),
    routes: [
      // Before the general /models/:id routes, which would take PUT /models/lines/... (MD4, MD5).
      modelWatchRoutes(modelWatch),
      updateRoutes({ settings, offer: updateOffer, canBeta: () => hasProFeature('desktop') }),
      desktopRoutes(desktop),
      // Start-up status and database backups (docs/desktop.md, Updates and your data).
      startupRoutes(startupDeps),
      // Tidy storage: dedupe chunks and old versions, vacuum, with a backup first (MT1).
      tidyRoutes(tidyDeps),
      // Phase 5: operations
      logRoutes({ pipeline: obs }),
      traceRoutes({
        store: obsStore,
        runs: runStore,
        runEvents,
        turn: {
          repo: threads,
          runs: runStore,
          worker,
          registry,
          branches: branchStore,
          switches: builtinSettings,
        },
      }),
      healthRoutes({ supervisor: () => supervisor }),
      diagnosticRoutes({ runner: diagnostics }),
      clientErrorRoutes(),
      themeRoutes(dataDir),
      automationRoutes({
        runner: automations,
        notebookExists: notebookInWorkspace,
        flowExists,
        registry,
        tests: {
          // Test push: the remote typed in the dialog, else the one in use. Nothing is changed there.
          memory_backup: async (req) => {
            const typed = typeof req.remote === 'string' ? req.remote.trim() : '';
            if (typed && !GIT_REMOTE.test(typed))
              return { ok: false, detail: "That doesn't look like a git remote." };
            const remote = typed || memoryRemote || (await secrets.get(MEMORY_REMOTE_SECRET));
            if (!remote) return { ok: false, detail: 'No remote is set yet. Type one to test it.' };
            return testMemoryPush(resolve(env.ANCILE_DATA_DIR, 'memory'), remote);
          },
        },
      }),
      mcpClientRoutes({
        clients: mcpClients,
        permissions,
        userId: owner.userId,
        publicUrl: env.ANCILE_PUBLIC_URL,
      }),
      licenseRoutes({ license: licence }),
      // Pro's data stays readable and exportable when the licence lapses or the build goes free.
      proDataRoutes({ sql, edition: () => pro.build }),
      telemetryRoutes({ telemetry }),
      flowRoutes({
        workspaceId: owner.workspaceId,
        flows,
        repo: threads,
        runs: runStore,
        worker,
        tools,
        turn: {
          repo: threads,
          runs: runStore,
          worker,
          registry,
          branches: branchStore,
          switches: builtinSettings,
        },
      }),
      threadRoutes({
        afterDelete: (id) => imageStore.deleteThread(id),
        repo: threads,
        runs: runStore,
        worker,
        registry,
        workspaceId: owner.workspaceId,
        notebookExists: async (id) => (await notebooks.get(id))?.workspace_id === owner.workspaceId,
        notebookPrivate: async (id) =>
          (await sql<{ private: boolean }[]>`select private from core.notebooks where id = ${id}`)[0]
            ?.private === true,
        flowStore,
        branches: branchStore,
        sendLocks,
        switches: builtinSettings,
        afterSend: branchSuggester({
          gateway,
          registry,
          promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
          repo: threads,
          bus: events,
          switches: builtinSettings,
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
        switches: builtinSettings,
      }),
      // Room on the disk before a source is added (system/disk.ts).
      sourceDiskGuard({ dataDir }),
      notebookRoutes({
        workspaceId: owner.workspaceId,
        notebooks,
        threads,
        kn,
        flowStore,
        tombstones,
        merge: notebookMerge,
      }),
      linkRoutes(contextLinks),
      privacyRoutes(privacy),
      scopeRoutes({
        store: scopeStore,
        history: new SharedHistory({
          store: new PgSharedHistoryStore(sql),
          classify: classifier((id) => {
            const m = registry.get(id);
            return m ? { provider: m.provider, local: isLocalModel(m) } : undefined;
          }),
        }),
      }),
      autoRoutes({
        plans: autoPlans,
        events: runEvents,
        reviewer: () => gateAuto.review.reviewerStatus(),
        check: new ReviewerCheck({ reviewers: () => coreReviewers({ secrets, gateway, registry }) }),
      }),
      memoryRoutes({ service: memory, threads, registry, transfer: memoryTransfer }),
      localModelRoutes({ models: localModels, loaded: loadedModels }),
      chatImportRoutes({
        imports: chatImports,
        notebookExists: async (id) => {
          const n = await notebooks.get(id);
          return !!n && n.workspace_id === owner.workspaceId && !n.archived_at;
        },
      }),
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
        scopeOf: (ref) => scopes.effective(ref),
        integrity,
        webFor,
        preflight: (a) => preflightJudge({ registry, scopeOf: (ref) => scopes.effective(ref) }, a),
        selection: {
          run: (input, signal) =>
            checkSelection(
              {
                gateway,
                registry,
                promptsDir: resolve(env.ANCILE_PROMPTS_DIR),
                kn,
                judges: factcheckJudges,
                repo: threads,
                familyOf,
                scopeOf: (ref) => scopes.effective(ref),
                notebookWeb: async (id) =>
                  config.factcheck?.web_search === true || ((await notebooks.get(id))?.check_on_web ?? false),
                web: factcheckWeb,
                gate,
                userId: owner.userId,
                codeTier: tools.get('python_run')?.tier,
                runPython: (a, sig) =>
                  interpreter.run({ threadId: a.threadId, callId: null, code: a.code, files: [] }, sig),
              },
              input,
              signal,
            ).then((r) => ({ check: r.check, cached: r.cached })),
        },
      }),
      permissionRoutes({
        onReady: (api) => {
          decideApprovalOnce = api.decideOnce;
        },
        store: permissions,
        preset: {
          get: async () => {
            const p = (await settings.get<string>(SETTING.preset)) ?? config.tools?.preset ?? 'balanced';
            return p === 'careful' || p === 'hands_off' || p === 'auto' ? p : 'balanced';
          },
          set: async (preset) => {
            await settings.set(SETTING.preset, preset);
            await applyPreset(preset);
          },
        },
        events: runEvents,
        bus: events,
        worker,
        userId: owner.userId,
        onResolved: (a, status, reason, updatedArgs) => relayAnswer(a, status, reason, updatedArgs),
        editable: (a) => claudeLive.editable(a),
        recheck: (a, args) => claudeLive.recheck(a, args),
        // A saved answer settles the other waiting requests it covers: each is decided again here.
        decideAgain: async (a) => {
          if (claudeLive.editable(a)) return claudeLive.recheck(a, a.args);
          const t = a.thread_id ? await threads.getThread(a.thread_id) : undefined;
          const spec = tools.get(a.tool);
          return gate.check({
            userId: owner.userId,
            principal: a.principal,
            action: a.action,
            resource: a.resource,
            toolTier: spec?.tier ?? a.tier,
            destructive: spec?.destructive ?? false,
            scope: {
              threadId: a.thread_id,
              notebookId: t?.notebook_id ?? null,
              workspaceId: owner.workspaceId,
            },
            runId: a.run_id,
            traceId: newTraceId(),
            tool: a.tool,
            args: a.args,
            ...(a.call_id && { callId: a.call_id }),
          });
        },
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
        tester: liveTester((m, keys) => languageModelFor(m, keys, endpoints)),
        onPreset: applyPreset,
        onKeySaved: (provider) => modelWatch.keySaved(provider),
      }),
      stateRoutes(stateStore),
      notificationRoutes(notifications),
      computeRoutes({ client: compute, secrets, hasFeature: hasProFeature, sync: syncProvider }),
      creditRoutes({ ledger: creditLedger, registry }),
      credentialRoutes({
        secrets,
        env: process.env,
        registry,
        planCredit: () => creditLedger.current(),
        tester: liveTester((m, keys) => languageModelFor(m, keys, endpoints)),
        ...(compute.configured && {
          runpod: {
            connect: (key: string) => connectRunPod(compute, savedSecrets, key),
            disconnect: () => disconnectRunPod(compute, savedSecrets),
          },
        }),
        onChange: async (id) => {
          // A provider's key saved: read its model list now rather than at the next daily check (F3a).
          if (CREDENTIALS[id].check === 'provider') modelWatch.keySaved(id);
          if (id === 'github') github.forget?.();
          // The backup's "Not set up" follows a remote saved or removed here at once.
          if (id === 'memory_remote') await readSavedRemote();
        },
      }),
      proRoutes({ routes: proFeatures?.routes ?? [], hasFeature: hasProFeature }),
      // A Pro feature with no route here (the free build) answers 402, so the Cockpit shows it as Pro.
      lockedProRoutes(),
      toolRoutes({ tools, servers: mcpServers, guard: mcpGuard, presets: mcpPresets }),
      repoRoutes({ repos, github, secrets, mcp: mcpServers }),
      // The code editor: read and save files, through the same gate as fs.read and fs.write.
      fileRoutes({
        files: new FileService({
          roots: rootSource({
            workspace: { dir: workspace.dir, root: workspace.root },
            repos: () => repos.list(),
            claudeProjects: () => claudeCodeStore.projects(owner.workspaceId),
          }),
          workspace: { dir: workspace.dir, root: workspace.root },
          gate,
          gateFor: (root) =>
            createGate({
              policy: policyRef,
              store: permissions,
              workspaceRoot: root,
              fs: filesProbe(),
              scopes,
            }),
          store: permissions,
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          notebookOf: async (id) => (await threads.getThread(id))?.notebook_id ?? null,
        }),
      }),
      claudeCodeRoutes({
        queue: () => turnQueue,
        service: () => claudeCode.service,
        live: () => claudeLive,
        sendLocks,
        sameRepo: () => sameRepo,
        mcpList: () => claudeMcpList,
        mcpManage: () => claudeMcpManage,
      }),
      activityRoutes({ activity }),
      engineRoutes({
        engines: () => engines,
        threads,
        store: engineStore,
        workspaceId: owner.workspaceId,
        sendLocks,
      }),
      openRouterRoutes({
        service: openRouter,
        candidates: async () => {
          const ready = registry
            .info()
            .filter((m) => m.status === 'ready')
            .map(fromInfo);
          const local = (await localModels.view().catch(() => null))?.items ?? [];
          for (const l of local)
            if (l.kind === 'chat' && !l.model_id)
              ready.push({
                id: `ollama/${l.source}`,
                name: l.name,
                provider: 'ollama',
                via: 'direct',
                context: l.context_window,
                capabilities: l.capabilities,
                input: 0,
                output: 0,
                suggestion: true,
              });
          return ready;
        },
      }),
      usageRoutes({
        workspaceId: owner.workspaceId,
        source: usageSource,
        limits: () => planLimits,
        credit: () => creditLedger.status(),
      }),
      labRoutes({
        engine,
        repo: threads,
        runs: runStore,
        worker,
        workspaceId: owner.workspaceId,
        workspaceDir: workspace.dir,
        workspaceRoot: workspace.root,
        snapshotsDir: labSnapshots,
        settings,
        repos,
      }),
      artifactRoutes({ store: new PgArtifactStore(sql), threads, workspaceId: owner.workspaceId }),
      interpreterRoutes({ runtime: pyodide, service: interpreter, figures: interpreterFigures }),
      imageRoutes({ images, threads, workspaceId: owner.workspaceId }),
      attachmentRoutes({ attachments, threads, workspaceId: owner.workspaceId }),
    ],
    ...(env.NODE_ENV === 'production' && existsSync(cockpitDist) && { cockpitDist }),
  });

  const server = serve({ fetch: app.fetch, hostname: env.ANCILE_HOST, port: env.ANCILE_PORT }, (info) => {
    log.info(
      { host: env.ANCILE_HOST, port: info.port, version: VERSION },
      `NVX Ancile Core ready on ${env.ANCILE_PUBLIC_URL}`,
    );
  });
  // Claude Code sessions come in by themselves (Auto-import, on by default),
  // shortly after start and only when Claude Code is installed here.
  claudeCode.service.startAuto();
  activity.start();
  desktop.start();
  // ---- Engines (docs/engines.md): the front door, and Claude Code as a model ----
  routingClient.register(
    CLAUDE_CODE_PROVIDER,
    new ClaudeCodeModelClient({
      bridge: claudeCode.bridge,
      cli: () => claudeCode.service.cliPath(),
      env: () => claudeCode.service.cliEnv(),
      creditKey: async () => (await secrets.get(DEFAULT_SECRET.anthropic ?? 'ANTHROPIC_API_KEY')) ?? null,
      onCreditExhausted: () => void creditLedger.markExhausted().catch(() => undefined),
      cwd: resolve(env.ANCILE_DATA_DIR, 'claude-model'),
      mcp: {
        url: `http://${ccHost.includes(':') ? `[${ccHost}]` : ccHost}:${env.ANCILE_PORT}/mcp/claude`,
        secret: claudeSecret,
      },
      gate: (root) =>
        createGate({ policy: policyRef, store: permissions, workspaceRoot: root, fs: nativeProbe() }),
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      handles: modeAHandles,
      observe: (m) => planLimits.observe(m),
    }),
  );
  // Claude Code as a model: offered while Claude Code is installed and verified.
  const offerClaudeModels = () =>
    claudeCode.service
      .status()
      .then((st) => syncClaudeCodeModels(registry, st))
      .catch((err: unknown) => log.warn({ err }, "Claude Code's models could not be offered"));
  void offerClaudeModels();
  // Signing in or out, installing, or any read of the status keeps the models and their billing current.
  claudeCode.service.onStatus((st) => syncClaudeCodeModels(registry, st));
  events.subscribe(Number.MAX_SAFE_INTEGER, (e) => {
    if (e.type === 'claude_code.changed' && (e.what === 'install' || e.what === 'auth'))
      void offerClaudeModels();
  });
  // Claude Code's "/" list for the latest folders, read once Core has settled,
  // so the first "/" in a Claude Code thread is already complete.
  const warmCommands = setTimeout(() => {
    if (claudeOff) return;
    void claudeLive
      .warmCommands()
      .catch((err: unknown) =>
        log.warn({ err: (err as Error).message }, "Claude Code's command lists were not read ahead"),
      );
  }, 45_000);
  warmCommands.unref();

  // Laptop sleep (system/wake.ts): on wake, runs, the Claude bridge and the health view pick up again.
  const wake = new WakeWatch();
  wake.onWake(async () => {
    void modelWatch.onWake();
    await worker.wake();
    await claudeCode.bridge
      .wake()
      .catch((err: unknown) =>
        log.warn({ err: (err as Error).message }, 'the Claude bridge did not come back after sleep'),
      );
    await supervisor.checkNow();
  });
  wake.start();
  modelWatch.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    wake.stop();
    modelWatch.stop();
    supervisor.stop();
    automations.stop();
    builtinSettings.stop();
    knowledgeSync.stop();
    licence.stop();
    proFeatures?.stop?.();
    telemetry.stop();
    await obs.stop();
    stopCompute();
    worker.stop();
    mirror?.stop();
    await labMcp?.close();
    repos.stop();
    activity.stop();
    desktop.stop();
    turnQueue.stop();
    claudeLive.stop();
    localModels.stop();
    loadedModels.stop();
    chatImports.stop();
    claudeCode.stop();
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
