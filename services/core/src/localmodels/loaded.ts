/**
 * ------------------------------------------------------------------
 *  Title    |  Loaded now: Ollama's models in memory
 *  Ref      |  ROADMAP LM1 · docs/models.md (Loaded now)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say which Ollama models are in memory, how much they
 *           |  use and when Ollama will let them go, and let you
 *           |  Unload one or Keep it loaded. Picking a model in the
 *           |  composer starts loading it, so the first message after
 *           |  a pause does not stall without a word.
 *  How      |  GET /api/ps lists what is loaded; an empty generate
 *           |  loads a model; keep_alive 0 unloads it and -1 keeps it
 *           |  until unloaded (Ollama's documented API, through the
 *           |  OllamaClient and packages/resilience). The list is
 *           |  cached for two seconds and a silent Ollama is
 *           |  remembered for five, so polling never stalls. A load
 *           |  runs in the background; a newer pick cancels an older
 *           |  load that has not finished.
 *  Note     |  Only models NVX Ancile lists (provider ollama) can be
 *           |  unloaded or kept from here; whatever else is loaded is
 *           |  shown and left alone. Ollama on another computer works
 *           |  the same, but its memory is not read. Nothing loads
 *           |  early on battery: the Cockpit does not ask.
 *           |  TODO(phase-0.1.1): Pro per-notebook keep-alive and
 *           |  context-length presets, with a memory forecast.
 * ------------------------------------------------------------------
 */

import { AncileError, type LoadedModel, type LoadedModelsView, type WarmResult } from '@nvx/contracts';
import { ollamaName } from '../gateway/ollama-discovery';
import type { ModelRegistry } from '../gateway/registry';
import { logFor } from '../obs/logger';
import type { HardwareProbe } from './hardware';
import { isLocalUrl, type OllamaClient } from './ollama';

const log = logFor('loaded-models');

export const VIEW_TTL_MS = 2_000;
export const SILENT_TTL_MS = 5_000;
/** Ollama says "until unloaded" with a date centuries away. */
const FOREVER_MS = 100 * 365 * 86_400_000;
/** Loaded models above this share of memory leave no room for a second big one. */
const CROWDED = 0.8;

export interface LoadedModelsDeps {
  ollama: OllamaClient;
  registry: Pick<ModelRegistry, 'all'>;
  probe?: Pick<HardwareProbe, 'totalmem'>;
  now?: () => number;
}

const notManaged = (name: string) =>
  new AncileError({
    code: 'local_model.not_managed',
    title: `${name} was not loaded by NVX Ancile`,
    hint: 'Only models listed in Admin → Models can be unloaded or kept here. Use Ollama itself for the rest.',
    status: 409,
    errorClass: 'permanent',
  });

const unreachable = () =>
  new AncileError({
    code: 'local_model.ollama_silent',
    title: 'Ollama is not answering',
    hint: 'Open Ollama (or run "ollama serve"), then try again.',
    status: 503,
    errorClass: 'transient',
    retryable: true,
  });

export class LoadedModels {
  private cache: { at: number; view: LoadedModelsView } | null = null;
  private inflight: Promise<LoadedModelsView> | null = null;
  private silentAt = 0;
  private readonly loads = new Map<string, AbortController>();

  constructor(private readonly deps: LoadedModelsDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private get local() {
    return isLocalUrl(this.deps.ollama.base);
  }

  /** The registry model behind an Ollama tag, if NVX Ancile lists one. */
  private known(tag: string) {
    const want = ollamaName(tag);
    return this.deps.registry
      .all()
      .find((m) => m.provider === 'ollama' && m.via === 'direct' && ollamaName(m.provider_model) === want);
  }

  private forget() {
    this.cache = null;
    this.silentAt = 0;
  }

  /** What is loaded now. Never throws and never waits long: a silent Ollama is a state, not an error. */
  view(): Promise<LoadedModelsView> {
    const now = this.now();
    if (this.cache && now - this.cache.at < VIEW_TTL_MS) return Promise.resolve(this.cache.view);
    const empty = (state: LoadedModelsView['state']): LoadedModelsView => ({
      state,
      local: this.local,
      items: [],
      memory_bytes: this.local ? (this.deps.probe?.totalmem() ?? null) : null,
      crowded: false,
    });
    if (this.silentAt && now - this.silentAt < SILENT_TTL_MS) return Promise.resolve(empty('unreachable'));
    this.inflight ??= (async () => {
      try {
        const ps = await this.deps.ollama.ps();
        const memory = this.local ? (this.deps.probe?.totalmem() ?? null) : null;
        const items: LoadedModel[] = ps.models.map((m) => {
          const known = this.known(m.name);
          const expires = m.expires_at ? Date.parse(m.expires_at) : Number.NaN;
          const forever = Number.isFinite(expires) && expires - this.now() > FOREVER_MS;
          return {
            name: m.name,
            model_id: known?.id ?? null,
            display_name: known?.display_name ?? m.name,
            size_bytes: Math.round(m.size),
            vram_bytes: Math.round(m.size_vram),
            expires_at: forever || !Number.isFinite(expires) ? null : new Date(expires).toISOString(),
            keep_loaded: forever,
            managed: !!known,
          };
        });
        const used = items.reduce((n, i) => n + i.size_bytes, 0);
        const view: LoadedModelsView = {
          state: ps.supported ? 'ok' : 'too_old',
          local: this.local,
          items,
          memory_bytes: memory,
          crowded: memory !== null && memory > 0 && used > memory * CROWDED,
        };
        this.cache = { at: this.now(), view };
        this.silentAt = 0;
        return view;
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'Ollama did not say what is loaded');
        this.silentAt = this.now();
        return empty('unreachable');
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Unload a model NVX Ancile lists; Ollama frees its memory at once. */
  async unload(name: string): Promise<LoadedModelsView> {
    if (!this.known(name)) throw notManaged(name);
    this.loads.get(ollamaName(name))?.abort(new Error('unloading'));
    try {
      await this.deps.ollama.load(name, { keepAlive: 0 });
    } catch (err) {
      log.warn({ err: (err as Error).message, model: name }, 'could not unload');
      throw unreachable();
    }
    this.forget();
    log.info({ model: name }, 'unloaded');
    return this.view();
  }

  /** Keep a model loaded until you unload it, or let Ollama's own timer take it back. */
  async keep(name: string, keep: boolean): Promise<LoadedModelsView> {
    if (!this.known(name)) throw notManaged(name);
    try {
      await this.deps.ollama.load(name, { keepAlive: keep ? -1 : '5m' });
    } catch (err) {
      log.warn({ err: (err as Error).message, model: name }, 'could not change keep-alive');
      throw unreachable();
    }
    this.forget();
    log.info({ model: name, keep }, 'keep-alive changed');
    return this.view();
  }

  /**
   * Start loading the model you just picked, and answer at once. A model that is not Ollama's
   * (a cloud model, a GPU node) is skipped; one already loaded is left alone; a newer pick cancels
   * an older load that has not finished.
   */
  async warm(modelId: string): Promise<WarmResult> {
    const m = this.deps.registry.all().find((x) => x.id === modelId);
    if (m?.provider !== 'ollama' || m.via !== 'direct' || m.base_url) return { state: 'skipped', note: null };
    const tag = m.provider_model;
    const key = ollamaName(tag);
    const current = await this.view();
    if (current.state === 'unreachable') return { state: 'skipped', note: null };
    if (current.items.some((i) => ollamaName(i.name) === key)) return { state: 'loaded', note: null };
    if (this.loads.has(key)) return { state: 'loading', note: null };
    // Rapid switching: the older pick is no longer wanted.
    for (const [k, c] of this.loads) {
      c.abort(new Error('superseded'));
      this.loads.delete(k);
    }
    const others = current.items.filter((i) => ollamaName(i.name) !== key);
    let note: string | null = null;
    if (others.length && current.crowded)
      note = `${m.display_name} may not fit beside ${others.map((o) => o.display_name).join(' and ')}: Ollama will unload one to make room.`;
    const ctrl = new AbortController();
    this.loads.set(key, ctrl);
    void this.deps.ollama
      .load(tag, { signal: ctrl.signal })
      .then(() => log.info({ model: tag }, 'warmed'))
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) log.warn({ err: (err as Error).message, model: tag }, 'could not warm');
      })
      .finally(() => {
        if (this.loads.get(key) === ctrl) this.loads.delete(key);
        this.forget();
      });
    return { state: 'loading', note };
  }

  /** Models being loaded right now, by Ollama tag (tests, shutdown). */
  pending(): string[] {
    return [...this.loads.keys()];
  }

  stop(): void {
    for (const c of this.loads.values()) c.abort(new Error('stopping'));
    this.loads.clear();
  }
}
