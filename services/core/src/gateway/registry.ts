/**
 * ------------------------------------------------------------------
 *  Title    |  Model registry
 *  Ref      |  DESIGN.md §7.2, config/models.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Which models exist, which can answer right now, and in
 *           |  what order to try them. A model is ready when it is
 *           |  enabled and its key is in the encrypted store; a model
 *           |  without its key is skipped by routing, never tried and
 *           |  failed, so a fresh install with one key just works.
 *  How      |  Config models, plus the offline test models when the
 *           |  dev stack asks for them. Enable overrides (set when a
 *           |  key passes its test in onboarding) live in settings, so
 *           |  the YAML a person wrote is never rewritten.
 *           |  RoutingClient sends `fake` models to the FakeProvider
 *           |  and everything else through the AI SDK.
 * ------------------------------------------------------------------
 */

import { ModelConfig, type ModelInfo } from '@nvx/contracts';
import type { SecretStore } from '../secrets';
import { SETTING, type SettingsStore } from '../settings';
import { OFFLINE_MODELS } from './fake';
import { DEFAULT_SECRET } from './providers';
import { type ChainSpec, resolveChain } from './router';
import type { ModelClient, ModelRequest, StreamChunk } from './types';

export interface RegistryOptions {
  models: ModelConfig[];
  taskClasses: Record<string, ChainSpec>;
  secrets: SecretStore;
  settings: SettingsStore;
  /** Serve the offline test models (dev stack, e2e, no keys yet). */
  offline: boolean;
}

/** The secret a model needs, or null when it needs none (Ollama, local, offline). */
/** Embedding and rerank models are listed for settings, but never answer a chat turn. */
export const canChat = (m: Pick<ModelConfig, 'capabilities'>) =>
  !m.capabilities.some((c) => c === 'embeddings' || c === 'rerank');

export function secretFor(m: ModelConfig): string | null {
  if (m.via === 'controller' || m.provider === 'fake' || m.provider === 'local' || m.provider === 'ollama')
    return null;
  return m.secret ?? DEFAULT_SECRET[m.provider] ?? null;
}

/** The provider name for models discovered on your GPU nodes. */
export const NODE_PROVIDER = 'node';

export class ModelRegistry {
  private readonly models: ModelConfig[];
  private secretNames = new Set<string>();
  private overrides: Record<string, boolean> = {};
  /** Ids of the models you added (Settings → Models), merged in on refresh. */
  private customIds = new Set<string>();

  constructor(private readonly opts: RegistryOptions) {
    this.models = [...opts.models, ...(opts.offline ? OFFLINE_MODELS : [])];
  }

  /** Re-read which keys exist and which models were switched on. Cheap; call after any change. */
  async refresh(): Promise<void> {
    this.secretNames = new Set(await this.opts.secrets.names());
    this.overrides = (await this.opts.settings.get<Record<string, boolean>>(SETTING.modelEnabled)) ?? {};
    this.mergeCustom((await this.opts.settings.get<unknown[]>(SETTING.customModels)) ?? []);
  }

  /** Replace the added models with this set; anything that no longer parses is skipped. */
  private mergeCustom(raw: unknown[]): void {
    for (let i = this.models.length - 1; i >= 0; i--)
      if (this.customIds.has(this.models[i]?.id ?? '')) this.models.splice(i, 1);
    this.customIds = new Set();
    for (const r of raw) {
      const p = ModelConfig.safeParse(r);
      if (!p.success || this.models.some((m) => m.id === p.data.id)) continue;
      this.models.push(p.data);
      this.customIds.add(p.data.id);
    }
  }

  isCustom(id: string): boolean {
    return this.customIds.has(id);
  }

  /** The models you added, as stored. */
  custom(): ModelConfig[] {
    return this.models.filter((m) => this.customIds.has(m.id));
  }

  /** Store the added models and take them into the registry at once. */
  async saveCustom(models: ModelConfig[]): Promise<void> {
    await this.opts.settings.set(SETTING.customModels, models);
    await this.refresh();
  }

  get offline(): boolean {
    return this.opts.offline;
  }

  get(id: string): ModelConfig | undefined {
    return this.models.find((m) => m.id === id);
  }

  /**
   * Phase 5: the models your GPU nodes serve, read from the Controller
   * (compute/bridge.ts). They replace the previous set; configured models
   * are never touched.
   */
  setNodeModels(models: ModelConfig[]): void {
    for (let i = this.models.length - 1; i >= 0; i--)
      if (this.models[i]?.provider === NODE_PROVIDER) this.models.splice(i, 1);
    this.models.push(...models.map((m) => ({ ...m, provider: NODE_PROVIDER, via: 'controller' as const })));
  }

  all(): ModelConfig[] {
    return this.models;
  }

  enabled(m: ModelConfig): boolean {
    return this.overrides[m.id] ?? m.enabled;
  }

  status(m: ModelConfig): ModelInfo['status'] {
    if (!this.enabled(m)) return 'disabled';
    const secret = secretFor(m);
    if (secret && !this.secretNames.has(secret)) return 'needs_key';
    return 'ready';
  }

  info(): ModelInfo[] {
    return this.models.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      provider: m.provider,
      family: m.family,
      via: m.via,
      context_window: m.context_window,
      max_output: m.max_output,
      capabilities: m.capabilities,
      price: { input_per_mtok: m.price.input_per_mtok, output_per_mtok: m.price.output_per_mtok },
      status: this.status(m),
      secret: secretFor(m),
      offline: m.provider === 'fake',
      ...(this.customIds.has(m.id) && { custom: true, base_url: m.base_url ?? null }),
    }));
  }

  async setEnabled(updates: Record<string, boolean>): Promise<void> {
    const next = {
      ...((await this.opts.settings.get<Record<string, boolean>>(SETTING.modelEnabled)) ?? {}),
      ...updates,
    };
    await this.opts.settings.set(SETTING.modelEnabled, next);
    await this.refresh();
  }

  /**
   * The ordered chain for a turn. An explicit choice goes first when it can
   * answer (and is a chat model). The offline models close every chat chain in the dev stack, so
   * a turn with no keys configured still gets an answer and says which.
   */
  chain(taskClass: string, explicit?: string | null, opts: { generatorFamily?: string } = {}): ModelConfig[] {
    const ready = new Map(
      this.models
        .filter((m) => this.status(m) === 'ready')
        .map((m) => [m.id, { ...m, enabled: true }] as const),
    );
    const classes = { ...this.opts.taskClasses };
    if (this.opts.offline) {
      for (const [tc, spec] of Object.entries(classes)) {
        if (!tc.startsWith('chat') && tc !== 'utility' && !tc.startsWith('factcheck')) continue;
        const ids = Array.isArray(spec) ? spec : spec.chain;
        const withOffline = [...ids, ...OFFLINE_MODELS.map((m) => m.id)];
        classes[tc] = Array.isArray(spec) ? withOffline : { ...spec, chain: withOffline };
      }
      classes['chat.default'] ??= OFFLINE_MODELS.map((m) => m.id);
    }
    const chosen = explicit ? this.models.find((m) => m.id === explicit) : undefined;
    const usable = chosen && canChat(chosen) ? explicit : undefined;
    return resolveChain(
      { taskClass, explicit: usable ?? undefined, generatorFamily: opts.generatorFamily },
      classes,
      ready,
    );
  }
}

/** One ModelClient over several: the fake provider for `fake`, the AI SDK for the rest. */
export class RoutingClient implements ModelClient {
  constructor(
    private readonly sdk: ModelClient,
    private readonly fake: ModelClient,
  ) {}

  stream(m: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    return (m.provider === 'fake' ? this.fake : this.sdk).stream(m, req, signal);
  }
}
