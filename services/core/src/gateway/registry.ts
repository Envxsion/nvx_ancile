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
 *           |  dev stack asks for them, plus the chat models Ollama has
 *           |  pulled that nothing else serves (ollama-discovery.ts),
 *           |  found on the same look that checks which Ollama models
 *           |  are there. Enable overrides (set when a
 *           |  key passes its test in onboarding) live in settings, so
 *           |  the YAML a person wrote is never rewritten. Chains saved
 *           |  in Admin → Routing live there too and win over the YAML;
 *           |  refresh() caches them, so chain() stays synchronous.
 *           |  RoutingClient sends `fake` models to the FakeProvider
 *           |  and everything else through the AI SDK.
 *           |  Model lines (MD4): `<provider>/<line>:latest` ids resolve
 *           |  to the line's current model, and a retired model's id to
 *           |  its line's current model; get() and chain() do it, so
 *           |  every place that checks a model id accepts an alias, and
 *           |  an answer records the concrete model. The model watch
 *           |  hands live prices, windows and abilities to setWatch(),
 *           |  laid over the bundled values without touching the YAML.
 * ------------------------------------------------------------------
 */

import {
  isCreditModel,
  isLineAlias,
  lineAlias,
  lineOfAlias,
  type ModelBilling,
  ModelConfig,
  type ModelHue,
  type ModelInfo,
  type ModelLine,
  type ModelTier,
} from '@nvx/contracts';
import {
  currentOf,
  emptyState,
  groupLines,
  type LineGroup,
  type LineState,
  lineReport,
  type Member,
  newestStable,
} from '../models/watch/linebook';
import { dateOf, lineFor } from '../models/watch/lines';
import type { StoredModel } from '../models/watch/store';
import { autoLimits } from '../openrouter/auto';
import type { SecretStore } from '../secrets';
import { SETTING, type SettingsStore } from '../settings';
import { billingOf, type ClaudeAuth, paidFromCredit } from './billing';
import { preferCreditFirst } from './credit-routing';
import { assertSendAllowed, modelAllowedInTestProfile, sendGuardActive } from './e2e-guard';
import { effortLevels } from './effort';
import { OFFLINE_MODELS } from './fake';
import {
  discoveredModel,
  isChatModel,
  type OllamaModelFacts,
  ollamaName,
  servedByOllama,
} from './ollama-discovery';
import { DEFAULT_SECRET } from './providers';
import { type ChainSpec, chainFor, resolveChain } from './router';
import type { ModelClient, ModelRequest, StreamChunk } from './types';

export interface RegistryOptions {
  models: ModelConfig[];
  taskClasses: Record<string, ChainSpec>;
  secrets: SecretStore;
  settings: SettingsStore;
  /** Serve the offline test models (dev stack, e2e, no keys yet). */
  offline: boolean;
  /** The models Ollama has pulled (its /api/tags names), or null when it cannot be asked. */
  ollamaTags?: () => Promise<string[] | null>;
  /**
   * What Ollama says one pulled model can do (POST /api/show), asked once per
   * newly pulled name. Absent: discovered models are judged by name, with no
   * tools and a modest window (gateway/ollama-discovery.ts).
   */
  ollamaFacts?: (name: string) => Promise<OllamaModelFacts | null>;
}

/** How long Ollama's list of pulled models is trusted before refresh() asks again. */
export const OLLAMA_TAGS_TTL_MS = 30_000;

export { ollamaName } from './ollama-discovery';

/** The secret a model needs, or null when it needs none (Ollama, local, offline). */
/** Embedding and rerank models are listed for settings, but never answer a chat turn. */
export const canChat = (m: Pick<ModelConfig, 'capabilities'>) =>
  !m.capabilities.some((c) => c === 'embeddings' || c === 'rerank');

export function secretFor(m: ModelConfig): string | null {
  if (m.via === 'controller' || m.provider === 'fake' || m.provider === 'local' || m.provider === 'ollama')
    return null;
  return m.secret ?? DEFAULT_SECRET[m.provider] ?? null;
}

/** Classes Knowledge runs on this computer (fastembed); they are not edited in Admin → Routing. */
const LOCAL_CLASSES = new Set(['embed', 'rerank']);

/** A model Ollama on this computer serves (not one on a GPU node, nor another endpoint). */
const isLocalOllama = (m: ModelConfig) => m.provider === 'ollama' && m.via === 'direct' && !m.base_url;

/** The provider name for models discovered on your GPU nodes. */
export const NODE_PROVIDER = 'node';

/** What a model id turned into: the model that answers, and how. */
export interface Resolved {
  model: ModelConfig;
  requested: string;
  via: 'exact' | 'alias' | 'retired';
  /** For a retired model: the sentence to show. */
  note: string | null;
}

export class ModelRegistry {
  private readonly models: ModelConfig[];
  /** Saved per line: follow, current, previous, pending. */
  private lineStates: Record<string, LineState> = {};
  /** Ids of models added from the watch. */
  private watchAdded = new Set<string>();
  /** What the watch saw, by model id. */
  private watch = new Map<string, StoredModel>();
  /** The model objects the watch's live values were laid over, back to the originals. */
  private readonly overlaid = new WeakMap<ModelConfig, { orig: ModelConfig; version: number }>();
  private overlayVersion = 0;
  private groups = new Map<string, LineGroup>();
  private lineByModel = new Map<string, string>();
  private secretNames = new Set<string>();
  private overrides: Record<string, boolean> = {};
  /** MD2: models you showed or hid beyond a provider's starter three. */
  private shown: Record<string, boolean> = {};
  /** MD2: per keyed provider, one current model of each tier (fast, balanced, best), from the live list when it has one. */
  private starters = new Set<string>();
  /** Chip hues chosen for config models. */
  private hues: Record<string, ModelHue> = {};
  /** Chains saved in Admin → Routing, held here so chain() never reads the database. */
  private savedChains: Record<string, string[]> = {};
  /** Ids of the models you added (Settings → Models), merged in on refresh. */
  private customIds = new Set<string>();
  /**
   * What Ollama has pulled, once it has answered: a model it does not have
   * cannot answer. Null until it first answers; a later silence keeps the
   * last answer (a slow probe is not an empty Ollama).
   */
  private ollamaPulled: Set<string> | null = null;
  /** The pulled names as Ollama lists them, for discovery. */
  private ollamaListed: string[] | null = null;
  /** What Ollama said about each pulled model, by `name:tag`. */
  private readonly ollamaKnown = new Map<string, OllamaModelFacts>();
  private ollamaAt = 0;
  /** The models found in Ollama (ollama/<name>), and their ids; replaced on every refresh. */
  private discovered: ModelConfig[] = [];
  private discoveredIds = new Set<string>();
  /** What Claude Code says about its sign-in; null until it has been asked. */
  private claudeAuth: ClaudeAuth | null = null;
  /** CR1: the plan's monthly API credit. enabled: the Anthropic key draws on it. exhausted: Anthropic said it is gone. first: RT1's goal is on now. */
  private credit = { enabled: false, exhausted: false, first: false };

  constructor(private readonly opts: RegistryOptions) {
    // openrouter/auto is planned for at its smallest plausible window (openrouter/auto.ts).
    this.models = [...opts.models, ...(opts.offline ? OFFLINE_MODELS : [])].map((m) => autoLimits(m));
  }

  /** Re-read which keys exist and which models were switched on. Cheap; call after any change. */
  async refresh(): Promise<void> {
    const secretNames = new Set(await this.opts.secrets.names());
    const overrides = (await this.opts.settings.get<Record<string, boolean>>(SETTING.modelEnabled)) ?? {};
    const hues = (await this.opts.settings.get<Record<string, ModelHue>>(SETTING.modelHue)) ?? {};
    const shown = (await this.opts.settings.get<Record<string, boolean>>(SETTING.modelShown)) ?? {};
    const custom = (await this.opts.settings.get<unknown[]>(SETTING.customModels)) ?? [];
    const chains = (await this.opts.settings.get<Record<string, string[]>>(SETTING.routingChains)) ?? {};
    const lineStates = (await this.opts.settings.get<Record<string, LineState>>(SETTING.modelLines)) ?? {};
    const watchAdded = (await this.opts.settings.get<string[]>(SETTING.watchAdded)) ?? [];
    await this.lookAtOllama();
    // Applied together, with nothing awaited in between, so chain() never sees half a refresh.
    this.secretNames = secretNames;
    this.overrides = overrides;
    this.shown = shown;
    this.hues = hues;
    this.savedChains = chains;
    this.lineStates = lineStates;
    this.watchAdded = new Set(watchAdded);
    this.mergeCustom(custom);
    this.syncDiscovered();
    this.recompute();
  }

  /** Ask Ollama what it has pulled (and about anything new), at most every OLLAMA_TAGS_TTL_MS. */
  private async lookAtOllama(force = false): Promise<void> {
    const look = this.opts.ollamaTags;
    if (!look) return;
    const now = Date.now();
    if (!force && now - this.ollamaAt < OLLAMA_TAGS_TTL_MS) return;
    this.ollamaAt = now;
    const names = await look().catch(() => null);
    if (!names) return;
    const listed = [...new Set(names.filter(Boolean))];
    const tags = new Set(listed.map(ollamaName));
    for (const t of [...this.ollamaKnown.keys()]) if (!tags.has(t)) this.ollamaKnown.delete(t);
    const ask = this.opts.ollamaFacts;
    if (ask) {
      const fresh = listed.filter((n) => !this.ollamaKnown.has(ollamaName(n)));
      const said = await Promise.all(fresh.map((n) => ask(n).catch(() => null)));
      fresh.forEach((n, i) => {
        const f = said[i];
        if (f) this.ollamaKnown.set(ollamaName(n), f);
      });
    }
    this.ollamaListed = listed;
    this.ollamaPulled = tags;
  }

  /** A pull finished or Ollama came back: ask it again now. */
  async refreshOllama(): Promise<void> {
    await this.lookAtOllama(true);
    this.syncDiscovered();
  }

  /**
   * List Ollama's pulled chat models as ollama/<name>, replacing the previous
   * set: never an embedding model, and never a name a configured or added
   * model already serves. A model Ollama no longer has leaves the list.
   */
  private syncDiscovered(): void {
    // By identity: a model you added may have just taken the same id.
    const previous = new Set(this.discovered);
    for (let i = this.models.length - 1; i >= 0; i--)
      if (previous.has(this.models[i] as ModelConfig)) this.models.splice(i, 1);
    this.discovered = [];
    this.discoveredIds = new Set();
    if (!this.ollamaListed) return;
    const served = new Set(this.models.filter(servedByOllama).map((m) => ollamaName(m.provider_model)));
    for (const name of this.ollamaListed) {
      const tag = ollamaName(name);
      const facts = this.ollamaKnown.get(tag);
      if (served.has(tag) || !isChatModel(name, facts)) continue;
      const m = discoveredModel(name, facts);
      if (!m || this.models.some((x) => x.id === m.id)) continue;
      served.add(tag);
      this.models.push(m);
      this.discovered.push(m);
      this.discoveredIds.add(m.id);
    }
  }

  /** Found in Ollama rather than configured or added: it comes and goes with Ollama's own list. */
  isDiscovered(id: string): boolean {
    return this.discoveredIds.has(id);
  }

  /** Task classes you can edit in Admin → Routing: the YAML's chat-shaped classes, plus the three every install has. */
  taskClassNames(): string[] {
    const names = new Set(['chat.default', 'chat.deep', 'utility']);
    for (const tc of Object.keys(this.opts.taskClasses)) if (!LOCAL_CLASSES.has(tc)) names.add(tc);
    return [...names];
  }

  /** The chain config/routing.yaml gives this class (its own entry only, no parent fallback). */
  defaultChain(taskClass: string): string[] {
    const spec = this.opts.taskClasses[taskClass];
    return spec ? [...(Array.isArray(spec) ? spec : spec.chain)] : [];
  }

  /** Your saved order for this class, or undefined when the YAML applies. */
  savedChain(taskClass: string): string[] | undefined {
    const ids = this.savedChains[taskClass];
    return ids ? [...ids] : undefined;
  }

  /** Save an order for a class (null goes back to the YAML), then reload so the next chain() sees it. */
  async saveChain(taskClass: string, ids: string[] | null): Promise<void> {
    const next = {
      ...((await this.opts.settings.get<Record<string, string[]>>(SETTING.routingChains)) ?? {}),
    };
    if (ids) next[taskClass] = [...ids];
    else delete next[taskClass];
    await this.opts.settings.set(SETTING.routingChains, next);
    await this.refresh();
  }

  /**
   * Replace the added models with this set; anything that no longer parses is
   * skipped. An added model wins over one found in Ollama under the same id
   * (a one-click download saves its catalogue details that way).
   */
  private mergeCustom(raw: unknown[]): void {
    for (let i = this.models.length - 1; i >= 0; i--)
      if (this.customIds.has(this.models[i]?.id ?? '')) this.models.splice(i, 1);
    this.customIds = new Set();
    for (const r of raw) {
      const p = ModelConfig.safeParse(r);
      if (!p.success || this.models.some((m) => m.id === p.data.id && !this.discoveredIds.has(m.id)))
        continue;
      this.models.push(autoLimits(p.data));
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

  /** The model that answers to this id: a line's alias or a retired model's id turns into the current model. */
  get(id: string): ModelConfig | undefined {
    return this.resolve(id)?.model;
  }

  /** The model with exactly this id (for editing, removing and switching on or off). */
  getExact(id: string): ModelConfig | undefined {
    return this.models.find((m) => m.id === id);
  }

  resolve(id: string): Resolved | undefined {
    if (isLineAlias(id)) {
      const cur = this.currentOfLine(lineOfAlias(id));
      const model = cur ? this.getExact(cur) : undefined;
      return model ? { model, requested: id, via: 'alias', note: null } : undefined;
    }
    const model = this.getExact(id);
    if (!model) return undefined;
    if (this.lifecycleOf(id) === 'retired') {
      const lineId = this.lineByModel.get(id);
      const group = lineId ? this.groups.get(lineId) : undefined;
      if (lineId && group) {
        const cur = this.currentOfLine(lineId);
        let next = cur && cur !== id ? this.getExact(cur) : undefined;
        if (!next) {
          const n = newestStable(group.members.filter((m) => m.have && m.id !== id));
          next = n ? this.getExact(n.id) : undefined;
        }
        if (next)
          return {
            model: next,
            requested: id,
            via: 'retired',
            note: `${model.display_name} has been retired by its provider, so ${next.display_name} answers instead.`,
          };
      }
    }
    return { model, requested: id, via: 'exact', note: null };
  }

  // ---- Model lines and the watch (MD4, MD5) ----

  lifecycleOf(id: string): 'active' | 'deprecated' | 'retired' {
    return this.watch.get(id)?.lifecycle ?? 'active';
  }

  /** Model watch rows, as last handed over. */
  watched(): StoredModel[] {
    return [...this.watch.values()];
  }

  isFromWatch(id: string): boolean {
    return this.watchAdded.has(id);
  }

  lineIdOf(modelId: string): string | null {
    return this.lineByModel.get(modelId) ?? null;
  }

  /** What `<line>:latest` answers with now, or null. */
  currentOfLine(lineId: string): string | null {
    const g = this.groups.get(lineId);
    return g ? currentOf(g, this.lineStates[lineId]) : null;
  }

  lines(): ModelLine[] {
    return [...this.groups.values()].map((g) => lineReport(g, this.lineStates[g.id]));
  }

  lineGroup(lineId: string): LineGroup | undefined {
    return this.groups.get(lineId);
  }

  lineState(lineId: string): LineState {
    return { ...emptyState(), ...(this.lineStates[lineId] ?? {}) };
  }

  /** Save one line's state (null clears it) and take it in at once. */
  async saveLineState(lineId: string, state: LineState | null): Promise<void> {
    const next = {
      ...((await this.opts.settings.get<Record<string, LineState>>(SETTING.modelLines)) ?? {}),
    };
    if (state) next[lineId] = state;
    else delete next[lineId];
    await this.opts.settings.set(SETTING.modelLines, next);
    this.lineStates = next;
    this.recompute();
  }

  /**
   * The watch's rows: live prices, windows and abilities go over the models
   * you have, and models the watch knows of join their lines as offers.
   */
  setWatch(rows: StoredModel[]): void {
    this.watch = new Map(rows.map((r) => [r.id, r]));
    this.overlayVersion++;
    this.recompute();
  }

  /** Add a model the watch found (persisted with the added models; marked as from the watch). */
  async addFromWatch(config: ModelConfig): Promise<void> {
    const ids = [...new Set([...this.watchAdded, config.id])];
    await this.opts.settings.set(SETTING.watchAdded, ids);
    await this.saveCustom([...this.custom().filter((m) => m.id !== config.id), config]);
  }

  /** Lay the watch's live values over the models, then group the models into lines. */
  private recompute(): void {
    for (let i = 0; i < this.models.length; i++) {
      const cur = this.models[i] as ModelConfig;
      const was = this.overlaid.get(cur);
      if (was && was.version === this.overlayVersion) continue;
      const orig = was?.orig ?? cur;
      const row = this.watch.get(orig.id);
      const mine = !this.customIds.has(orig.id) || this.watchAdded.has(orig.id);
      let next = orig;
      if (row && mine && orig.provider !== 'fake') {
        let price =
          row.price && row.price_source && row.price_source !== 'bundled'
            ? { ...orig.price, ...row.price }
            : orig.price;
        // A live price that is lower than the off-peak rate shipped beside it (a list that already shows
        // the off-peak price) would make "off-peak" dearer than normal: keep the live price, drop the discount.
        if (
          price.off_peak &&
          (price.input_per_mtok < price.off_peak.input_per_mtok ||
            price.output_per_mtok < price.off_peak.output_per_mtok)
        )
          price = (({ off_peak: _dropped, ...rest }) => rest)(price);
        next = {
          ...orig,
          price,
          context_window: row.context_window ?? orig.context_window,
          max_output: row.max_output ?? orig.max_output,
          capabilities: row.caps_known && row.capabilities.length ? row.capabilities : orig.capabilities,
        };
      }
      if (next === orig && !was) continue;
      if (next !== orig) this.overlaid.set(next, { orig, version: this.overlayVersion });
      this.models[i] = next;
    }
    const members: Member[] = [];
    this.lineByModel = new Map();
    for (const m of this.models) {
      const l = lineFor(m.provider, m.base_url, m.provider_model);
      if (!l) continue;
      this.lineByModel.set(m.id, l.line_id);
      members.push({
        id: m.id,
        provider: m.provider,
        line_id: l.line_id,
        name: l.name,
        tier: l.tier,
        version: l.version,
        date: dateOf(m.provider_model),
        created: this.watch.get(m.id)?.created_at ?? null,
        preview: l.preview,
        retired: this.lifecycleOf(m.id) === 'retired',
        have: true,
      });
    }
    const have = new Set(members.map((m) => m.id));
    for (const r of this.watch.values()) {
      if (have.has(r.id) || !r.line_id || !r.line_name || !r.line_tier) continue;
      members.push({
        id: r.id,
        provider: r.provider,
        line_id: r.line_id,
        name: r.line_name,
        tier: r.line_tier,
        version: r.version,
        date: dateOf(r.provider_model),
        created: r.created_at,
        preview: r.preview,
        retired: r.lifecycle === 'retired',
        have: false,
      });
    }
    this.groups = groupLines(members);
    this.pickStarters();
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

  /**
   * Models an engine provides by itself (Claude Code's, when it is installed):
   * they replace that provider's previous set; configured models are never touched.
   */
  setProviderModels(provider: string, models: ModelConfig[]): void {
    for (let i = this.models.length - 1; i >= 0; i--)
      if (this.models[i]?.provider === provider) this.models.splice(i, 1);
    this.models.push(...models.map((m) => ({ ...m, provider })));
    this.recompute();
  }

  /** Tell the registry how Claude Code is signed in: its models are ready only while it is, and bill by it. */
  setClaudeAuth(auth: ClaudeAuth | null): void {
    this.claudeAuth = auth;
  }

  /** CR1: tell the registry about the plan's monthly API credit (gateway/credit.ts). Models paid from it appear, or step aside, at once. */
  setCredit(state: { enabled: boolean; exhausted: boolean; first: boolean }): void {
    this.credit = { ...state };
  }

  /** Who pays for a model, as it is now (roadmap WY1 keeps this with each answer). Null for an unknown id. */
  billingFor(id: string): ModelBilling | null {
    const m = this.get(id);
    return m ? billingOf(m, this.claudeAuth, this.credit.enabled) : null;
  }

  all(): ModelConfig[] {
    return this.models;
  }

  enabled(m: ModelConfig): boolean {
    return this.overrides[m.id] ?? m.enabled;
  }

  status(m: ModelConfig): ModelInfo['status'] {
    if (!this.enabled(m)) return 'disabled';
    // CR1: the monthly-credit variants exist only while the key is marked as drawing on it.
    if (isCreditModel(m.id) && !this.credit.enabled) return 'disabled';
    if (this.credit.exhausted && paidFromCredit(m, this.credit.enabled)) return 'credit_out';
    if (m.provider === 'claude_code' && !isCreditModel(m.id) && this.claudeAuth && !this.claudeAuth.signed_in)
      return 'signed_out';
    const secret = secretFor(m);
    if (secret && !this.secretNames.has(secret)) return 'needs_key';
    // Ollama's models answer only once Ollama has said it has them (never, while it has not answered).
    if (isLocalOllama(m) && this.opts.ollamaTags && !this.ollamaPulled?.has(ollamaName(m.provider_model)))
      return 'not_pulled';
    return 'ready';
  }

  /**
   * Why Settings does not list a model, or null when it does (MD2). Something real must stand
   * behind it: a provider's key is saved (then its starter three: one current model each of fast,
   * balanced and best, plus any you added with "Add more models"), Ollama has pulled it, a GPU
   * node serves it (or you switched a config node model on), Claude Code is signed in. Models you
   * added yourself are always listed.
   */
  unlistedReason(m: ModelConfig): NonNullable<ModelInfo['unlisted_reason']> | null {
    if (this.customIds.has(m.id)) return null;
    if (m.provider === 'fake') return null;
    if (m.provider === 'claude_code' && isCreditModel(m.id)) {
      const key = secretFor(m);
      return this.credit.enabled && (!key || this.secretNames.has(key)) ? null : 'no_key';
    }
    if (m.provider === 'claude_code') return this.claudeAuth?.signed_in === true ? null : 'signed_out';
    if (m.provider === NODE_PROVIDER) return null;
    if (m.provider === 'controller') return this.enabled(m) ? null : 'no_node';
    const secret = secretFor(m);
    if (secret && !this.secretNames.has(secret)) return 'no_key';
    if (isLocalOllama(m) && this.status(m) === 'not_pulled') return 'not_pulled';
    if (this.lifecycleOf(m.id) === 'retired') return 'retired';
    if (!secret) return null;
    const chosen = this.shown[m.id];
    if (chosen !== undefined) return chosen ? null : 'more';
    return this.starters.has(m.id) ? null : 'more';
  }

  listed(m: ModelConfig): boolean {
    return this.unlistedReason(m) === null;
  }

  /** Save that a model of a keyed provider is shown (or hidden) beyond the starter three. */
  async setShown(id: string, shown: boolean): Promise<void> {
    const next = { ...((await this.opts.settings.get<Record<string, boolean>>(SETTING.modelShown)) ?? {}) };
    next[id] = shown;
    await this.opts.settings.set(SETTING.modelShown, next);
    this.shown = next;
  }

  /**
   * One current model of each tier for every keyed provider. The tier is its line's (Opus is best,
   * Sonnet balanced, Haiku fast); a provider with no lines is ranked by price (dearest best, cheapest
   * fast). Retired and deprecated models and previews step aside, so a provider whose live list
   * has been read starts from what it still serves; with no live list yet, this is the bundled
   * list (config/models.yaml, dated by prices_as_of).
   */
  private pickStarters(): void {
    const byProvider = new Map<string, ModelConfig[]>();
    for (const m of this.models) {
      if (this.customIds.has(m.id) || !secretFor(m) || m.via !== 'direct' || !canChat(m)) continue;
      if (this.lifecycleOf(m.id) !== 'active') continue;
      const arr = byProvider.get(m.provider) ?? [];
      arr.push(m);
      byProvider.set(m.provider, arr);
    }
    const out = new Set<string>();
    for (const list of byProvider.values()) {
      const info = list.map((m) => ({ m, line: lineFor(m.provider, m.base_url, m.provider_model) }));
      const withLines = info.filter((x) => x.line && !x.line.preview);
      const tiers = new Map<ModelTier, ModelConfig>();
      if (withLines.length) {
        // Prefer the model its line answers with now, then the order of the config.
        const now = (x: (typeof withLines)[number]) =>
          Number(this.currentOfLine(x.line?.line_id ?? '') === x.m.id);
        const ranked = [...withLines].sort((a, b) => now(b) - now(a));
        for (const x of ranked) if (x.line && !tiers.has(x.line.tier)) tiers.set(x.line.tier, x.m);
      } else {
        const byPrice = [...list].sort(
          (a, b) =>
            b.price.output_per_mtok - a.price.output_per_mtok ||
            b.price.input_per_mtok - a.price.input_per_mtok,
        );
        const best = byPrice[0];
        const fast = byPrice[byPrice.length - 1];
        const mid = byPrice[Math.floor((byPrice.length - 1) / 2)];
        if (byPrice.length === 1 && best) tiers.set('balanced', best);
        else {
          if (best) tiers.set('best', best);
          if (fast && fast !== best) tiers.set('fast', fast);
          if (mid && mid !== best && mid !== fast) tiers.set('balanced', mid);
        }
      }
      for (const m of tiers.values()) out.add(m.id);
    }
    this.starters = out;
  }

  info(): ModelInfo[] {
    const concrete = this.models.map((m) => this.infoOf(m));
    const aliases: ModelInfo[] = [];
    for (const g of this.groups.values()) {
      const curId = currentOf(g, this.lineStates[g.id]);
      const cur = curId ? concrete.find((x) => x.id === curId) : undefined;
      if (!cur) continue;
      const { custom: _c, base_url: _b, ...rest } = cur;
      aliases.push({
        ...rest,
        id: lineAlias(g.id),
        display_name: g.name,
        alias_of: cur.id,
        line_id: g.id,
      });
    }
    return [...concrete, ...aliases];
  }

  private infoOf(m: ModelConfig): ModelInfo {
    const lineId = this.lineByModel.get(m.id);
    return {
      id: m.id,
      display_name: m.display_name,
      provider: m.provider,
      provider_model: m.provider_model,
      family: m.family,
      via: m.via,
      context_window: m.context_window,
      max_output: m.max_output,
      capabilities: m.capabilities,
      price: {
        input_per_mtok: m.price.input_per_mtok,
        output_per_mtok: m.price.output_per_mtok,
        ...(m.price.off_peak && { off_peak: m.price.off_peak }),
      },
      status: this.status(m),
      billing: billingOf(m, this.claudeAuth, this.credit.enabled),
      ...(this.credit.exhausted && paidFromCredit(m, this.credit.enabled) && { credit_exhausted: true }),
      listed: this.listed(m),
      ...(this.unlistedReason(m) && {
        unlisted_reason: this.unlistedReason(m) as NonNullable<ModelInfo['unlisted_reason']>,
      }),
      secret: secretFor(m),
      offline: m.provider === 'fake',
      ...(this.customIds.has(m.id) && { custom: true, base_url: m.base_url ?? null }),
      ...((this.hues[m.id] ?? m.hue) && { hue: this.hues[m.id] ?? m.hue }),
      ...(lineId && { line_id: lineId }),
      lifecycle: this.lifecycleOf(m.id),
      // EN1: the efforts the provider's profile lets this model take; absent when none.
      ...(effortLevels(m).length > 0 && { effort_levels: [...effortLevels(m)] }),
    };
  }

  /** Choose a config model's chip hue; null goes back to the family's. */
  async setHue(id: string, hue: ModelHue | null): Promise<void> {
    const next = { ...((await this.opts.settings.get<Record<string, ModelHue>>(SETTING.modelHue)) ?? {}) };
    if (hue) next[id] = hue;
    else delete next[id];
    await this.opts.settings.set(SETTING.modelHue, next);
    await this.refresh();
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
   * The models a task class is set to try, ready or not, with where each stands
   * (FC2: an error that says why a model was skipped needs the ones that were
   * set, not only the ones that could answer). Aliases show as the model now behind them.
   */
  configured(taskClass: string): { id: string; name: string; status: ModelInfo['status'] }[] {
    const saved = this.savedChains[taskClass];
    const spec = chainFor(this.opts.taskClasses, taskClass);
    const ids = saved ?? (spec ? (Array.isArray(spec) ? spec : spec.chain) : []);
    const out: { id: string; name: string; status: ModelInfo['status'] }[] = [];
    for (const id of ids) {
      const m = this.resolve(id)?.model ?? this.get(id);
      if (m && !out.some((o) => o.id === m.id))
        out.push({ id: m.id, name: m.display_name, status: this.status(m) });
    }
    return out;
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
    // A saved chain replaces the YAML's order; flags such as prefer_different_family stay.
    for (const [tc, ids] of Object.entries(this.savedChains)) {
      const spec = classes[tc];
      classes[tc] = spec && !Array.isArray(spec) ? { ...spec, chain: ids } : ids;
    }
    // The try-out models stand in only while no real model can answer. Once one
    // can, a failing model must fail visibly, never fall back to a model that
    // does not use AI (docs/models.md, Test models). Asked for by name, they still answer.
    // In the test profile the Controller is the fake one, so its sample nodes are try-out models too.
    const realReady = [...ready.values()].some(
      (m) => m.provider !== 'fake' && canChat(m) && !(sendGuardActive() && modelAllowedInTestProfile(m)),
    );
    if (this.opts.offline && !realReady) {
      for (const [tc, spec] of Object.entries(classes)) {
        if (!tc.startsWith('chat') && tc !== 'utility' && !tc.startsWith('factcheck')) continue;
        const ids = Array.isArray(spec) ? spec : spec.chain;
        const withOffline = [...ids, ...OFFLINE_MODELS.map((m) => m.id)];
        classes[tc] = Array.isArray(spec) ? withOffline : { ...spec, chain: withOffline };
      }
      classes['chat.default'] ??= OFFLINE_MODELS.map((m) => m.id);
    }
    // Aliases and retired ids turn into the models that answer for them.
    const concrete = (id: string) => this.resolve(id)?.model.id ?? id;
    for (const [tc, spec] of Object.entries(classes)) {
      classes[tc] = Array.isArray(spec) ? spec.map(concrete) : { ...spec, chain: spec.chain.map(concrete) };
    }
    const chosen = explicit ? this.resolve(explicit)?.model : undefined;
    const usable = chosen && canChat(chosen) ? chosen.id : undefined;
    const out = resolveChain(
      { taskClass, explicit: usable ?? undefined, generatorFamily: opts.generatorFamily },
      classes,
      ready,
    );
    // RT1: late in the cycle, with credit left, a model paid from the credit goes ahead of an equal one.
    return this.credit.first
      ? preferCreditFirst(out, (m) => paidFromCredit(m, this.credit.enabled), usable ? 1 : 0)
      : out;
  }
}

/** One ModelClient over several: the fake provider for `fake`, the AI SDK for the rest. */
export class RoutingClient implements ModelClient {
  /** Providers served by their own client (Claude Code as a model). */
  private readonly own = new Map<string, ModelClient>();

  constructor(
    private readonly sdk: ModelClient,
    private readonly fake: ModelClient,
  ) {}

  register(provider: string, client: ModelClient): void {
    this.own.set(provider, client);
  }

  stream(m: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    // The test profile's send guard (e2e-guard.ts): refused before any client, network or CLI is touched.
    // Thrown from inside the stream, so the gateway handles it like any other failure of that model.
    if (sendGuardActive()) {
      try {
        assertSendAllowed(m);
      } catch (err) {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }) };
      }
    }
    const own = this.own.get(m.provider);
    if (own) return own.stream(m, req, signal);
    return (m.provider === 'fake' ? this.fake : this.sdk).stream(m, req, signal);
  }
}
