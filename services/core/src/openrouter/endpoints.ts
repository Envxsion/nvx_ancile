/**
 * ------------------------------------------------------------------
 *  Title    |  OpenRouter endpoints
 *  Ref      |  docs/openrouter.md (Endpoint explorer)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every provider that serves one OpenRouter model, in
 *           |  plain columns (precision, context, max output, tools,
 *           |  prices, uptime), with what each one costs you in words.
 *  How      |  parseEndpoints() is pure over OpenRouter's
 *           |  /models/{id}/endpoints body, so tests use recorded
 *           |  fixtures. EndpointsCache keeps each model's list for the
 *           |  configured TTL and saves the last copy in settings, so
 *           |  the explorer and routing still work offline.
 *  Note     |  Precision is what OpenRouter reports; whether it is the
 *           |  lab's own comes from config/openrouter.yaml, else
 *           |  "unknown", said honestly.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type EndpointsReport,
  type EndpointWarning,
  OPENROUTER_AUTO,
  type OpenRouterFile,
  type OrEndpoint,
  OrQuantization,
  QUANT_BITS,
} from '@nvx/contracts';
import { ClassifiedError, retry } from '@nvx/resilience';
import { tracedFetch } from '../context';
import type { SettingsStore } from '../settings';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

interface RawEndpoint {
  provider_name?: string;
  tag?: string | null;
  quantization?: string | null;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  supported_parameters?: string[];
  pricing?: Record<string, string | number | undefined>;
  uptime_last_30m?: number | null;
  status?: number;
}

/** What the job needs, to judge each endpoint against. */
export interface Need {
  context: number;
  output: number;
  tools: boolean;
}

/** USD per token as a string → USD per million tokens. */
const perM = (v: string | number | undefined): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};

const fmt = (n: number) => n.toLocaleString('en-GB');

/** "openai/gpt-x:floor" → "openai/gpt-x". */
export const baseModel = (id: string) => id.replace(/:[a-z]+$/i, '');

/** The lab's own precision for a model, from config (exact id first, then the longest prefix). */
export function labPrecision(
  model: string,
  cfg: OpenRouterFile | null,
): OpenRouterFile['precision'][number] | null {
  const list = cfg?.precision ?? [];
  const exact = list.find((p) => p.model === model);
  if (exact) return exact;
  let best: OpenRouterFile['precision'][number] | null = null;
  for (const p of list)
    if (p.model.endsWith('*') && model.startsWith(p.model.slice(0, -1)))
      if (!best || p.model.length > best.model.length) best = p;
  return best;
}

export function warningsFor(
  e: Omit<OrEndpoint, 'warnings'>,
  need: Need | null,
  modelMaxOutput: number | null,
): EndpointWarning[] {
  const out: EndpointWarning[] = [];
  if (e.context_pct !== null && e.context_pct < 90)
    out.push({
      code: 'short_context',
      text: `This endpoint can only read ${Math.max(1, Math.round(e.context_pct))}% of what the model can.`,
    });
  else if (need && e.context !== null && need.context > e.context)
    out.push({
      code: 'short_context',
      text: `Too short for this job: it reads up to ${fmt(e.context)} tokens.`,
    });
  const outputCap = e.max_output;
  if (
    outputCap !== null &&
    ((modelMaxOutput !== null && outputCap < modelMaxOutput * 0.5) ||
      outputCap <= 8_192 ||
      (need && need.output > outputCap))
  )
    out.push({
      code: 'short_output',
      text: `Answers capped at ${fmt(outputCap)} tokens: reasoning will be cut off.`,
    });
  if (!e.tools) out.push({ code: 'no_tools', text: "Can't use tools." });
  if (e.original_precision === false)
    out.push({
      code: 'not_original_precision',
      text: `Runs at ${e.precision.toUpperCase()}, below the lab's own release.`,
    });
  if (e.precision === 'unknown')
    out.push({ code: 'unknown_precision', text: 'The provider does not say what precision it runs.' });
  if (e.uptime !== null && e.uptime < 95)
    out.push({
      code: 'low_uptime',
      text: `Answered ${Math.round(e.uptime)}% of requests in the last half hour.`,
    });
  if (e.price.cache_read === null && e.price.input > 0)
    out.push({ code: 'no_cache_price', text: 'No cache discount: repeated context is paid in full.' });
  return out;
}

export function parseEndpoints(
  body: unknown,
  cfg: OpenRouterFile | null,
  need: Need | null = null,
): Omit<EndpointsReport, 'fetched_at' | 'offline'> {
  const data = (body as { data?: { id?: string; name?: string; endpoints?: RawEndpoint[] } })?.data;
  const model = typeof data?.id === 'string' ? data.id : '';
  const raw = Array.isArray(data?.endpoints) ? data.endpoints : [];
  const lab = labPrecision(model, cfg);
  const largest = Math.max(0, ...raw.map((r) => r.context_length ?? 0));
  const native = lab?.context ?? (largest > 0 ? largest : null);
  const maxOut = Math.max(0, ...raw.map((r) => r.max_completion_tokens ?? 0)) || null;
  const endpoints = raw
    .filter((r) => typeof r.provider_name === 'string' && r.provider_name)
    .map((r) => {
      const q = OrQuantization.safeParse((r.quantization ?? 'unknown').toLowerCase());
      const precision = q.success ? q.data : 'unknown';
      const original =
        !lab || precision === 'unknown' ? null : QUANT_BITS[precision] >= QUANT_BITS[lab.precision];
      const ctx = r.context_length && r.context_length > 0 ? Math.floor(r.context_length) : null;
      const base: Omit<OrEndpoint, 'warnings'> = {
        provider: r.provider_name as string,
        tag: r.tag ?? null,
        precision,
        original_precision: original,
        context: ctx,
        context_pct: ctx && native ? Math.min(100, Math.round((ctx / native) * 1000) / 10) : null,
        max_output: r.max_completion_tokens && r.max_completion_tokens > 0 ? r.max_completion_tokens : null,
        tools: (r.supported_parameters ?? []).includes('tools'),
        price: {
          input: perM(r.pricing?.prompt) ?? 0,
          output: perM(r.pricing?.completion) ?? 0,
          cache_read: perM(r.pricing?.input_cache_read),
          cache_write: perM(r.pricing?.input_cache_write),
        },
        uptime: typeof r.uptime_last_30m === 'number' ? Math.max(0, Math.min(100, r.uptime_last_30m)) : null,
        supported_parameters: r.supported_parameters ?? [],
      };
      return { ...base, warnings: warningsFor(base, need, maxOut) };
    });
  return {
    model,
    name: data?.name ?? model,
    native_context: native,
    original_precision: lab ? { precision: lab.precision, source: lab.source } : null,
    endpoints,
  };
}

const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

export type FetchJson = (url: string) => Promise<unknown>;

/** The real fetch: through tracedFetch with retry, ten seconds a try. */
export const liveFetchJson: FetchJson = (url) =>
  retry(
    async () => {
      const res = await tracedFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok)
        throw new ClassifiedError(
          res.status >= 500 || res.status === 429 ? 'transient' : 'permanent',
          `openrouter.ai answered ${res.status}`,
          { status: res.status },
        );
      return res.json();
    },
    { maxAttempts: 3, capMs: 2_000 },
  );

const SETTING = (model: string) => `openrouter.endpoints.${model}`;

export class EndpointsCache {
  private mem = new Map<string, { at: number; body: unknown }>();

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      fetchJson?: FetchJson;
      config: () => OpenRouterFile | null;
      now?: () => number;
    },
  ) {}

  private get ttlMs() {
    return (this.deps.config()?.endpoints_ttl_minutes ?? 30) * 60_000;
  }

  /** The raw body: memory within the TTL, else OpenRouter, else the saved copy (offline). */
  private async body(model: string): Promise<{ at: number; body: unknown; offline: boolean }> {
    const now = (this.deps.now ?? Date.now)();
    const hit = this.mem.get(model);
    if (hit && now - hit.at < this.ttlMs) return { ...hit, offline: false };
    try {
      const body = await (this.deps.fetchJson ?? liveFetchJson)(
        `${OPENROUTER_API}/models/${model}/endpoints`,
      );
      this.mem.set(model, { at: now, body });
      await this.deps.settings.set(SETTING(model), { at: now, body }).catch(() => undefined);
      return { at: now, body, offline: false };
    } catch (err) {
      const saved = hit ?? (await this.deps.settings.get<{ at: number; body: unknown }>(SETTING(model)));
      if (saved) return { ...saved, offline: true };
      throw new AncileError({
        code: 'openrouter.endpoints_unavailable',
        title: "Could not read this model's providers from OpenRouter",
        hint: 'Check the connection and try again. Once read, the list is kept for when you are offline.',
        status: 502,
        errorClass: 'transient',
        retryable: true,
        cause: err,
      });
    }
  }

  async report(model: string, need: Need | null = null): Promise<EndpointsReport> {
    const id = baseModel(model);
    if (!MODEL_ID.test(id))
      throw new AncileError({
        code: 'openrouter.model_invalid',
        title: 'That is not an OpenRouter model id',
        hint: 'Use the form author/model, for example qwen/qwen3-coder.',
        status: 400,
        errorClass: 'permanent',
      });
    if (id === OPENROUTER_AUTO)
      return {
        model: id,
        name: 'Auto',
        native_context: null,
        original_precision: null,
        endpoints: [],
        fetched_at: new Date((this.deps.now ?? Date.now)()).toISOString(),
        offline: false,
      };
    const got = await this.body(id);
    return {
      ...parseEndpoints(got.body, this.deps.config(), need),
      model: id,
      fetched_at: new Date(got.at).toISOString(),
      offline: got.offline,
    };
  }

  /** For routing: the list if it can be had quickly, else null (routing then builds without it). */
  async tryReport(model: string, need: Need | null): Promise<EndpointsReport | null> {
    try {
      return await this.report(model, need);
    } catch {
      return null;
    }
  }
}
