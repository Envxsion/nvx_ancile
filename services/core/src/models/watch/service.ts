/**
 * ------------------------------------------------------------------
 *  Title    |  Model watch
 *  Ref      |  roadmap MD4, MD5 · guard rail GR16 · docs/models.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Once a day (and on start, and on waking) read the live
 *           |  model list of every provider you have a key for, say
 *           |  what is new or changed, keep prices and windows true,
 *           |  and move "latest" lines on only after a test call.
 *  How      |  One run at a time, providers one after another. The
 *           |  first run is 60 s after boot; an hourly tick checks the
 *           |  providers whose last good check is over 24 h old, or
 *           |  whose last failed check is past its backoff (1 h,
 *           |  doubling to 24 h). A manual check asks each provider at
 *           |  most once a minute. Following a line (GR16): a newer
 *           |  stable model is tried with a minimal real request
 *           |  (30 s); only a pass moves the alias, and the old model
 *           |  stays one "Go back" away.
 *  Note     |  Nothing here sends a key anywhere but the provider it
 *           |  belongs to. OpenRouter's public list (prices for direct
 *           |  providers) is fetched without a key, and not at all
 *           |  when the setting is off.
 * ------------------------------------------------------------------
 */
import {
  AncileError,
  type ModelChange,
  ModelConfig,
  type ModelInfo,
  type ModelLine,
  type ModelLineUpdate,
  type ModelWatchReport,
  type ProviderCheck,
  type WatchedModel,
  type WatchPrice,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import { baseUrlFor, knownProfile } from '../../gateway/profiles';
import { ANTHROPIC_WORKSPACE_SECRET, DEFAULT_SECRET } from '../../gateway/providers';
import { type ModelRegistry, secretFor } from '../../gateway/registry';
import { notFound } from '../../obs/errors';
import { logFor } from '../../obs/logger';
import type { SecretStore } from '../../secrets';
import { SETTING, type SettingsStore } from '../../settings';
import { familyCapabilities } from './caps';
import { diffProvider, type PriceMode } from './diff';
import { type LineState, newestStable } from './linebook';
import { compareModels, vendorOf } from './lines';
import {
  type JsonGetter,
  type ListKind,
  list,
  listOpenRouterPublic,
  liveJson,
  NO_LIST_VENDORS,
  OPENROUTER_VENDOR,
  priceIndex,
} from './listers';
import type { StoredModel, WatchStore } from './store';

const log = logFor('model-watch');

const HOUR = 3_600_000;
export const CHECK_EVERY_MS = 24 * HOUR;
export const FIRST_RUN_DELAY_MS = 60_000;
export const TICK_EVERY_MS = HOUR;
/** The one-time lineup upgrade runs this long after boot, and again this long after an inconclusive try. */
export const UPGRADE_DELAY_MS = 90_000;
export const UPGRADE_RETRY_MS = 5 * 60_000;
export const MANUAL_MIN_GAP_MS = 60_000;
export const TEST_CALL_TIMEOUT_MS = 30_000;
/**
 * The shipped lineup this code ships (every line's current model and the one before it). Raising it
 * runs the upgrade step once more on installs that already hold keys (upgradeLineup).
 */
export const LINEUP_VERSION = 1;
/** Most one-token tests a key save, or the upgrade, makes for one provider. OpenRouter has the most lines, so fewer. */
export const TEST_CAP = 6;
export const TEST_CAP_OPENROUTER = 3;
/** Saves in quick succession (setup, then Settings) become one check. */
export const KEY_SAVED_DELAY_MS = 2_000;

/** Cheap enough to test without asking: dearer models are tried when the owner presses Test. */
export const isCheap = (m: ModelConfig) =>
  m.price.output_per_mtok > 0 && m.price.input_per_mtok <= 1 && m.price.output_per_mtok <= 5;

/** The result of a minimal real request through the normal gateway path. */
export interface TestResult {
  ok: boolean;
  /** A sentence for the owner when it failed. */
  detail: string | null;
  /** The provider's reason when it refused this model for good (not a bad key, a limit or an outage). */
  refused?: string | null;
}
export type TestCall = (model: ModelConfig, signal: AbortSignal) => Promise<TestResult>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface ModelWatchDeps {
  registry: ModelRegistry;
  store: WatchStore;
  settings: SettingsStore;
  secrets: SecretStore;
  testCall: TestCall;
  publish?: (e: { type: 'models.changed'; what: 'watch' | 'line'; unseen: number }) => unknown;
  get?: JsonGetter;
  now?: () => number;
  timers?: Timers;
  /** `prices_as_of` from models.yaml. */
  bundledPricesDate?: string | null;
  newId?: () => string;
  firstRunDelayMs?: number;
  upgradeDelayMs?: number;
  tickEveryMs?: number;
  keyDelayMs?: number;
}

/** How one provider's last check went, as saved. */
interface CheckState {
  checked_at: string | null;
  attempt_at: string | null;
  ok: boolean;
  error_code: string | null;
  error_title: string | null;
  unsupported: boolean;
  models: number;
  failures: number;
  next_at: string | null;
}

interface Target {
  provider: string;
  kind: ListKind | 'none';
  vendor: string | null;
  baseUrl: string;
  secretName: string | null;
  /** The model list's path, from the provider's profile. */
  path?: string | null;
}

const BUILTIN: Record<string, { kind: ListKind; baseUrl: string }> = {
  openrouter: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  google: { kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
};

const DEFAULTS: Record<string, { ctx: number; max: number }> = {
  anthropic: { ctx: 200_000, max: 32_000 },
  openai: { ctx: 200_000, max: 32_000 },
  google: { ctx: 1_000_000, max: 32_000 },
};

const tooSoon = (provider: string) =>
  new AncileError({
    code: 'models.check_too_soon',
    title: `${provider} was checked a moment ago`,
    hint: 'Each provider can be checked once a minute. Try again shortly.',
    status: 429,
    errorClass: 'permanent',
    retryable: true,
  });

const lineModelWrong = (id: string, line: string) =>
  new AncileError({
    code: 'models.line_model_not_in_line',
    title: `${id} is not a model of ${line}`,
    hint: 'Pick one of the models listed for this line.',
    status: 400,
    errorClass: 'permanent',
  });

const noPrevious = () =>
  new AncileError({
    code: 'models.line_no_previous',
    title: 'There is no earlier model to go back to',
    hint: 'A line remembers the model it used before its last move. It has not moved yet.',
    status: 409,
    errorClass: 'permanent',
  });

export class ModelWatch {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly get: JsonGetter;
  private readonly newId: () => string;
  private rows: StoredModel[] = [];
  private checks: Record<string, CheckState> = {};
  private loaded: Promise<void> | null = null;
  private firstTimer: unknown = null;
  private tickTimer: unknown = null;
  private upgradeTimer: unknown = null;
  private abort = new AbortController();
  private busy = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly background = new Set<Promise<unknown>>();
  private readonly keyTimers = new Map<string, unknown>();

  constructor(private readonly deps: ModelWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.get = deps.get ?? liveJson;
    this.newId = deps.newId ?? (() => `mchg_${ulid()}`);
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  // ---- Lifecycle ----

  start(): void {
    if (this.firstTimer || this.tickTimer) return;
    this.abort = new AbortController();
    void this.load().catch((err: unknown) =>
      log.warn({ err }, 'the model watch could not read its saved state'),
    );
    this.firstTimer = this.timers.setTimeout(
      () => void this.tick(),
      this.deps.firstRunDelayMs ?? FIRST_RUN_DELAY_MS,
    );
    this.tickTimer = this.timers.setInterval(() => void this.tick(), this.deps.tickEveryMs ?? TICK_EVERY_MS);
    // The lineup upgrade does not wait for the hourly tick: a model the provider refuses should not stay
    // offered for an hour after boot.
    this.upgradeSoon(this.deps.upgradeDelayMs ?? UPGRADE_DELAY_MS);
  }

  private upgradeSoon(ms: number): void {
    if (this.upgradeTimer) this.timers.clearTimeout(this.upgradeTimer);
    this.upgradeTimer = this.timers.setTimeout(() => {
      this.upgradeTimer = null;
      void this.upgradeNow();
    }, ms);
  }

  /** Run the upgrade step outside the hourly tick; a busy run is waited for, and an inconclusive try is repeated. */
  private async upgradeNow(): Promise<void> {
    if (this.abort.signal.aborted) return;
    if (this.busy) return this.upgradeSoon(30_000);
    this.busy = true;
    try {
      await this.load();
      const done = await this.upgradeLineup();
      if (done === 'again') this.upgradeSoon(UPGRADE_RETRY_MS);
    } catch (err) {
      log.warn({ err }, 'the lineup upgrade did not finish');
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    if (this.firstTimer) this.timers.clearTimeout(this.firstTimer);
    if (this.tickTimer) this.timers.clearInterval(this.tickTimer);
    if (this.upgradeTimer) this.timers.clearTimeout(this.upgradeTimer);
    this.upgradeTimer = null;
    this.firstTimer = null;
    this.tickTimer = null;
    for (const h of this.keyTimers.values()) this.timers.clearTimeout(h);
    this.keyTimers.clear();
    this.abort.abort();
  }

  /** Resolves when background work (a test call started by turning follow on) has finished. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /** The computer woke: check whatever came due while it slept. */
  async onWake(): Promise<void> {
    await this.tick();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      this.rows = await this.deps.store.rows();
      this.checks = (await this.deps.settings.get<Record<string, CheckState>>(SETTING.watchChecks)) ?? {};
      this.deps.registry.setWatch(this.rows);
    })();
    return this.loaded;
  }

  // ---- Settings ----

  async openrouterPrices(): Promise<boolean> {
    const s = await this.deps.settings.get<{ openrouter_prices?: boolean }>(SETTING.watchSettings);
    return s?.openrouter_prices ?? true;
  }

  async setOpenrouterPrices(on: boolean): Promise<ModelWatchReport> {
    await this.deps.settings.set(SETTING.watchSettings, { openrouter_prices: on });
    // Off drops the prices that came from OpenRouter, so the bundled ones apply again.
    if (!on) {
      await this.load();
      const dropped = this.rows.filter((r) => r.price_source === 'openrouter');
      if (dropped.length) {
        const next = dropped.map((r) => ({ ...r, price: null, price_source: null, price_checked_at: null }));
        await this.deps.store.upsert(next);
        this.rows = this.rows.map((r) => next.find((n) => n.id === r.id) ?? r);
        this.deps.registry.setWatch(this.rows);
      }
    }
    return this.report();
  }

  // ---- Scheduling ----

  private backoffMs(failures: number): number {
    return Math.min(24 * HOUR, HOUR * 2 ** Math.max(0, failures - 1));
  }

  private due(t: Target): boolean {
    const s = this.checks[t.provider];
    if (!s) return true;
    if (t.kind === 'none') return false;
    const now = this.now();
    if (s.ok) return !s.checked_at || now - Date.parse(s.checked_at) >= CHECK_EVERY_MS;
    return !s.next_at || now >= Date.parse(s.next_at);
  }

  /** The hourly tick: check what is due. A run in progress is not doubled. */
  async tick(): Promise<void> {
    if (this.busy || this.abort.signal.aborted) return;
    this.busy = true;
    try {
      await this.load();
      const targets = (await this.targets()).filter((t) => this.due(t));
      await this.runTargets(targets);
      await this.upgradeLineup();
      await this.retestUnavailable();
    } catch (err) {
      log.warn({ err }, 'the model check did not finish');
    } finally {
      this.busy = false;
    }
  }

  /**
   * A model a provider refused may be allowed again (a setting changed, a plan upgraded): once a day
   * each one is tried again with one token. A pass puts it back; another refusal keeps it, with the
   * time of this try; an answer that says nothing about the model (an outage) changes nothing.
   */
  async retestUnavailable(): Promise<void> {
    const reg = this.deps.registry;
    for (const u of reg.unavailableList()) {
      if (this.abort.signal.aborted) return;
      if (this.now() - Date.parse(u.at) < CHECK_EVERY_MS) continue;
      const model = reg.getExact(u.id);
      if (model) await this.verify(model);
    }
  }

  /** Check now: all providers, or one. Each at most once a minute. */
  async check(provider?: string): Promise<ModelWatchReport> {
    await this.load();
    // A check you ask for also finishes the lineup upgrade, if it has not been done.
    this.upgradeTries = 0;
    if (!this.busy) {
      this.busy = true;
      try {
        await this.upgradeLineup();
      } catch (err) {
        log.warn({ err }, 'the lineup upgrade did not finish');
      } finally {
        this.busy = false;
      }
    }
    const all = await this.targets();
    if (!all.length) return this.report();
    let picked = all;
    if (provider) {
      picked = all.filter((t) => t.provider === provider);
      if (!picked.length) throw notFound(`A provider called ${provider}`);
    }
    const ok = picked.filter((t) => {
      const at = this.checks[t.provider]?.attempt_at;
      return !at || this.now() - Date.parse(at) >= MANUAL_MIN_GAP_MS;
    });
    if (!ok.length) throw tooSoon(provider ?? 'Every provider');
    const run = this.queue.then(() => this.runTargets(ok));
    this.queue = run.catch(() => undefined);
    await run;
    return this.report();
  }

  // ---- Providers ----

  /** Providers with a key (or none to give): built-in ones, and endpoints of known vendors. */
  private async targets(): Promise<Target[]> {
    const names = new Set(await this.deps.secrets.names());
    const out: Target[] = [];
    const models = this.deps.registry.all();
    for (const [provider, b] of Object.entries(BUILTIN)) {
      const secretName =
        models.find((m) => m.provider === provider && m.secret)?.secret ?? DEFAULT_SECRET[provider] ?? null;
      if (!secretName || !names.has(secretName)) continue;
      const own = models.find((m) => m.provider === provider && m.base_url)?.base_url;
      out.push({ provider, kind: b.kind, vendor: provider, baseUrl: own ?? b.baseUrl, secretName });
    }
    const seen = new Set(Object.keys(BUILTIN));
    for (const m of models) {
      if (seen.has(m.provider) || m.via !== 'direct') continue;
      // DeepSeek, Kimi, GLM and the rest: the address comes from the provider's profile and saved region.
      const profile = knownProfile(m.provider);
      const region = profile?.regionSecret ? await this.deps.secrets.get(profile.regionSecret) : undefined;
      const baseUrl = m.base_url ?? (profile ? baseUrlFor(profile, region) : null);
      if (!baseUrl) continue;
      const vendor = vendorOf(m.provider, baseUrl);
      if (!vendor) continue;
      seen.add(m.provider);
      const secretName = m.secret ?? profile?.secret ?? null;
      if (!secretName || !names.has(secretName)) continue;
      out.push({
        provider: m.provider,
        kind: NO_LIST_VENDORS.has(vendor) ? 'none' : 'compatible',
        vendor,
        baseUrl,
        secretName,
        path: profile?.modelsPath ?? null,
      });
    }
    // OpenRouter first: its own list can price the rest without another call.
    return out.sort((a, b) => (a.provider === 'openrouter' ? -1 : b.provider === 'openrouter' ? 1 : 0));
  }

  private async saveChecks(): Promise<void> {
    await this.deps.settings.set(SETTING.watchChecks, this.checks);
  }

  private async runTargets(targets: Target[]): Promise<void> {
    const run: { orIndex?: Map<string, WatchPrice> | 'failed' | 'off' } = {};
    let anyChange = false;
    for (const t of targets) {
      if (this.abort.signal.aborted) return;
      anyChange = (await this.runProvider(t, run)) || anyChange;
    }
    if (anyChange) await this.announce('watch');
  }

  private async priceMode(
    t: Target,
    run: { orIndex?: Map<string, WatchPrice> | 'failed' | 'off' },
  ): Promise<PriceMode> {
    if (t.provider === 'openrouter' || !t.vendor || !OPENROUTER_VENDOR[t.vendor]) return { mode: 'off' };
    if (!(await this.openrouterPrices())) return { mode: 'off' };
    if (!run.orIndex) {
      try {
        const listed = await listOpenRouterPublic(this.get, this.abort.signal);
        run.orIndex = priceIndex(listed);
      } catch (err) {
        log.warn(
          { code: (err as AncileError).code },
          'OpenRouter prices could not be read; keeping the last ones',
        );
        run.orIndex = 'failed';
      }
    }
    if (run.orIndex === 'failed') return { mode: 'keep' };
    if (run.orIndex === 'off') return { mode: 'off' };
    return { mode: 'index', index: run.orIndex };
  }

  /** One provider's check. Returns whether it found anything worth announcing. */
  private async runProvider(
    t: Target,
    run: { orIndex?: Map<string, WatchPrice> | 'failed' | 'off' },
  ): Promise<boolean> {
    const at = this.iso();
    const prevState = this.checks[t.provider];
    if (t.kind === 'none') {
      this.checks[t.provider] = {
        checked_at: null,
        attempt_at: null,
        ok: true,
        error_code: null,
        error_title: null,
        unsupported: true,
        models: 0,
        failures: 0,
        next_at: null,
      };
      await this.saveChecks();
      return false;
    }
    try {
      const key = t.secretName ? ((await this.deps.secrets.get(t.secretName)) ?? null) : null;
      const workspaceId =
        t.kind === 'anthropic' ? ((await this.deps.secrets.get(ANTHROPIC_WORKSPACE_SECRET)) ?? null) : null;
      this.checks[t.provider] = { ...(prevState ?? this.blank()), attempt_at: at };
      const listed = await list(
        { kind: t.kind, baseUrl: t.baseUrl, key, workspaceId, path: t.path ?? null },
        this.get,
        this.abort.signal,
      );
      if (t.provider === 'openrouter' && !run.orIndex) run.orIndex = priceIndex(listed);
      const prices = await this.priceMode(t, run);
      const previous = this.rows.filter((r) => r.provider === t.provider);
      const catalogue = this.deps.registry.all().filter((m) => m.provider === t.provider);
      const result = diffProvider({
        provider: t.provider,
        vendor: t.vendor,
        baseUrl: t.baseUrl,
        now: at,
        listed,
        previous,
        catalogue,
        prices,
        ownPrices: t.provider === 'openrouter',
        suppressNew: t.provider === 'openrouter',
        newId: this.newId,
      });
      await this.deps.store.upsert(result.rows);
      const byId = new Map(this.rows.map((r) => [r.id, r]));
      for (const r of result.rows) byId.set(r.id, r);
      this.rows = [...byId.values()];
      this.deps.registry.setWatch(this.rows);
      this.checks[t.provider] = {
        checked_at: at,
        attempt_at: at,
        ok: true,
        error_code: null,
        error_title: null,
        unsupported: false,
        models: listed.length,
        failures: 0,
        next_at: this.iso(this.now() + CHECK_EVERY_MS),
      };
      await this.saveChecks();
      log.info(
        { provider: t.provider, models: listed.length, changes: result.changes.length },
        'checked the model list',
      );
      let moved = false;
      try {
        moved = await this.considerLines(t.provider);
      } finally {
        // A retired model's change names the model that answers in its place (after lines had their say).
        for (const c of result.changes) {
          if (c.kind !== 'retired') continue;
          const r = this.deps.registry.resolve(c.model_id);
          c.after = r && r.via === 'retired' ? r.model.id : null;
        }
        if (result.changes.length) await this.deps.store.addChanges(result.changes);
        await this.deps.store.trim(at);
      }
      return result.changes.length > 0 || moved;
    } catch (err) {
      const failures = (prevState?.failures ?? 0) + 1;
      const e = err instanceof AncileError ? err : null;
      this.checks[t.provider] = {
        ...(prevState ?? this.blank()),
        attempt_at: at,
        ok: false,
        error_code: e?.code ?? 'models.list_failed',
        error_title: e?.title ?? 'The model list could not be read',
        failures,
        next_at: this.iso(this.now() + this.backoffMs(failures)),
      };
      await this.saveChecks().catch(() => undefined);
      log.warn(
        { provider: t.provider, code: e?.code ?? 'unknown', failures },
        'could not check the model list',
      );
      return false;
    }
  }

  private blank(): CheckState {
    return {
      checked_at: null,
      attempt_at: null,
      ok: false,
      error_code: null,
      error_title: null,
      unsupported: false,
      models: 0,
      failures: 0,
      next_at: null,
    };
  }

  // ---- Lines ----

  private unseenCount = async () => (await this.deps.store.changes()).filter((c) => !c.seen).length;

  private async announce(what: 'watch' | 'line'): Promise<void> {
    await this.deps.publish?.({ type: 'models.changed', what, unseen: await this.unseenCount() });
  }

  private async record(c: Omit<ModelChange, 'id' | 'at' | 'seen'>): Promise<void> {
    await this.deps.store.addChanges([{ ...c, id: this.newId(), at: this.iso(), seen: false }]);
  }

  /** Build a registry model from a watch row. A line's current model lends a price when the row has none. */
  private configFor(row: StoredModel, lineCurrent?: ModelConfig): ModelConfig {
    const reg = this.deps.registry;
    const sibling = reg.all().find((m) => m.provider === row.provider);
    const d = DEFAULTS[row.provider] ?? { ctx: 128_000, max: 8_192 };
    return ModelConfig.parse({
      id: row.id,
      provider: row.provider,
      provider_model: row.provider_model,
      display_name: row.display_name,
      via: 'direct',
      family: sibling?.family ?? row.provider,
      context_window: row.context_window ?? lineCurrent?.context_window ?? d.ctx,
      max_output: row.max_output ?? lineCurrent?.max_output ?? d.max,
      // What the provider's list says; else the family table; else a model of the same line. Never
      // "tools" on a guess: a model that cannot is offered tool calls and fails.
      capabilities: row.caps_known
        ? row.capabilities
        : (familyCapabilities(row.provider, row.provider_model) ?? lineCurrent?.capabilities ?? []),
      price: row.price ?? lineCurrent?.price ?? { input_per_mtok: 0, output_per_mtok: 0 },
      enabled: true,
      ...(sibling?.base_url && { base_url: sibling.base_url }),
      ...(sibling?.secret && { secret: sibling.secret }),
    });
  }

  /**
   * Keep a line on the model it answers with now. Without a saved choice a line
   * answers with the newest stable model you have, so adding a newer one would
   * move it by itself.
   */
  private async pin(lineId: string): Promise<void> {
    const reg = this.deps.registry;
    const state = reg.lineState(lineId);
    const cur = reg.currentOfLine(lineId);
    if (cur && state.current_id !== cur) await reg.saveLineState(lineId, { ...state, current_id: cur });
  }

  /** Make sure a model of a line is a registry model, adding it from the watch when it is not. */
  private async ensureModel(id: string, lineId: string): Promise<ModelConfig | null> {
    const reg = this.deps.registry;
    const have = reg.getExact(id);
    if (have) return have;
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    await this.pin(lineId);
    const cur = reg.currentOfLine(lineId);
    const config = this.configFor(row, cur ? reg.getExact(cur) : undefined);
    await reg.addFromWatch(config);
    await this.syncInCatalogue();
    return reg.getExact(id) ?? null;
  }

  private async syncInCatalogue(): Promise<void> {
    const next = this.rows
      .filter((r) => r.in_catalogue !== !!this.deps.registry.getExact(r.id))
      .map((r) => ({ ...r, in_catalogue: !!this.deps.registry.getExact(r.id) }));
    if (!next.length) return;
    await this.deps.store.upsert(next);
    this.rows = this.rows.map((r) => next.find((n) => n.id === r.id) ?? r);
    this.deps.registry.setWatch(this.rows);
  }

  private async moveLine(
    lineId: string,
    toId: string,
    reason: 'followed' | 'chosen' | 'back' | 'retired',
  ): Promise<void> {
    const reg = this.deps.registry;
    const state = reg.lineState(lineId);
    const from = reg.currentOfLine(lineId);
    await reg.saveLineState(lineId, {
      ...state,
      previous_id: from ?? state.previous_id,
      current_id: toId,
      pending: state.pending?.model_id === toId ? null : state.pending,
    });
    await this.record({
      kind: 'line_moved',
      model_id: toId,
      line_id: lineId,
      before: from,
      after: toId,
      reason,
    });
    log.info({ line: lineId, from, to: toId, reason }, 'a model line moved');
    await this.announce('line');
  }

  private async setPending(lineId: string, pending: LineState['pending']): Promise<void> {
    const state = this.deps.registry.lineState(lineId);
    await this.deps.registry.saveLineState(lineId, { ...state, pending });
  }

  /** The test call (GR16): a minimal real request, 30 s, through the normal gateway path. */
  private async test(config: ModelConfig): Promise<TestResult> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(TEST_CALL_TIMEOUT_MS)]);
    try {
      return await this.deps.testCall(config, signal);
    } catch (err) {
      log.warn({ model: config.id, err: (err as Error).name }, 'the test call threw');
      return { ok: false, detail: 'The test call did not finish.' };
    }
  }

  /** Decide, for every line of a provider (or all), whether it should move or offer a newer model. */
  async considerLines(provider?: string): Promise<boolean> {
    let moved = false;
    for (const line of this.deps.registry.lines()) {
      if (provider && line.provider !== provider) continue;
      moved = (await this.considerLine(line.id)) || moved;
    }
    return moved;
  }

  private async considerLine(lineId: string): Promise<boolean> {
    const reg = this.deps.registry;
    const g = reg.lineGroup(lineId);
    if (!g) return false;
    const state = reg.lineState(lineId);
    const curId = reg.currentOfLine(lineId);
    const current = g.members.find((m) => m.id === curId);
    if (!current) return false;

    // The provider retired the current model: move to the newest stable one.
    if (current.retired) {
      const target = newestStable(g.members.filter((m) => m.id !== current.id));
      if (!target) return false;
      const config = reg.getExact(target.id) ?? this.rowConfig(target.id, lineId);
      if (!config) return false;
      if (state.follow) {
        await this.setPending(lineId, {
          model_id: target.id,
          state: 'testing',
          detail: null,
          at: this.iso(),
        });
        const res = await this.test(config);
        if (!res.ok) {
          await this.setPending(lineId, {
            model_id: target.id,
            state: 'failed',
            detail: res.detail ?? 'The test call failed.',
            at: this.iso(),
          });
          await this.announce('line');
          return true;
        }
      }
      await this.ensureModel(target.id, lineId);
      await this.moveLine(lineId, target.id, 'retired');
      return true;
    }

    const latest = newestStable(g.members);
    if (!latest || latest.id === current.id || compareModels(latest, current) <= 0) {
      if (state.pending && state.pending.model_id !== curId && state.pending.state !== 'testing')
        await this.setPending(lineId, null);
      return false;
    }
    if (!state.follow) {
      if (state.pending?.model_id !== latest.id || state.pending.state !== 'offered')
        await this.setPending(lineId, {
          model_id: latest.id,
          state: 'offered',
          detail: null,
          at: this.iso(),
        });
      return false;
    }
    const config = reg.getExact(latest.id) ?? this.rowConfig(latest.id, lineId);
    if (!config) return false;
    await this.setPending(lineId, { model_id: latest.id, state: 'testing', detail: null, at: this.iso() });
    const res = await this.test(config);
    if (!res.ok) {
      await this.setPending(lineId, {
        model_id: latest.id,
        state: 'failed',
        detail: res.detail ?? 'The test call failed.',
        at: this.iso(),
      });
      await this.announce('line');
      return true;
    }
    await this.ensureModel(latest.id, lineId);
    await this.moveLine(lineId, latest.id, 'followed');
    return true;
  }

  private rowConfig(id: string, lineId: string): ModelConfig | null {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    const cur = this.deps.registry.currentOfLine(lineId);
    return this.configFor(row, cur ? this.deps.registry.getExact(cur) : undefined);
  }

  private lineOrThrow(lineId: string): ModelLine {
    const line = this.deps.registry.lines().find((l) => l.id === lineId);
    if (!line) throw notFound('That model line');
    return line;
  }

  /** PUT /models/lines/:provider/:line */
  async updateLine(lineId: string, update: ModelLineUpdate): Promise<ModelLine> {
    await this.load();
    const reg = this.deps.registry;
    const line = this.lineOrThrow(lineId);
    const g = reg.lineGroup(lineId);
    if (update.use !== undefined) {
      const wanted = update.use;
      if (!g?.members.some((m) => m.id === wanted)) throw lineModelWrong(wanted, line.name);
    }
    if (update.follow !== undefined) {
      const state = reg.lineState(lineId);
      await reg.saveLineState(lineId, {
        ...state,
        follow: update.follow,
        pending: update.follow ? state.pending : state.pending?.state === 'testing' ? null : state.pending,
      });
    }
    if (update.use !== undefined && update.use !== line.current_id) {
      await this.ensureModel(update.use, lineId);
      await this.moveLine(lineId, update.use, 'chosen');
    } else if (update.follow === true) {
      // Turning follow on tries a newer model now; the answer does not wait for the test call.
      const job = this.considerLine(lineId)
        .catch((err: unknown) => log.warn({ err }, 'following a line failed'))
        .finally(() => this.background.delete(job));
      this.background.add(job);
    }
    return this.lineOrThrow(lineId);
  }

  /** POST /models/lines/:provider/:line/back */
  async back(lineId: string): Promise<ModelLine> {
    await this.load();
    const reg = this.deps.registry;
    const line = this.lineOrThrow(lineId);
    if (!line.previous_id) throw noPrevious();
    const state = reg.lineState(lineId);
    const to = line.previous_id;
    const from = line.current_id;
    await reg.saveLineState(lineId, { ...state, current_id: to, previous_id: from, pending: null });
    await this.record({
      kind: 'line_moved',
      model_id: to,
      line_id: lineId,
      before: from,
      after: to,
      reason: 'back',
    });
    await this.announce('line');
    return this.lineOrThrow(lineId);
  }

  // ---- A key was saved, and models that turn out not to answer (F3a, F3c) ----

  /**
   * A key for this provider was saved: read its model list now, without waiting for the daily check,
   * then try its starter models once each. Returns at once. Saves in quick succession (setup, then
   * Settings) become one check, and a provider read in the last minute is not read again.
   */
  keySaved(provider: string): void {
    if (this.abort.signal.aborted || this.keyTimers.has(provider)) return;
    const h = this.timers.setTimeout(() => {
      this.keyTimers.delete(provider);
      const job = this.afterKey(provider)
        .catch((err: unknown) => log.warn({ err, provider }, 'the first model check after a key failed'))
        .finally(() => this.background.delete(job));
      this.background.add(job);
    }, this.deps.keyDelayMs ?? KEY_SAVED_DELAY_MS);
    this.keyTimers.set(provider, h);
  }

  private async afterKey(provider: string): Promise<void> {
    await this.load();
    const reg = this.deps.registry;
    // A new key may open what the old one could not: forget what was refused for this provider.
    await reg.clearUnavailable(
      reg
        .all()
        .filter((m) => m.provider === provider)
        .map((m) => m.id),
    );
    const target = (await this.targets()).find((t) => t.provider === provider);
    if (!target) return;
    const last = this.checks[provider];
    const recent =
      last?.ok && last.attempt_at && this.now() - Date.parse(last.attempt_at) < MANUAL_MIN_GAP_MS;
    if (!recent) {
      const run = this.queue.then(() => this.runTargets([target]));
      this.queue = run.catch(() => undefined);
      await run;
    }
    // One cheap model per line, never a dear one, and no more than a few: the lineup is large.
    const cap = provider === 'openrouter' ? TEST_CAP_OPENROUTER : TEST_CAP;
    for (const m of reg.testPicks(provider, isCheap, cap)) await this.verify(m);
  }

  // ---- Upgrading an install that already holds keys (once per lineup version) ----

  private upgradeTries = 0;

  /**
   * Installs that saved a key before a lineup shipped never got it (a lineup is switched on when a key is
   * saved). Once per LINEUP_VERSION: for every provider with a saved key, switch on its lineup, leaving
   * alone anything you turned off and turning nothing off; then try with one token each cheap model that
   * is on and was never tried (a few per provider, never a dear one), so a model the provider refuses
   * says so; then move a line off a model that turned out unavailable. A try that could not be read
   * (offline, a limit) is repeated on the next hourly check, up to three times.
   */
  async upgradeLineup(): Promise<'done' | 'again'> {
    const done = await this.deps.settings.get<number>(SETTING.lineupVersion);
    if (typeof done === 'number' && done >= LINEUP_VERSION) return 'done';
    const reg = this.deps.registry;
    await reg.refresh();
    const names = new Set(await this.deps.secrets.names());
    const providers = [
      ...new Set(
        reg
          .all()
          .filter((m) => {
            const need = m.via === 'direct' ? secretFor(m) : null;
            return need !== null && names.has(need);
          })
          .map((m) => m.provider),
      ),
    ];
    const on: Record<string, boolean> = {};
    for (const p of providers)
      for (const m of reg.lineup(p)) if (!reg.enabled(m) && !reg.turnedOff(m.id)) on[m.id] = true;
    if (Object.keys(on).length) await reg.setEnabled(on);
    const tested = await this.testedIds();
    let inconclusive = false;
    let changed = Object.keys(on).length > 0;
    for (const p of providers) {
      const cap = p === 'openrouter' ? TEST_CAP_OPENROUTER : TEST_CAP;
      const picks = new Map<string, ModelConfig>();
      for (const m of reg.testPicks(p, isCheap, cap)) picks.set(m.id, m);
      // Models you had on that the lineup does not pick (an older Gemini, a model you added).
      for (const m of reg.all())
        if (m.provider === p && reg.enabled(m) && isCheap(m) && m.via === 'direct') picks.set(m.id, m);
      const todo = [...picks.values()].filter((m) => !tested.has(m.id)).slice(0, cap + 2);
      for (const m of todo) {
        if (this.abort.signal.aborted) return 'again';
        const seen = await this.verify(m);
        if (seen === 'unknown') inconclusive = true;
        if (seen === 'refused') changed = true;
      }
    }
    await this.repointDeadLines();
    this.upgradeTries++;
    const finished = !inconclusive || this.upgradeTries >= 3;
    if (finished) await this.deps.settings.set(SETTING.lineupVersion, LINEUP_VERSION);
    if (changed) await this.announce('watch');
    return finished ? 'done' : 'again';
  }

  /** A line whose answering model the provider refused moves to the newest stable model of the line that can answer. */
  private async repointDeadLines(): Promise<void> {
    const reg = this.deps.registry;
    for (const line of reg.lines()) {
      const g = reg.lineGroup(line.id);
      const curId = line.current_id;
      const cur = curId ? reg.getExact(curId) : undefined;
      if (!g || !curId || !cur || reg.status(cur) !== 'unavailable') continue;
      const ready = (id: string) => {
        const c = reg.getExact(id);
        return !!c && reg.status(c) === 'ready';
      };
      const next = newestStable(g.members.filter((m) => m.have && m.id !== curId && ready(m.id)));
      if (next) await this.moveLine(line.id, next.id, 'retired');
    }
  }

  private testedCache: Record<string, string> | null = null;

  private async testedIds(): Promise<Set<string>> {
    this.testedCache ??= (await this.deps.settings.get<Record<string, string>>(SETTING.modelTested)) ?? {};
    return new Set(Object.keys(this.testedCache));
  }

  private async noteTested(id: string): Promise<void> {
    await this.testedIds();
    this.testedCache = { ...this.testedCache, [id]: this.iso() };
    await this.deps.settings.set(SETTING.modelTested, this.testedCache);
  }

  /**
   * Try a model with one token. A cheap model only: a dear one is tried when the owner presses Test.
   * A permanent refusal that is about the model (gone, not offered to new users) marks it unavailable
   * with the provider's words, so no picker offers a model that cannot answer. Anything else (a rate
   * limit, an outage, a bad key) says nothing about the model and changes nothing.
   */
  async verify(model: ModelConfig): Promise<'ok' | 'refused' | 'unknown' | 'skipped'> {
    if (!isCheap(model)) return 'skipped';
    const res = await this.test(model);
    const reg = this.deps.registry;
    if (res.ok) {
      await reg.clearUnavailable([model.id]);
      await this.noteTested(model.id);
      return 'ok';
    }
    if (!res.refused) return 'unknown';
    log.warn({ model: model.id }, 'a provider refused a model for good');
    await reg.markUnavailable(model.id, res.refused, this.iso());
    await this.noteTested(model.id);
    await this.announce('watch');
    return 'refused';
  }

  // ---- Changes and adding ----

  async markSeen(ids: string[]): Promise<void> {
    await this.deps.store.markSeen(ids);
  }

  /** POST /models/watch/add */
  async add(modelId: string): Promise<ModelInfo> {
    await this.load();
    const reg = this.deps.registry;
    const row = this.rows.find((r) => r.id === modelId);
    if (!row) throw notFound('That model');
    if (!reg.getExact(modelId)) {
      if (row.line_id) await this.pin(row.line_id);
      const lineCur = row.line_id ? reg.currentOfLine(row.line_id) : null;
      await reg.addFromWatch(this.configFor(row, lineCur ? reg.getExact(lineCur) : undefined));
      await this.syncInCatalogue();
      // A line that had no model of yours starts on this one.
      if (row.line_id) await this.considerLine(row.line_id);
    }
    const info = reg.info().find((m) => m.id === modelId);
    if (!info) throw notFound('That model');
    // One cheap token tells whether it answers at all; the answer does not wait for it.
    const config = reg.getExact(modelId);
    if (config && isCheap(config)) {
      const job = this.verify(config)
        .catch((err: unknown) => log.warn({ err }, 'testing an added model failed'))
        .finally(() => this.background.delete(job));
      this.background.add(job);
    }
    return info;
  }

  // ---- Report ----

  async report(): Promise<ModelWatchReport> {
    await this.load();
    const reg = this.deps.registry;
    const targets = await this.targets();
    const providers: ProviderCheck[] = targets.map((t) => {
      const s = this.checks[t.provider];
      return {
        provider: t.provider,
        checked_at: s?.checked_at ?? null,
        ok: s ? s.ok : true,
        error_code: s?.ok === false ? s.error_code : null,
        error_title: s?.ok === false ? s.error_title : null,
        unsupported: t.kind === 'none' || !!s?.unsupported,
        next_at: t.kind === 'none' ? null : (s?.next_at ?? null),
        models: s?.models ?? 0,
      };
    });
    const bundledDate = this.deps.bundledPricesDate ?? null;
    const models: WatchedModel[] = this.rows.map((r) => {
      const { caps_known: _k, created_at: _c, missed: _m, line_name: _n, line_tier: _t, ...rest } = r;
      const cat = reg.getExact(r.id);
      const bundled = !r.price && cat && cat.provider !== 'fake';
      return {
        ...rest,
        in_catalogue: !!cat,
        ...(bundled && {
          price: cat.price,
          price_source: 'bundled' as const,
          price_checked_at: bundledDate,
        }),
      };
    });
    return {
      providers,
      lines: reg.lines(),
      models,
      changes: await this.deps.store.changes(),
      bundled_prices_date: bundledDate,
      openrouter_prices: await this.openrouterPrices(),
    };
  }
}
