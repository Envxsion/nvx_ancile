/**
 * ------------------------------------------------------------------
 *  Title    |  OpenRouter service
 *  Ref      |  docs/openrouter.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Hold routing choices per model, notebook and thread,
 *           |  decide which one applies to a call, and build the
 *           |  `provider` object the gateway sends.
 *  How      |  A flow step's own routing wins, then the thread's, the
 *           |  notebook's, the model's, then Recommended. Choices live
 *           |  in core.settings (openrouter.routing.<scope>.<id>).
 *           |  Endpoint lists come from EndpointsCache; this person's
 *           |  usage mix is read at most every ten minutes.
 * ------------------------------------------------------------------
 */

import {
  type CostEstimate,
  type CostEstimateRequest,
  type ModelConfig,
  OPENROUTER_AUTO,
  type OpenRouterFile,
  type RoutingPreview,
  type RoutingPreviewRequest,
  type RoutingScope,
  RoutingSettings,
  type UsageHistory,
} from '@nvx/contracts';
import type { ModelRequest } from '../gateway/types';
import type { SettingsStore } from '../settings';
import { estimateCost, mixFor } from './cost';
import { baseModel, type EndpointsCache, type Need } from './endpoints';
import { buildRouting } from './routing';

const KEY = (scope: RoutingScope, id: string) => `openrouter.routing.${scope}.${id}`;
const HISTORY_MS = 10 * 60_000;

/** Rough tokens in a request: four characters a token, plus a little per message. */
export function estimateTokens(req: Pick<ModelRequest, 'system' | 'messages' | 'tools'>): number {
  let chars = req.system?.length ?? 0;
  for (const m of req.messages) chars += m.content.length + 16;
  for (const t of req.tools ?? []) chars += t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / 4);
}

export class OpenRouterService {
  private history: { at: number; value: UsageHistory } | null = null;

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      endpoints: EndpointsCache;
      config: () => OpenRouterFile | null;
      models: (id: string) => ModelConfig | undefined;
      usageHistory?: () => Promise<UsageHistory>;
      planUsed?: () => Promise<{ known: boolean; percent: number | null }>;
      now?: () => number;
    },
  ) {}

  get endpoints(): EndpointsCache {
    return this.deps.endpoints;
  }

  async getOverride(scope: RoutingScope, id: string): Promise<RoutingSettings | null> {
    const raw = await this.deps.settings.get<unknown>(KEY(scope, id));
    if (raw === undefined) return null;
    const p = RoutingSettings.safeParse(raw);
    return p.success ? p.data : null;
  }

  async setOverride(scope: RoutingScope, id: string, settings: RoutingSettings | null): Promise<void> {
    await this.deps.settings.set(KEY(scope, id), settings);
  }

  /** The choice that applies: flow step, thread, notebook, model, else Recommended. */
  async resolve(q: {
    modelId: string;
    threadId?: string | undefined;
    notebookId?: string | null | undefined;
    explicit?: RoutingSettings | undefined;
  }): Promise<RoutingSettings> {
    if (q.explicit) return q.explicit;
    if (q.threadId) {
      const t = await this.getOverride('thread', q.threadId);
      if (t) return t;
    }
    if (q.notebookId) {
      const n = await this.getOverride('notebook', q.notebookId);
      if (n) return n;
    }
    return (await this.getOverride('model', q.modelId)) ?? RoutingSettings.parse({});
  }

  async usage(): Promise<UsageHistory | null> {
    if (!this.deps.usageHistory) return null;
    const now = (this.deps.now ?? Date.now)();
    if (this.history && now - this.history.at < HISTORY_MS) return this.history.value;
    const value = await this.deps.usageHistory().catch(() => null);
    if (value) this.history = { at: now, value };
    return value;
  }

  private trusted(slug: string): string[] {
    return this.deps.config()?.trusted.find((t) => t.model === slug)?.providers ?? [];
  }

  async preview(r: RoutingPreviewRequest, modelId?: string): Promise<RoutingPreview> {
    const slug = baseModel(r.model);
    const report = slug === OPENROUTER_AUTO ? null : await this.deps.endpoints.tryReport(slug, r.need);
    const m = modelId ? this.deps.models(modelId) : undefined;
    return buildRouting({
      model: r.model,
      settings: r.settings,
      endpoints: report?.endpoints ?? null,
      need: r.need,
      modelMaxOutput: m?.max_output ?? null,
      trusted: this.trusted(slug),
      history: mixFor(await this.usage(), modelId ?? r.model),
    });
  }

  /**
   * For the gateway: the provider object and max_tokens for one call to an
   * OpenRouter model; null for every other provider.
   */
  async forCall(m: ModelConfig, req: ModelRequest): Promise<RoutingPreview | null> {
    if (m.provider !== 'openrouter' || m.via === 'controller') return null;
    const settings = await this.resolve({
      modelId: m.id,
      threadId: req.meta?.threadId,
      notebookId: req.meta?.notebookId,
      explicit: req.routing,
    });
    const need: Need = {
      context: estimateTokens(req),
      output: req.maxOutputTokens ?? 0,
      tools: !!req.tools?.length,
    };
    const slug = baseModel(m.provider_model);
    // openrouter/auto chooses the model itself: only the general fields apply.
    const report = slug === OPENROUTER_AUTO ? null : await this.deps.endpoints.tryReport(slug, need);
    return buildRouting({
      model: m.provider_model,
      settings: req.maxOutputTokens
        ? { ...settings, max_tokens: settings.max_tokens ?? req.maxOutputTokens }
        : settings,
      endpoints: report?.endpoints ?? null,
      need,
      modelMaxOutput: m.max_output,
      trusted: this.trusted(slug),
      history: settings.preset === 'lowest_cost' ? mixFor(await this.usage(), m.id) : null,
    });
  }

  async estimate(r: CostEstimateRequest, modelId?: string): Promise<CostEstimate> {
    const report = await this.deps.endpoints.report(r.model);
    const plan = (await this.deps.planUsed?.().catch(() => null)) ?? { known: false, percent: null };
    return estimateCost(r, report, {
      history: await this.usage(),
      ...(modelId && { modelId }),
      planKnown: plan.known,
      planUsedPercent: plan.percent,
    });
  }
}
