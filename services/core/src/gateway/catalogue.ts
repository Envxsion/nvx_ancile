/**
 * ------------------------------------------------------------------
 *  Title    |  Model catalogues
 *  Ref      |  DESIGN.md §16.7 · Settings → Models
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What a source can offer before you add it: OpenRouter's
 *           |  whole catalogue (prices, context, capabilities filled in)
 *           |  or the models any OpenAI-compatible server lists.
 *  How      |  Fetches go through tracedFetch with retry; OpenRouter's
 *           |  public list is cached for ten minutes. Parsing is pure
 *           |  (toCatalogue*), so tests use recorded fixtures and never
 *           |  touch the network.
 *  Note     |  A key given for an endpoint is used for the listing
 *           |  only; storing it is the registry's job.
 * ------------------------------------------------------------------
 */

import type { CatalogueModel } from '@nvx/contracts';
import { ClassifiedError, retry } from '@nvx/resilience';
import { tracedFetch } from '../context';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_MS = 10 * 60_000;

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number | null;
  pricing?: { prompt?: string | number; completion?: string | number };
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  architecture?: { input_modalities?: string[]; modality?: string };
  supported_parameters?: string[];
}

/** "anthropic/claude-opus-5" → "anthropic"; a model with no slash is its own family. */
export const familyOf = (providerModel: string) =>
  (providerModel.split('/')[0] ?? providerModel).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'other';

/** OpenRouter prices are USD per token, as strings. */
const perMtok = (v: string | number | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : 0;
};

export function toCatalogueFromOpenRouter(body: unknown, added: Set<string>): CatalogueModel[] {
  const data = (body as { data?: OpenRouterModel[] })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m) => typeof m?.id === 'string' && m.id)
    .map((m) => {
      const caps: string[] = [];
      const params = m.supported_parameters ?? [];
      if (params.includes('tools')) caps.push('tools');
      if (params.includes('reasoning') || params.includes('include_reasoning')) caps.push('reasoning');
      if (params.includes('response_format') || params.includes('structured_outputs')) caps.push('json');
      const inputs = m.architecture?.input_modalities ?? [];
      if (inputs.includes('image') || (m.architecture?.modality ?? '').includes('image')) caps.push('vision');
      if (inputs.includes('audio')) caps.push('audio');
      const ctx = m.top_provider?.context_length ?? m.context_length ?? null;
      return {
        provider_model: m.id,
        display_name: m.name?.trim() || m.id,
        context_window: ctx && ctx > 0 ? Math.floor(ctx) : null,
        max_output: m.top_provider?.max_completion_tokens ?? null,
        price: m.pricing
          ? { input_per_mtok: perMtok(m.pricing.prompt), output_per_mtok: perMtok(m.pricing.completion) }
          : null,
        capabilities: caps,
        family: familyOf(m.id),
        description: m.description ? m.description.slice(0, 400) : null,
        added: added.has(m.id),
      };
    });
}

/** An OpenAI-compatible /v1/models listing: ids only, sometimes with a context length (vLLM). */
export function toCatalogueFromEndpoint(body: unknown, added: Set<string>): CatalogueModel[] {
  const data = (body as { data?: { id?: string; max_model_len?: number; owned_by?: string }[] })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m) => typeof m?.id === 'string' && m.id)
    .map((m) => ({
      provider_model: m.id as string,
      display_name: m.id as string,
      context_window: m.max_model_len && m.max_model_len > 0 ? m.max_model_len : null,
      max_output: null,
      price: null,
      capabilities: [],
      family: familyOf(m.owned_by && m.owned_by !== 'vllm' ? `${m.owned_by}/x` : (m.id as string)),
      description: null,
      added: added.has(m.id as string),
    }));
}

export function filterCatalogue(items: CatalogueModel[], q: string | undefined): CatalogueModel[] {
  const terms = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((m) => {
    const hay = `${m.provider_model} ${m.display_name} ${m.description ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

async function getJson(url: string, key?: string): Promise<unknown> {
  return retry(
    async () => {
      const res = await tracedFetch(url, {
        headers: { accept: 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok)
        throw new ClassifiedError(
          res.status >= 500 || res.status === 429 ? 'transient' : 'permanent',
          `${new URL(url).host} answered ${res.status}`,
          { status: res.status },
        );
      return res.json();
    },
    { maxAttempts: 3, capMs: 2_000 },
  );
}

export interface CatalogueSource {
  openRouter(): Promise<unknown>;
  endpoint(baseUrl: string, key?: string): Promise<unknown>;
}

let cached: { at: number; body: unknown } | null = null;

/** The real sources: OpenRouter's public catalogue (cached) and any endpoint's /models. */
export const liveCatalogue: CatalogueSource = {
  async openRouter() {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;
    const body = await getJson(OPENROUTER_MODELS_URL);
    cached = { at: Date.now(), body };
    return body;
  },
  async endpoint(baseUrl, key) {
    return getJson(`${baseUrl.replace(/\/+$/, '')}/models`, key);
  },
};
