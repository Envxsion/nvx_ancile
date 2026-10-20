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
  CLAUDE_CODE_PROVIDER,
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
  type Part,
  TIER_RANK,
  type Want,
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
import { compareModels, compareVersions, dateOf, lineOfModel } from '../models/watch/lines';
import type { StoredModel } from '../models/watch/store';
import { autoLimits } from '../openrouter/auto';
import type { SecretStore } from '../secrets';
import { SETTING, type SettingsStore } from '../settings';
import { billingOf, type ClaudeAuth, paidFromCredit } from './billing';
import { preferCreditFirst } from './credit-routing';
import {
  assertSendAllowed,
  estimateCallUsd,
  liveGuardActive,
  modelAllowedInTestProfile,
  reserveLive,
  sendGuardActive,
  settleLive,
  testProfileActive,
} from './e2e-guard';
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
import { type ChainSpec, chainFor, NoRouteError, noDearerThan, resolveChain } from './router';
import {
  assignTier,
  defaultWantFor,
  resolveWant,
  standInCost,
  type TierAssignment,
  type WantContext,
  type WantResolution,
} from './tiers';
import type { ModelClient, ModelRequest, StreamChunk } from './types';
import { priceOf } from './usage';

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

/** A thing a turn needs a model to be able to do (a ModelConfig capability). */
export type Need = ModelConfig['capabilities'][number];

/** How many models outside a class's chain a failing pinned model may fall back to. */
const MAX_EXTRA_FALLBACKS = 4;

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
  /** F3c: models a provider refused for good on a test call, with its reason. */
  private unavailable: Record<string, { reason: string; at: string }> = {};
  /** MD2: per keyed provider, one current model of each tier (fast, balanced, best), from the live list when it has one. */
  private starters = new Set<string>();
  /** Chip hues chosen for config models. */
  private hues: Record<string, ModelHue> = {};
  /** Tiers you chose in Admin → Models (TR2). */
  private tierPins: Record<string, ModelTier> = {};
  /** Chains saved in Admin → Routing, held here so chain() never reads the database. */
  private savedChains: Record<string, string[]> = {};
  /** Ids that models.yaml (and the offline set) ship: a model you added under one of these ids is shadowed by it. */
  private readonly configIds: Set<string>;
  /** Ids of the models you added (Settings → Models), merged in on refresh. */
  private customIds = new Set<string>();
  /** Every id this process has listed, so a later "not found" can tell removed from never existed. */
  private everSeen = new Set<string>();
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
    this.configIds = new Set(this.models.map((m) => m.id));
  }

  /** Re-read which keys exist and which models were switched on. Cheap; call after any change. */
  async refresh(): Promise<void> {
    this.noteSeen();
    const secretNames = new Set(await this.opts.secrets.names());
    let overrides = (await this.opts.settings.get<Record<string, boolean>>(SETTING.modelEnabled)) ?? {};
    const hues = (await this.opts.settings.get<Record<string, ModelHue>>(SETTING.modelHue)) ?? {};
    const tierPins = (await this.opts.settings.get<Record<string, ModelTier>>(SETTING.modelTier)) ?? {};
    const shown = (await this.opts.settings.get<Record<string, boolean>>(SETTING.modelShown)) ?? {};
    let custom = (await this.opts.settings.get<unknown[]>(SETTING.customModels)) ?? [];
    const absorbed = await this.absorbShadowed(custom, overrides);
    if (absorbed) ({ custom, overrides } = absorbed);
    const chains = (await this.opts.settings.get<Record<string, string[]>>(SETTING.routingChains)) ?? {};
    const lineStates = (await this.opts.settings.get<Record<string, LineState>>(SETTING.modelLines)) ?? {};
    const watchAdded = (await this.opts.settings.get<string[]>(SETTING.watchAdded)) ?? [];
    const unavailable =
      (await this.opts.settings.get<Record<string, { reason: string; at: string }>>(
        SETTING.modelUnavailable,
      )) ?? {};
    await this.lookAtOllama();
    // Applied together, with nothing awaited in between, so chain() never sees half a refresh.
    this.secretNames = secretNames;
    this.overrides = overrides;
    this.shown = shown;
    this.unavailable = unavailable;
    this.hues = hues;
    this.tierPins = tierPins;
    this.savedChains = chains;
    this.lineStates = lineStates;
    this.watchAdded = new Set(watchAdded);
    this.mergeCustom(custom);
    this.syncDiscovered();
    this.recompute();
  }

  /**
   * A model you added whose id models.yaml now ships too (the starters a release adds): the shipped one
   * wins, so the added copy would vanish along with the on/off choice stored in it. Carry that choice
   * over to the on/off store (a choice already there stands), then drop the copy, so nothing you decided
   * is lost and the copy never comes back. Returns the lists to use now, or null when nothing was shadowed.
   * Its colour is kept under the id already; a name or window you edited gives way to the shipped one.
   */
  private async absorbShadowed(
    raw: unknown[],
    overrides: Record<string, boolean>,
  ): Promise<{ custom: unknown[]; overrides: Record<string, boolean> } | null> {
    const shadowed: { id: string; enabled: boolean }[] = [];
    const keep: unknown[] = [];
    for (const r of raw) {
      const id = (r as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && this.configIds.has(id)) {
        const enabled = (r as { enabled?: unknown }).enabled;
        shadowed.push({ id, enabled: typeof enabled === 'boolean' ? enabled : true });
      } else keep.push(r);
    }
    if (!shadowed.length) return null;
    const next = { ...overrides };
    for (const x of shadowed) if (!(x.id in next)) next[x.id] = x.enabled;
    await this.opts.settings.set(SETTING.modelEnabled, next);
    await this.opts.settings.set(SETTING.customModels, keep);
    const gone = new Set(shadowed.map((x) => x.id));
    const added = (await this.opts.settings.get<string[]>(SETTING.watchAdded)) ?? [];
    if (added.some((id) => gone.has(id)))
      await this.opts.settings.set(
        SETTING.watchAdded,
        added.filter((id) => !gone.has(id)),
      );
    return { custom: keep, overrides: next };
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
      const l = lineOfModel(m);
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

  private noteSeen(): void {
    for (const m of this.models) this.everSeen.add(m.id);
  }

  /**
   * True when this id was in the list once, or something you saved still names it
   * (an on/off switch, a colour, a saved chain): it was removed or renamed.
   * False: nothing here ever had that id (a typo, or a model from another install).
   * The memory is per process, so after a restart a removed model with nothing
   * saved about it reads as unknown.
   */
  wasKnown(id: string): boolean {
    return (
      this.everSeen.has(id) ||
      id in this.overrides ||
      id in this.hues ||
      Object.values(this.savedChains).some((ids) => ids.includes(id))
    );
  }

  /**
   * Phase 5: the models your GPU nodes serve, read from the Controller
   * (compute/bridge.ts). They replace the previous set; configured models
   * are never touched.
   */
  setNodeModels(models: ModelConfig[]): void {
    this.noteSeen();
    for (let i = this.models.length - 1; i >= 0; i--)
      if (this.models[i]?.provider === NODE_PROVIDER) this.models.splice(i, 1);
    this.models.push(...models.map((m) => ({ ...m, provider: NODE_PROVIDER, via: 'controller' as const })));
  }

  /**
   * Models an engine provides by itself (Claude Code's, when it is installed):
   * they replace that provider's previous set; configured models are never touched.
   */
  setProviderModels(provider: string, models: ModelConfig[]): void {
    this.noteSeen();
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

  /** You switched this model off yourself (an on/off choice of false, not just a file that ships it off). */
  turnedOff(id: string): boolean {
    return this.overrides[id] === false;
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
    if (this.unavailable[m.id]) return 'unavailable';
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

  /** Is this one of its provider's starter models (MD2)? */
  isStarter(id: string): boolean {
    return this.starters.has(id);
  }

  /** F3c: a provider refused this model for good. It is skipped, and says why, until a test passes. */
  async markUnavailable(id: string, reason: string, at: string): Promise<void> {
    await this.saveUnavailable({ ...this.unavailable, [id]: { reason, at } });
  }

  /** Forget a refusal (a passing test, or a new key for its provider). Nothing to do when there is none. */
  async clearUnavailable(ids: string[]): Promise<void> {
    if (!ids.some((id) => this.unavailable[id])) return;
    const next = { ...this.unavailable };
    for (const id of ids) delete next[id];
    await this.saveUnavailable(next);
  }

  unavailableReason(id: string): string | null {
    return this.unavailable[id]?.reason ?? null;
  }

  private async saveUnavailable(next: Record<string, { reason: string; at: string }>): Promise<void> {
    await this.opts.settings.set(SETTING.modelUnavailable, next);
    this.unavailable = next;
  }

  /** Save that a model of a keyed provider is shown (or hidden) beyond the starter three. */
  async setShown(id: string, shown: boolean): Promise<void> {
    const next = { ...((await this.opts.settings.get<Record<string, boolean>>(SETTING.modelShown)) ?? {}) };
    next[id] = shown;
    await this.opts.settings.set(SETTING.modelShown, next);
    this.shown = next;
  }

  /**
   * The lineup of every keyed provider: each line's current model and the generation before it. The
   * current generation is the newest stable version in the line (every model of it, so a size or a
   * variant beside it comes too); the previous is the next version down. A preview joins only a line
   * that has no stable model. Retired and deprecated models step aside, so a provider whose live list
   * has been read starts from what it still serves; with no live list yet, this is the bundled list
   * (config/models.yaml, dated by prices_as_of). A provider none of whose models belong to a line is
   * ranked by price instead: the dearest, the cheapest and the one between. Models beyond the lineup
   * wait behind "Add more models".
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
      const info = list.map((m) => ({ m, line: lineOfModel(m) }));
      const withLines = info.filter((x) => x.line);
      if (withLines.length) {
        const byLine = new Map<string, typeof withLines>();
        for (const x of withLines) {
          const id = x.line?.line_id ?? '';
          byLine.set(id, [...(byLine.get(id) ?? []), x]);
        }
        for (const members of byLine.values()) {
          const stable = members.filter((x) => !x.line?.preview);
          const pool = stable.length ? stable : members;
          const versions: (string | null)[] = [];
          for (const x of [...pool].sort((a, b) => compareVersions(b.line?.version, a.line?.version))) {
            const v = x.line?.version ?? null;
            if (!versions.some((seen) => compareVersions(seen, v) === 0)) versions.push(v);
          }
          const keep = versions.slice(0, 2);
          for (const x of pool)
            if (keep.some((v) => compareVersions(v, x.line?.version) === 0)) out.add(x.m.id);
        }
      } else {
        const byPrice = [...list].sort(
          (a, b) =>
            b.price.output_per_mtok - a.price.output_per_mtok ||
            b.price.input_per_mtok - a.price.input_per_mtok,
        );
        const best = byPrice[0];
        const fast = byPrice[byPrice.length - 1];
        const mid = byPrice[Math.floor((byPrice.length - 1) / 2)];
        const tiers = new Set<ModelConfig>();
        if (best) tiers.add(best);
        if (fast) tiers.add(fast);
        if (mid) tiers.add(mid);
        for (const m of tiers) out.add(m.id);
      }
    }
    this.starters = out;
  }

  /** A provider's lineup (MD2): the models its key switches on and Settings lists, in config order. */
  lineup(provider: string): ModelConfig[] {
    return this.models.filter((m) => m.provider === provider && this.starters.has(m.id));
  }

  /**
   * The few lineup models worth one token each when a key is saved: one cheap model per line (the one
   * its line answers with, else the first), never a dear one, and at most `cap` for the provider. A
   * provider with no lines is tried the same way, one model at a time up to the cap.
   */
  testPicks(provider: string, isCheap: (m: ModelConfig) => boolean, cap: number): ModelConfig[] {
    const isCurrent = (m: ModelConfig) =>
      Number(this.currentOfLine(this.lineByModel.get(m.id) ?? '') === m.id);
    const ranked = [...this.lineup(provider)].sort((a, b) => isCurrent(b) - isCurrent(a));
    const picks: ModelConfig[] = [];
    const seen = new Set<string>();
    for (const m of ranked) {
      if (!isCheap(m)) continue;
      const key = this.lineByModel.get(m.id) ?? `model:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(m);
    }
    return picks.slice(0, cap);
  }

  /** A previous generation: its line answers with a newer version, so pickers fold it. */
  private isOlder(id: string, lineId: string | undefined): boolean {
    const g = lineId ? this.groups.get(lineId) : undefined;
    if (!g) return false;
    const curId = currentOf(g, this.lineStates[g.id]);
    if (!curId || curId === id) return false;
    const mine = g.members.find((x) => x.id === id);
    const cur = g.members.find((x) => x.id === curId);
    return !!mine && !!cur && compareModels(mine, cur) < 0;
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
      ...(this.unavailable[m.id] && { unavailable_reason: this.unavailable[m.id]?.reason }),
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
      ...(m.line?.company && { company: m.line.company }),
      ...(this.isOlder(m.id, lineId) && { older: true }),
      lifecycle: this.lifecycleOf(m.id),
      ...this.tierAssignment(m),
      // EN1: the efforts the provider's profile lets this model take; absent when none.
      ...(effortLevels(m).length > 0 && { effort_levels: [...effortLevels(m)] }),
    };
  }

  /** The tier of a model and where it came from: your choice, its line, its size, its price, or nothing. */
  tierAssignment(m: ModelConfig): { tier: ModelTier; tier_source: TierAssignment['source'] } {
    const a = assignTier(m, this.tierPins[m.id]);
    return { tier: a.tier, tier_source: a.source };
  }

  tierOf(m: ModelConfig): ModelTier {
    return assignTier(m, this.tierPins[m.id]).tier;
  }

  /** Pin a model's tier (Admin → Models); null goes back to the one worked out for it. */
  async setTier(id: string, tier: ModelTier | null): Promise<void> {
    const next = { ...((await this.opts.settings.get<Record<string, ModelTier>>(SETTING.modelTier)) ?? {}) };
    if (tier) next[id] = tier;
    else delete next[id];
    await this.opts.settings.set(SETTING.modelTier, next);
    await this.refresh();
  }

  /**
   * Every model that could answer a chat turn right now: ready and able to chat. The offline try-out
   * models are here only while no real model can answer, the same rule chain() keeps.
   */
  readyChat(): ModelConfig[] {
    const ready = this.models.filter((m) => this.status(m) === 'ready' && canChat(m));
    const real = ready.filter(
      (m) => m.provider !== 'fake' && !(testProfileActive() && modelAllowedInTestProfile(m)),
    );
    return (real.length ? real : ready).map((m) => ({ ...m, enabled: true }));
  }

  /**
   * Every ready chat model no dearer than `pinned` that can do what the turn needs, to stand in when a
   * pinned model fails. Same or lower tier first, then cheapest first. A tier above the pinned one comes
   * after, so a cheaper but stronger model is a last resort rather than a surprise.
   */
  cheaperThan(
    pinned: ModelConfig,
    opts: {
      named?: ReadonlySet<string>;
      exclude?: ReadonlySet<string>;
      needs?: readonly Need[];
      ctxTokens?: number;
    } = {},
  ): ModelConfig[] {
    const named = opts.named ?? new Set<string>();
    const rank = (m: ModelConfig) => TIER_RANK[this.tierOf(m)];
    const mine = rank(pinned);
    return this.readyChat()
      .filter(
        (m) =>
          m.id !== pinned.id &&
          !opts.exclude?.has(m.id) &&
          noDearerThan(pinned, m, named) &&
          (opts.needs ?? []).every((n) => m.capabilities.includes(n)) &&
          (!opts.ctxTokens || m.context_window >= opts.ctxTokens),
      )
      .sort(
        (a, b) =>
          Number(rank(a) > mine) - Number(rank(b) > mine) ||
          standInCost(a) - standInCost(b) ||
          a.id.localeCompare(b.id),
      );
  }

  /**
   * The best ready models for a need (TR1), in the order to try them. Never fails for lack of a
   * listed model: it widens and says how (`degraded`); only when no chat model is ready does it throw
   * routing.no_chat_model.
   */
  resolveWant(want: Want, ctx: Omit<WantContext, 'tierOf'> = {}): WantResolution {
    return resolveWant(want, this.readyChat(), { ...ctx, tierOf: (m) => this.tierOf(m) });
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
  chain(
    taskClass: string,
    explicit?: string | null,
    opts: { generatorFamily?: string; needs?: readonly Need[]; ctxTokens?: number } = {},
  ): ModelConfig[] {
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
      (m) => m.provider !== 'fake' && canChat(m) && !(testProfileActive() && modelAllowedInTestProfile(m)),
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
    // LT1: in a live test run a model asked for by name answers alone. No chain behind it, so a failure
    // stays that model's failure instead of moving the call (and the bill) to another one.
    if (liveGuardActive() && explicit) {
      const only = usable ? ready.get(usable) : undefined;
      if (!only) throw new NoRouteError(taskClass);
      return [only];
    }
    // What the person themselves put in a chain for this class (or the one it falls back to).
    const named = new Set<string>();
    for (let tc = taskClass; ; ) {
      for (const id of this.savedChains[tc] ?? []) named.add(id);
      const i = tc.lastIndexOf('.');
      if (i < 0) break;
      tc = tc.slice(0, i);
    }
    for (const id of this.savedChains['chat.default'] ?? []) named.add(id);
    // TR1: a class that says what it wants gets the best ready model for it, behind its pins. It fails
    // only when no chat model is ready at all.
    const spec = chainFor(classes, taskClass);
    const want =
      (spec && !Array.isArray(spec) ? spec.want : undefined) ?? defaultWantFor(taskClass) ?? undefined;
    let out: ModelConfig[];
    if (want) {
      let pins: ModelConfig[] = [];
      try {
        pins = resolveChain(
          {
            taskClass,
            explicit: usable ?? undefined,
            generatorFamily: opts.generatorFamily,
            namedByPerson: named,
          },
          classes,
          ready,
        );
      } catch (err) {
        if (!(err instanceof NoRouteError)) throw err;
      }
      const found = this.resolveWant(want, {
        generatorFamily: opts.generatorFamily,
        pins,
      }).chain;
      const first = usable ? ready.get(usable) : undefined;
      const rest = first ? found.filter((m) => m.id === first.id || noDearerThan(first, m, named)) : found;
      out = [...pins, ...rest.filter((m) => !pins.some((p) => p.id === m.id))];
      if (out.length === 0) throw new NoRouteError(taskClass);
    } else {
      out = resolveChain(
        {
          taskClass,
          explicit: usable ?? undefined,
          generatorFamily: opts.generatorFamily,
          namedByPerson: named,
        },
        classes,
        ready,
      );
    }
    // A pinned model that fails falls back to any ready model no dearer than it, not only the ones this
    // class names: the cheaper models outside the chain come last, cheapest first.
    const pinnedModel = usable ? ready.get(usable) : undefined;
    if (pinnedModel && out[0]?.id === pinnedModel.id) {
      const extra = this.cheaperThan(pinnedModel, {
        named,
        exclude: new Set(out.map((m) => m.id)),
        ...(opts.needs && { needs: opts.needs }),
        ...(opts.ctxTokens && { ctxTokens: opts.ctxTokens }),
      });
      out = [...out, ...extra.slice(0, MAX_EXTRA_FALLBACKS)];
    }
    // RT1: late in the cycle, with credit left, a model paid from the credit goes ahead of an equal one.
    return this.credit.first
      ? preferCreditFirst(out, (m) => paidFromCredit(m, this.credit.enabled), usable ? 1 : 0)
      : out;
  }
}

/**
 * LT1: add up what a live run's calls billed (billed_usd, else the list price), so the cap holds. A call
 * that ends without a finish chunk is counted at its estimate when it had started to answer, else at nothing.
 */
async function* tallyLive(
  m: ModelConfig,
  req: ModelRequest,
  inner: AsyncIterable<StreamChunk>,
  reserved: number,
): AsyncGenerator<StreamChunk> {
  let billed: number | null = null;
  let spoke = false;
  try {
    for await (const chunk of inner) {
      if (chunk.type === 'finish') billed = chunk.costUsd ?? priceOf(m, chunk.usage);
      else spoke = true;
      yield chunk;
    }
  } finally {
    settleLive(reserved, billed ?? (spoke ? estimateCallUsd(m, req) : 0));
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

  private streamGuarded(m: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    // The test profile's send guard (e2e-guard.ts): refused before any client, network or CLI is touched.
    // Thrown from inside the stream, so the gateway handles it like any other failure of that model.
    let reserved = 0;
    if (sendGuardActive()) {
      try {
        assertSendAllowed(m);
        // A live run (LT1) also keeps to its spending cap: the estimate is set aside before the call.
        reserved = reserveLive(m, estimateCallUsd(m, req));
      } catch (err) {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }) };
      }
    }
    const own = this.own.get(m.provider);
    const inner = own
      ? own.stream(m, req, signal)
      : (m.provider === 'fake' ? this.fake : this.sdk).stream(m, req, signal);
    return liveGuardActive() && m.provider !== 'fake' ? tallyLive(m, req, inner, reserved) : inner;
  }

  async *stream(m: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    // A model that cannot see pictures is told where one was, never left to guess from silence.
    const blind = m.provider === CLAUDE_CODE_PROVIDER || !m.capabilities.includes('vision');
    const unseen = blind ? withoutImages(req) : null;
    if (unseen?.names.length)
      yield {
        type: 'warning',
        code: 'image.not_shown',
        message: `Not shown to ${m.display_name}, which cannot see images: ${unseen.names.join(', ')}.`,
      };
    yield* this.streamGuarded(m, unseen?.req ?? req, signal);
  }
}

/**
 * Images in the conversation, as text a model without vision can read:
 * "[image: photo.png, not shown to this model]", plus the caption when there is one.
 * Returns the request unchanged (and no names) when it carries no image.
 */
export function withoutImages(req: ModelRequest): { req: ModelRequest; names: string[] } {
  const names: string[] = [];
  const messages = req.messages.map((msg) => {
    if (!msg.parts?.some((p) => p.type === 'image')) return msg;
    const parts = msg.parts.map((p): Part => {
      if (p.type !== 'image') return p;
      const name = p.alt?.trim() || 'untitled';
      if (!names.includes(name)) names.push(name);
      const caption = p.caption ? ` [Image, described: ${p.caption}]` : '';
      return {
        type: 'text',
        text: `
[image: ${name}, not shown to this model]${caption}
`,
      };
    });
    const extra = parts.flatMap((p, i) =>
      msg.parts?.[i]?.type === 'image' && p.type === 'text' ? [p.text] : [],
    );
    return { ...msg, parts, content: `${msg.content}${extra.join('')}` };
  });
  return { req: names.length ? { ...req, messages } : req, names };
}
