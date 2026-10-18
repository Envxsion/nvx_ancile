/**
 * ------------------------------------------------------------------
 *  Title    |  Provider model lists
 *  Ref      |  roadmap MD4, MD5 · docs/models.md (What is checked)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read what each provider says it serves now, in one
 *           |  shape (Listed), and OpenRouter's public prices for the
 *           |  providers that publish none.
 *  How      |  parse* are pure and tested on small fixtures shaped like
 *           |  the documented answers. list() fetches through the
 *           |  resilience helpers (tracedFetch + retry, 15 s timeout)
 *           |  and follows pagination. A key that may not list models
 *           |  (401/403) is not "rejected": the check just says so.
 *  Note     |  Keys and response bodies are never logged. OpenRouter's
 *           |  public list is fetched without a key.
 * ------------------------------------------------------------------
 */
import { AncileError, type ModelConfig, type WatchPrice } from '@nvx/contracts';

type Capability = ModelConfig['capabilities'][number];

import { ClassifiedError, retry } from '@nvx/resilience';
import { tracedFetch } from '../../context';
import { dateOf, stripDate } from './lines';

export type ListKind = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'compatible';

/** One model as a provider's list reports it. */
export interface Listed {
  provider_model: string;
  display_name: string;
  context_window: number | null;
  max_output: number | null;
  /** Abilities NVX Ancile uses, when the list says (see capsKnown). */
  capabilities: Capability[];
  /** False when the list says nothing about abilities (OpenAI-style lists): never read as "lost them". */
  capsKnown: boolean;
  /**
   * Abilities the list explicitly says the model lacks (a key present and not
   * supported). Only these are ever taken away; a key that is simply missing
   * from the list changes nothing.
   */
  capsDenied: Capability[];
  other_abilities: string[];
  price: WatchPrice | null;
  lifecycle: 'active' | 'deprecated' | 'retired';
  retires_at: string | null;
  created_at: string | null;
}

const base = (provider_model: string): Listed => ({
  provider_model,
  display_name: provider_model,
  context_window: null,
  max_output: null,
  capabilities: [],
  capsKnown: false,
  capsDenied: [],
  other_abilities: [],
  price: null,
  lifecycle: 'active',
  retires_at: null,
  created_at: null,
});

const posInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---- Anthropic -------------------------------------------------------

/** Does a capability entry say "yes"? Entries are `true` or `{ supported: true, ... }`. */
const supported = (v: unknown): boolean => v === true || rec(v).supported === true;

export function parseAnthropic(body: unknown): { models: Listed[]; next: string | null } {
  const b = rec(body);
  const models: Listed[] = [];
  for (const raw of arr(b.data)) {
    const m = rec(raw);
    const id = str(m.id);
    if (!id) continue;
    const caps = new Set<Capability>(['tools']);
    const denied = new Set<Capability>();
    const other: string[] = [];
    const known: Record<string, Capability> = {
      image_input: 'vision',
      structured_outputs: 'json',
      thinking: 'reasoning',
    };
    for (const [k, v] of Object.entries(rec(m.capabilities))) {
      const cap = known[k];
      if (!supported(v)) {
        if (cap) denied.add(cap);
        continue;
      }
      if (cap) caps.add(cap);
      else other.push(k.slice(0, 60));
    }
    const life = str(m.lifecycle);
    models.push({
      ...base(id),
      display_name: str(m.display_name) ?? id,
      context_window: posInt(m.max_input_tokens),
      max_output: posInt(m.max_tokens),
      capabilities: [...caps],
      capsKnown: Object.keys(rec(m.capabilities)).length > 0,
      capsDenied: [...denied],
      other_abilities: other.slice(0, 40),
      lifecycle: life === 'retired' || life === 'deprecated' ? life : 'active',
      retires_at: str(m.retires_at),
      created_at: str(m.created_at),
    });
  }
  const more = b.has_more === true ? str(b.last_id) : null;
  return { models, next: more };
}

// ---- OpenAI and compatible ------------------------------------------

export function parseOpenAi(body: unknown): { models: Listed[]; next: null } {
  const models: Listed[] = [];
  for (const raw of arr(rec(body).data)) {
    const m = rec(raw);
    const id = str(m.id);
    if (!id) continue;
    const created = typeof m.created === 'number' ? new Date(m.created * 1000).toISOString() : null;
    models.push({
      ...base(id),
      context_window: posInt(m.context_length) ?? posInt(m.context_window) ?? posInt(m.max_model_len),
      created_at: created,
    });
  }
  return { models, next: null };
}

// ---- Google ----------------------------------------------------------

export function parseGoogle(body: unknown): { models: Listed[]; next: string | null } {
  const b = rec(body);
  const models: Listed[] = [];
  for (const raw of arr(b.models)) {
    const m = rec(raw);
    const name = str(m.name);
    if (!name) continue;
    const methods = arr(m.supportedGenerationMethods).filter((x): x is string => typeof x === 'string');
    // Embedding, image and audio-only models do not answer a chat turn.
    if (methods.length && !methods.includes('generateContent')) continue;
    const id = name.replace(/^models\//, '');
    models.push({
      ...base(id),
      display_name: str(m.displayName) ?? id,
      context_window: posInt(m.inputTokenLimit),
      max_output: posInt(m.outputTokenLimit),
    });
  }
  return { models, next: str(b.nextPageToken) };
}

// ---- OpenRouter ------------------------------------------------------

/** OpenRouter prices are USD per token, as strings. Negative means "varies" (routers): no price. */
const perMtok = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : null;
};

export function openRouterPrice(pricing: unknown): WatchPrice | null {
  const p = rec(pricing);
  const input = perMtok(p.prompt);
  const output = perMtok(p.completion);
  if (input === null || output === null) return null;
  const cached = perMtok(p.input_cache_read);
  const written = perMtok(p.input_cache_write);
  return {
    input_per_mtok: input,
    output_per_mtok: output,
    ...(cached !== null && { cached_per_mtok: cached }),
    ...(written !== null && { cache_write_per_mtok: written }),
  };
}

export function parseOpenRouter(body: unknown): { models: Listed[]; next: null } {
  const models: Listed[] = [];
  for (const raw of arr(rec(body).data)) {
    const m = rec(raw);
    const id = str(m.id);
    if (!id) continue;
    const params = arr(m.supported_parameters).filter((x): x is string => typeof x === 'string');
    const arch = rec(m.architecture);
    const inputs = arr(arch.input_modalities).filter((x): x is string => typeof x === 'string');
    const caps = new Set<Capability>();
    if (params.includes('tools')) caps.add('tools');
    if (params.includes('reasoning') || params.includes('include_reasoning')) caps.add('reasoning');
    if (params.includes('response_format') || params.includes('structured_outputs')) caps.add('json');
    if (inputs.includes('image')) caps.add('vision');
    if (inputs.includes('audio')) caps.add('audio');
    const top = rec(m.top_provider);
    models.push({
      ...base(id),
      display_name: str(m.name) ?? id,
      context_window: posInt(top.context_length) ?? posInt(m.context_length),
      max_output: posInt(top.max_completion_tokens),
      capabilities: [...caps],
      capsKnown: params.length > 0 || inputs.length > 0,
      other_abilities: inputs.filter((i) => i === 'file' || i === 'video').map((i) => `${i}_input`),
      price: openRouterPrice(m.pricing),
      created_at: typeof m.created === 'number' ? new Date(m.created * 1000).toISOString() : null,
    });
  }
  return { models, next: null };
}

// ---- OpenRouter prices for direct providers --------------------------

/** Our vendor name to OpenRouter's id prefix. */
export const OPENROUTER_VENDOR: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  mistral: 'mistralai',
  xai: 'x-ai',
  qwen: 'qwen',
  zai: 'z-ai',
  minimax: 'minimax',
};

/** Lowercase, dots to dashes, snapshot date removed: the form two spellings of one model share. */
export const normaliseForMatch = (providerModel: string) =>
  stripDate(providerModel.toLowerCase().replace(/\./g, '-'));

/** `<openrouter vendor>/<normalised slug>` to price. Variants such as `:free` are left out. */
export function priceIndex(
  listed: { provider_model: string; price: WatchPrice | null }[],
): Map<string, WatchPrice> {
  const out = new Map<string, WatchPrice>();
  for (const m of listed) {
    if (!m.price || m.provider_model.includes(':')) continue;
    const slash = m.provider_model.indexOf('/');
    if (slash < 1) continue;
    const key = `${m.provider_model.slice(0, slash)}/${normaliseForMatch(m.provider_model.slice(slash + 1))}`;
    // A dated and an undated spelling of one model: keep the first seen.
    if (!out.has(key)) out.set(key, m.price);
  }
  return out;
}

/** Exact match only: a model that is merely similar never borrows a price. */
export function matchOpenRouterPrice(
  index: Map<string, WatchPrice>,
  vendor: string | null,
  providerModel: string,
): WatchPrice | null {
  const prefix = vendor ? OPENROUTER_VENDOR[vendor] : undefined;
  if (!prefix) return null;
  return index.get(`${prefix}/${normaliseForMatch(providerModel)}`) ?? null;
}

// ---- Fetching --------------------------------------------------------

export const LIST_TIMEOUT_MS = 15_000;
export const OPENROUTER_PUBLIC_URL = 'https://openrouter.ai/api/v1/models';

/** The one network call the listers make, replaceable in tests. */
export type JsonGetter = (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<unknown>;

export const listForbidden = (host: string) =>
  new AncileError({
    code: 'models.list_forbidden',
    title: `This key can't list models at ${host}`,
    hint: 'The key still works for answers. Prices and new models for this provider stay as shipped. A key that is allowed to list models, or a different key, turns the daily check on.',
    status: 502,
    errorClass: 'permanent',
  });

export const listUnavailable = (host: string, status: number) =>
  new AncileError({
    code: 'models.list_unavailable',
    title: `${host} did not give its model list`,
    hint: 'It answered with an error or was busy. NVX Ancile asks again later, waiting longer each time.',
    status: 502,
    errorClass: 'transient',
    retryable: true,
    context: { status },
  });

export const listFailed = (host: string, why: string) =>
  new AncileError({
    code: 'models.list_failed',
    title: `The model list from ${host} could not be read`,
    hint: 'Check your connection, or that the address in Settings → Models is right. NVX Ancile asks again later.',
    status: 502,
    errorClass: 'transient',
    detail: why,
  });

/** The real getter: tracedFetch with the shared retry helper. Status in the error, never the body. */
export const liveJson: JsonGetter = (url, headers, signal) =>
  retry(
    async () => {
      const res = await tracedFetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)])
          : AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!res.ok)
        throw new ClassifiedError(
          res.status >= 500 || res.status === 429 ? 'transient' : 'permanent',
          `${new URL(url).host} answered ${res.status}`,
          { status: res.status },
        );
      return res.json();
    },
    { maxAttempts: 2, capMs: 1_500, ...(signal && { signal }) },
  );

/** Turn a getter's failure into the documented error for this check. */
export function listError(err: unknown, host: string): AncileError {
  if (err instanceof AncileError) return err;
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) return listForbidden(host);
  if (status === 429 || (typeof status === 'number' && status >= 500)) return listUnavailable(host, status);
  if (status === 404) return listFailed(host, 'no model list at this address');
  return listFailed(host, err instanceof Error ? err.message.slice(0, 200) : 'unknown');
}

export interface ListTarget {
  kind: ListKind;
  baseUrl: string;
  key: string | null;
  /** Anthropic personal keys name their workspace. */
  workspaceId?: string | null;
}

const trim = (u: string) => u.replace(/\/+$/, '');
const MAX_PAGES = 12;

/** Read a provider's whole list, following pages. Throws an AncileError with a documented code. */
export async function list(t: ListTarget, get: JsonGetter, signal?: AbortSignal): Promise<Listed[]> {
  const root = trim(t.baseUrl);
  const host = new URL(root).host;
  const out: Listed[] = [];
  try {
    if (t.kind === 'anthropic') {
      const headers: Record<string, string> = {
        'x-api-key': t.key ?? '',
        'anthropic-version': '2023-06-01',
        ...(t.workspaceId && { 'anthropic-workspace-id': t.workspaceId }),
      };
      let after: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const url = `${root}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
        const page = parseAnthropic(await get(url, headers, signal));
        out.push(...page.models);
        after = page.next;
        if (!after) break;
      }
    } else if (t.kind === 'google') {
      let token: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const url = `${root}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
        const page = parseGoogle(await get(url, { 'x-goog-api-key': t.key ?? '' }, signal));
        out.push(...page.models);
        token = page.next;
        if (!token) break;
      }
    } else if (t.kind === 'openrouter') {
      const auth: Record<string, string> = t.key ? { authorization: `Bearer ${t.key}` } : {};
      out.push(...parseOpenRouter(await get(`${root}/models`, auth, signal)).models);
    } else {
      const auth: Record<string, string> = t.key ? { authorization: `Bearer ${t.key}` } : {};
      out.push(...parseOpenAi(await get(`${root}/models`, auth, signal)).models);
    }
  } catch (err) {
    throw listError(err, host);
  }
  return out;
}

/** OpenRouter's public list with no key sent: prices only. */
export async function listOpenRouterPublic(get: JsonGetter, signal?: AbortSignal): Promise<Listed[]> {
  try {
    return parseOpenRouter(await get(OPENROUTER_PUBLIC_URL, {}, signal)).models;
  } catch (err) {
    throw listError(err, 'openrouter.ai');
  }
}

/** Providers with no model list at all: no call is made. */
export const NO_LIST_VENDORS = new Set(['zai']);

export { dateOf, stripDate };
