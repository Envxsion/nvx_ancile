/**
 * ------------------------------------------------------------------
 *  Title    |  Providers
 *  Ref      |  DESIGN.md §2 (Vercel AI SDK), §4.3 (Controller)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a ModelConfig into a live language model, and the
 *           |  AI SDK's stream into Ancile's StreamChunks.
 *  How      |  anthropic / openai / google use their first-party AI SDK
 *           |  providers. Everything else that speaks OpenAI (Ollama,
 *           |  OpenRouter, DeepSeek, Kimi, vLLM, LM Studio, the
 *           |  Controller's data plane) goes through the
 *           |  openai-compatible provider, so a new endpoint is a
 *           |  profile row (profiles.ts), not code: its address by
 *           |  region, its headers, its cache fields. A failed call is
 *           |  read through the provider's profile (provider-errors.ts)
 *           |  before the gateway decides to retry, wait or move on.
 *  Note     |  Written against AI SDK 5 stream parts (text-delta.text,
 *           |  reasoning-delta, tool-call.input, finish.totalUsage).
 *           |  Tools are passed without execute(): the model proposes a
 *           |  call, and the conductor runs it after the permission
 *           |  check. OpenRouter calls carry the routing `provider`
 *           |  object (openrouter/service.ts) and report which provider
 *           |  served and what it billed (servedExtractor).
 *           |  CA1 keeps reasoning verbatim and sends it back by each
 *           |  provider's rule (replay.ts); CA5 adds each provider's
 *           |  cache settings (cache.ts): Anthropic markers, cache keys,
 *           |  conversation ids, OpenRouter's pinned upstream.
 *           |  Reasoning effort (EN1) goes out as a provider option (effort.ts).
 * ------------------------------------------------------------------
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelConfig } from '@nvx/contracts';
import { ClassifiedError, classify } from '@nvx/resilience';
import {
  type JSONValue,
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  streamText,
  type ToolSet,
  tool,
} from 'ai';
import { logFor } from '../obs/logger';
import {
  anthropicBreakpoints,
  anthropicMinTokens,
  cacheExtras,
  cacheKey,
  EPHEMERAL,
  type Pin,
  PinBook,
  pinnedProvider,
} from './cache';
import { type SdkMessage as StoredMessage, toSdkMessages } from './convert';
import { assertSendAllowed } from './e2e-guard';
import { effortOptions } from './effort';
import { isOllama, ollamaChat } from './ollama-chat';
import {
  ANTHROPIC_WORKSPACE_SECRET,
  baseUrlFor,
  DEFAULT_SECRET,
  type ProviderProfile,
  profileFor,
} from './profiles';
import { classifyFailure, errorClassFor, failureWords } from './provider-errors';
import { replayFor } from './replay';
import type { ModelClient, ModelMessage, ModelRequest, StreamChunk } from './types';
import { type CallUsage, cacheFromRaw, usageNumbers } from './usage';

const log = logFor('gateway.cache');

/** Reads a stored image's bytes by id (images/store.ts), for vision models. */
export type ImageBytes = (id: string) => Promise<{ bytes: Buffer; mime: string } | null>;

/** The bytes of every image in the users' messages, by URL: stored ones by id, data: URLs decoded. */
export async function imagesFor(
  messages: ModelMessage[],
  read: ImageBytes | undefined,
): Promise<Map<string, { data: Uint8Array; mime: string }>> {
  const out = new Map<string, { data: Uint8Array; mime: string }>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const p of m.parts ?? []) {
      if (p.type !== 'image' || out.has(p.url)) continue;
      const data = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(p.url);
      if (data) {
        out.set(p.url, { data: Buffer.from(data[2] as string, 'base64'), mime: data[1] as string });
        continue;
      }
      if (!p.image_id || !read) continue;
      const got = await read(p.image_id).catch(() => null);
      if (got) out.set(p.url, { data: got.bytes, mime: got.mime });
    }
  }
  return out;
}

export interface ProviderSecrets {
  /** Resolve a secret by name (from the encrypted store). */
  get(name: string): Promise<string | undefined>;
}

/** OpenRouter's served provider, model and billed cost, read from the raw stream. */
export interface Served {
  provider: string | null;
  model: string | null;
  cost: number | null;
}

/** Reads OpenRouter's top-level `provider`, `model` and `usage.cost` off each chunk. */
export function readServed(into: Served, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const c = raw as { provider?: unknown; model?: unknown; usage?: { cost?: unknown } };
  if (typeof c.provider === 'string' && c.provider) into.provider = c.provider;
  if (typeof c.model === 'string' && c.model) into.model = c.model;
  if (typeof c.usage?.cost === 'number' && Number.isFinite(c.usage.cost)) into.cost = c.usage.cost;
}

/** The raw `usage` an OpenAI-style answer or stream chunk carries, as it came. */
const rawUsage = (raw: unknown): Record<string, unknown> | undefined => {
  const u = raw && typeof raw === 'object' ? (raw as { usage?: unknown }).usage : undefined;
  return u && typeof u === 'object' ? (u as Record<string, unknown>) : undefined;
};

/**
 * OpenRouter streams reasoning_details in pieces (one entry per `index`, its text
 * split over chunks). Joined here, by index, into the entries it would have sent
 * whole; nothing else about an entry is changed (CA1: replayed as received).
 */
export function mergeDetails(into: Map<string, Record<string, unknown>>, entries: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const d = e as Record<string, unknown>;
    const key = String(d.index ?? d.id ?? into.size);
    const have = into.get(key);
    if (!have) {
      into.set(key, { ...d });
      continue;
    }
    for (const [k, v] of Object.entries(d)) {
      if ((k === 'text' || k === 'summary') && typeof v === 'string' && typeof have[k] === 'string')
        have[k] = `${have[k]}${v}`;
      else if (v !== undefined && v !== null) have[k] = v;
    }
  }
}

const detailsOf = (raw: unknown): unknown => {
  const c = raw && typeof raw === 'object' ? (raw as { choices?: unknown }).choices : undefined;
  const first = Array.isArray(c) ? (c[0] as { delta?: unknown; message?: unknown } | undefined) : undefined;
  const d = (first?.delta ?? first?.message) as { reasoning_details?: unknown } | undefined;
  return d?.reasoning_details;
};

/**
 * Every OpenAI-compatible route: OpenRouter's served provider, model and cost,
 * and the raw usage, so cache hits under any provider's name are counted
 * (the AI SDK only reads prompt_tokens_details.cached_tokens; DeepSeek says
 * prompt_cache_hit_tokens, and every hit read as zero). Also OpenRouter's
 * reasoning_details, which the SDK does not carry.
 */
export const servedExtractor = {
  async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
    const s: Served = { provider: null, model: null, cost: null };
    readServed(s, parsedBody);
    const usage = rawUsage(parsedBody);
    const details = new Map<string, Record<string, unknown>>();
    mergeDetails(details, detailsOf(parsedBody));
    return {
      openrouter: {
        ...s,
        ...(details.size && { reasoning_details: [...details.values()] as JSONValue }),
      },
      ...(usage && { raw: { usage: usage as JSONValue } }),
    };
  },
  createStreamExtractor() {
    const s: Served = { provider: null, model: null, cost: null };
    let usage: Record<string, unknown> | undefined;
    const details = new Map<string, Record<string, unknown>>();
    return {
      processChunk: (raw: unknown) => {
        readServed(s, raw);
        usage = rawUsage(raw) ?? usage;
        mergeDetails(details, detailsOf(raw));
      },
      buildMetadata: () => ({
        openrouter: {
          ...s,
          ...(details.size && { reasoning_details: [...details.values()] as JSONValue }),
        },
        ...(usage && { raw: { usage: usage as JSONValue } }),
      }),
    };
  },
};

/** The routing for one OpenRouter call (openrouter/service.ts), or null. */
export type OpenRouterRouting = (
  m: ModelConfig,
  req: ModelRequest,
) => Promise<{ provider: Record<string, unknown>; max_tokens: number | null } | null>;

export interface ProviderEndpoints {
  controllerUrl?: string | undefined;
  controllerToken?: string | undefined;
  ollamaUrl?: string | undefined;
  /** The fetch OpenAI-compatible providers use (tests). */
  fetch?: typeof fetch;
  /** The numbers of a provider's raw usage (main.ts logs the first per provider, to confirm what it reports). */
  onRawUsage?: (provider: string, usage: Record<string, number>) => void;
}

/**
 * Which secret holds each provider's key, and where the workspace a personal
 * Anthropic key bills is kept: both come from the profile table (profiles.ts).
 */
export { ANTHROPIC_WORKSPACE_SECRET, DEFAULT_SECRET };

/** The region saved for a provider (a non-secret value beside the key), or undefined. */
export async function regionFor(
  profile: ProviderProfile,
  secrets: ProviderSecrets,
): Promise<string | undefined> {
  return profile.regionSecret ? ((await secrets.get(profile.regionSecret)) ?? undefined) : undefined;
}

export async function languageModelFor(
  m: ModelConfig,
  secrets: ProviderSecrets,
  ep: ProviderEndpoints,
): Promise<LanguageModel> {
  // The test profile's send guard: before any key is read or any client is built (e2e-guard.ts).
  assertSendAllowed(m);
  const secretName = m.secret ?? DEFAULT_SECRET[m.provider];
  const apiKey = secretName ? await secrets.get(secretName) : undefined;
  const needKey = (name: string) => {
    if (!apiKey)
      throw new ClassifiedError('permanent', `No API key for ${name}. Add it in Settings → Models.`, {
        status: 401,
      });
    return apiKey;
  };

  if (m.via === 'controller') {
    if (!ep.controllerUrl)
      throw new ClassifiedError(
        'permanent',
        `${m.display_name} runs on remote compute, but no Controller is configured.`,
      );
    return createOpenAICompatible({
      // Ask for usage in streamed answers: without it vLLM, Ollama and LM Studio send none,
      // and every token count and cost for them read zero.
      includeUsage: true,
      name: 'controller',
      baseURL: `${ep.controllerUrl.replace(/\/$/, '')}/v1`,
      ...(!!ep.controllerToken && { apiKey: ep.controllerToken }),
      ...(ep.fetch && { fetch: ep.fetch }),
      metadataExtractor: servedExtractor,
    })(m.provider_model);
  }

  switch (m.provider) {
    case 'anthropic': {
      // A personal key (sk-ant-usr-) names the workspace to bill on every call.
      const workspace = await secrets.get(ANTHROPIC_WORKSPACE_SECRET);
      const headers = profileFor('anthropic').headers({ workspaceId: workspace });
      return createAnthropic({
        apiKey: needKey('Anthropic'),
        ...(!!m.base_url && { baseURL: m.base_url }),
        ...(Object.keys(headers).length > 0 && { headers }),
        ...(ep.fetch && { fetch: ep.fetch }),
      })(m.provider_model);
    }
    case 'openai':
      return createOpenAI({
        apiKey: needKey('OpenAI'),
        ...(!!m.base_url && { baseURL: m.base_url }),
        ...(ep.fetch && { fetch: ep.fetch }),
      })(m.provider_model);
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: needKey('Google'),
        ...(ep.fetch && { fetch: ep.fetch }),
      })(m.provider_model);
    case 'openrouter':
      return createOpenAICompatible({
        // Ask for usage in streamed answers: without it vLLM, Ollama and LM Studio send none,
        // and every token count and cost for them read zero.
        includeUsage: true,
        name: 'openrouter',
        baseURL: m.base_url ?? 'https://openrouter.ai/api/v1',
        apiKey: needKey('OpenRouter'),
        ...(ep.fetch && { fetch: ep.fetch }),
        metadataExtractor: servedExtractor,
      })(m.provider_model);
    case 'ollama':
      return createOpenAICompatible({
        // Ask for usage in streamed answers: without it vLLM, Ollama and LM Studio send none,
        // and every token count and cost for them read zero.
        includeUsage: true,
        name: 'ollama',
        baseURL: m.base_url ?? `${(ep.ollamaUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
        ...(ep.fetch && { fetch: ep.fetch }),
      })(m.provider_model);
    default: {
      // A model's own base_url wins; else the profile's address for the saved region (profiles.ts).
      const profile = profileFor(m.provider);
      const baseURL = m.base_url ?? baseUrlFor(profile, await regionFor(profile, secrets));
      if (!baseURL)
        throw new ClassifiedError(
          'permanent',
          `${m.display_name} has no base_url; any OpenAI-compatible endpoint needs one.`,
        );
      // A provider that bills a key needs one, unless the model points at its own endpoint.
      if (profile.needsKey && !m.base_url) needKey(profile.name);
      const headers = profile.headers({ key: apiKey });
      return createOpenAICompatible({
        // Ask for usage in streamed answers: without it vLLM, Ollama and LM Studio send none,
        // and every token count and cost for them read zero.
        includeUsage: true,
        name: m.provider,
        baseURL,
        ...(!!apiKey && { apiKey }),
        ...(Object.keys(headers).length > 0 && { headers }),
        ...(ep.fetch && { fetch: ep.fetch }),
        metadataExtractor: servedExtractor,
      })(m.provider_model);
    }
  }
}

/**
 * Wrap whatever the SDK threw so classify() sees status codes and causes, read
 * through the provider's profile (GW1): out of credit is permanent for that
 * provider (the chain moves on, nothing is retried), a rate limit or overload
 * is transient and carries the provider's Retry-After (seconds or a date), a
 * wrong region or a model the key may not use is permanent with its own words.
 * Anything the profile cannot place keeps the generic status rules.
 */
export function wrap(
  err: unknown,
  provider = 'generic',
  ctx: { model?: string; region?: string | undefined } = {},
): unknown {
  if (err instanceof ClassifiedError) return err;
  const e = err as { statusCode?: number; message?: string };
  const profile = profileFor(provider);
  const seen = classifyFailure(profile, err);
  const cls = errorClassFor(seen.kind) ?? classify(err);
  const words = failureWords(seen.kind, profile, {
    ...(ctx.model && { model: ctx.model }),
    region: ctx.region,
    ...(seen.regionHint && { regionHint: true }),
  });
  const status = seen.status || e.statusCode;
  return new ClassifiedError(cls, e.message ?? String(err), {
    ...(status !== undefined && status !== 0 && { status }),
    ...(seen.retryAfterMs !== undefined && { retryAfterMs: seen.retryAfterMs }),
    ...(words && { code: words.code, title: words.title, hint: words.hint }),
    cause: err,
  });
}

/** What a step's provider metadata can carry (servedExtractor, the Anthropic provider). */
interface StepMetadata {
  openrouter?: Partial<Served> & { reasoning_details?: unknown[] };
  raw?: { usage?: unknown };
  anthropic?: { cacheCreationInputTokens?: number | null; usage?: unknown };
}

/** Rough tokens in an SDK message, for deciding where an Anthropic marker is worth placing. */
function tokensOf(msg: StoredMessage): number {
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 4);
  let chars = 0;
  for (const c of msg.content) {
    if (c.type === 'text' || c.type === 'reasoning') chars += c.text.length;
    else if (c.type === 'tool-call') chars += JSON.stringify(c.input ?? null).length + c.toolName.length;
    else if (c.type === 'tool-result') chars += JSON.stringify(c.output).length;
    else chars += 6_000; // an image
  }
  return Math.ceil(chars / 4);
}

/** Only what a provider signed, from the metadata the SDK attached to a reasoning part. */
function reasoningMeta(pm: unknown): Record<string, unknown> | undefined {
  const a = (pm as { anthropic?: { signature?: unknown; redactedData?: unknown } } | undefined)?.anthropic;
  if (typeof a?.signature === 'string') return { anthropic: { signature: a.signature } };
  if (typeof a?.redactedData === 'string') return { anthropic: { redactedData: a.redactedData } };
  return undefined;
}

/** Gemini's thought signature on a function call. */
function callMeta(pm: unknown): Record<string, unknown> | undefined {
  const g = (pm as { google?: { thoughtSignature?: unknown } } | undefined)?.google;
  return typeof g?.thoughtSignature === 'string'
    ? { google: { thoughtSignature: g.thoughtSignature } }
    : undefined;
}

export class AiSdkClient implements ModelClient {
  /** CA5: the OpenRouter upstream that served a warm call, per branch and model. */
  readonly pins = new PinBook();

  constructor(
    private readonly secrets: ProviderSecrets,
    private readonly endpoints: ProviderEndpoints,
    private readonly images?: ImageBytes,
    private readonly openrouter?: OpenRouterRouting,
  ) {}

  /**
   * One meaning for every provider (gateway/usage.ts): input counts every prompt
   * token. Anthropic's input_tokens leaves out cache reads and writes, so they
   * are added back; OpenAI-style providers count them in already, and their hits
   * are read from the raw usage when the SDK missed them (DeepSeek).
   */
  private usageOf(
    m: ModelConfig,
    total: {
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      cachedInputTokens?: number | undefined;
    },
    meta: StepMetadata | undefined,
  ): CallUsage {
    const input = total.inputTokens ?? 0;
    const output = total.outputTokens ?? 0;
    const sdkCached = total.cachedInputTokens ?? 0;
    if (m.provider === 'anthropic' && m.via === 'direct') {
      const written = meta?.anthropic?.cacheCreationInputTokens ?? 0;
      if (meta?.anthropic?.usage)
        this.endpoints.onRawUsage?.('anthropic', usageNumbers(meta.anthropic.usage));
      return {
        inputTokens: input + sdkCached + written,
        outputTokens: output,
        cachedTokens: sdkCached,
        ...(written > 0 && { cacheWriteTokens: written }),
        cacheReported: true,
      };
    }
    const raw = meta?.raw?.usage;
    if (raw) this.endpoints.onRawUsage?.(m.provider, usageNumbers(raw));
    // The provider's own field names first; any name providers are known to use if it named none.
    const own = cacheFromRaw(raw, profileFor(m.provider).usage);
    const cache = own.hit !== undefined ? { ...cacheFromRaw(raw), ...own } : cacheFromRaw(raw);
    const cached = Math.max(sdkCached, cache.hit ?? 0);
    return {
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      ...(cache.write && { cacheWriteTokens: cache.write }),
      // Said so by the provider: the SDK read a figure, or the raw usage carried one.
      cacheReported: total.cachedInputTokens !== undefined || cache.hit !== undefined,
    };
  }

  /**
   * OpenRouter: once a call has warmed a cache the next go to the same upstream
   * with fallbacks off. If that upstream is down the call is asked again with no
   * pin, on purpose: logged, and recorded on the answer as a cache reset.
   */
  async *stream(m: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const pinKey = m.provider === 'openrouter' && req.cache ? `${cacheKey(req.cache)}:${m.id}` : null;
    const pin = pinKey ? this.pins.get(pinKey) : undefined;
    if (!pin) {
      yield* this.run(m, req, signal, undefined, pinKey);
      return;
    }
    let started = false;
    try {
      for await (const c of this.run(m, req, signal, pin, pinKey)) {
        started = true;
        yield c;
      }
      return;
    } catch (err) {
      const e = err as { errorClass?: string; status?: number };
      const down =
        e.errorClass === 'transient' ||
        e.errorClass === 'capacity' ||
        [404, 502, 503, 504].includes(e.status ?? 0);
      if (started || signal.aborted || !down) throw err;
      if (pinKey) this.pins.drop(pinKey);
      log.warn(
        { model: m.id, upstream: pin.provider, status: e.status ?? null },
        'pinned OpenRouter provider failed; asking again with no pin (a cache reset)',
      );
    }
    yield* this.run(m, req, signal, undefined, pinKey, {
      reason: 'pinned_provider_failed',
      provider: pin.provider,
      detail: `${pin.provider} did not answer, so the call went unpinned and the cache starts again`,
    });
  }

  private async *run(
    m: ModelConfig,
    req: ModelRequest,
    signal: AbortSignal,
    pin: Pin | undefined,
    pinKey: string | null,
    reset?: { reason: string; provider: string | null; detail: string },
  ): AsyncIterable<StreamChunk> {
    const vision = m.capabilities.includes('vision');
    const images = vision ? await imagesFor(req.messages, this.images) : undefined;
    // Ollama goes through its own /api/chat so the call can say how much context to
    // load: through /v1 it silently keeps its server default and cuts long prompts.
    if (isOllama(m)) {
      yield* ollamaChat(m, req, signal, {
        baseUrl: m.base_url ?? this.endpoints.ollamaUrl ?? 'http://localhost:11434',
        ...(images && { images }),
      });
      return;
    }
    const model = await languageModelFor(m, this.secrets, this.endpoints);
    const region = await regionFor(profileFor(m.provider), this.secrets).catch(() => undefined);
    const failed = (err: unknown) => wrap(err, m.provider, { model: m.display_name, region });
    // A routing problem never stops the call: it goes out as OpenRouter's default.
    // A pinned call reuses the routing that warmed it, so the choice is not made again.
    const fresh =
      m.provider === 'openrouter' && this.openrouter && !pin
        ? await this.openrouter(m, req).catch(() => null)
        : null;
    const routing = pin ? pin.routing : fresh;
    const maxOutputTokens = req.maxOutputTokens ?? routing?.max_tokens ?? undefined;
    const toolsOffered = !!(req.tools?.length && m.capabilities.includes('tools'));

    // CA1: earlier reasoning goes back by this provider's rule, or not at all.
    const sdkMessages = toSdkMessages(req.messages, {
      tools: m.capabilities.includes('tools'),
      vision,
      ...(images && { images }),
      reasoning: replayFor(m, { tools: toolsOffered, epochId: req.cache?.epochId }),
    });

    // CA5: this provider's cache settings.
    const extras = cacheExtras(m, req.cache);
    const anthropicDirect = m.provider === 'anthropic' && m.via === 'direct';
    let system: { system?: string; allow?: true } = {};
    let messages: StoredMessage[] = sdkMessages;
    let markLastTool = false;
    if (anthropicDirect) {
      const blocks = req.systemBlocks ?? (req.system !== undefined ? [req.system] : []);
      const plan = anthropicBreakpoints({
        toolsTokens: toolsOffered ? Math.ceil(JSON.stringify(req.tools).length / 4) : 0,
        system: blocks.map((b) => Math.ceil(b.length / 4)),
        messages: sdkMessages.map(tokensOf),
        min: anthropicMinTokens(m.provider_model),
      });
      markLastTool = plan.tools;
      const marked = new Set(plan.messages);
      messages = [
        ...blocks.map(
          (content, k) =>
            ({
              role: 'system',
              content,
              ...(plan.system.includes(k) && { providerOptions: EPHEMERAL }),
            }) as unknown as StoredMessage,
        ),
        ...sdkMessages.map((x, k) =>
          marked.has(k)
            ? ({
                ...x,
                providerOptions: {
                  ...((x as { providerOptions?: object }).providerOptions ?? {}),
                  ...EPHEMERAL,
                },
              } as StoredMessage)
            : x,
        ),
      ];
      system = { allow: true };
    } else if (req.system !== undefined) system = { system: req.system };

    const providerOptions = { ...extras.options } as Record<string, Record<string, JSONValue>>;
    // EN1: the reasoning effort, under this provider's own option name (effort.ts).
    for (const [k, v] of Object.entries(effortOptions(m, req.effort).options))
      providerOptions[k] = { ...providerOptions[k], ...(v as Record<string, JSONValue>) };
    if (m.provider === 'openrouter' && (routing || pin)) {
      const provider = pin ? pinnedProvider(routing?.provider, pin.provider) : routing?.provider;
      providerOptions.openrouter = {
        ...providerOptions.openrouter,
        ...(provider && { provider: provider as Record<string, JSONValue> }),
        usage: { include: true },
      };
    }

    const result = streamText({
      model,
      ...(system.system !== undefined && { system: system.system }),
      ...(system.allow && { allowSystemInMessages: true }),
      messages: messages as SdkMessage[],
      // A model without the tools capability is never offered tools: vLLM started
      // without a tool parser refuses the whole request ("auto" tool choice requires
      // --enable-auto-tool-choice), so every turn to such a GPU node failed.
      ...(toolsOffered && {
        tools: Object.fromEntries(
          (req.tools ?? []).map((t, k, all) => [
            t.name,
            tool({
              description: t.description,
              inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
              ...(markLastTool && k === all.length - 1 && { providerOptions: EPHEMERAL }),
            }),
          ]),
        ) as ToolSet,
      }),
      ...(toolsOffered && req.toolChoice && { toolChoice: req.toolChoice }),
      abortSignal: signal,
      maxRetries: 0, // retries are the gateway's job, with its own policy
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
      ...(Object.keys(extras.headers).length > 0 && { headers: extras.headers }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    });
    // AI SDK 5 puts provider metadata on 'finish-step', never on 'finish': read
    // there, OpenRouter's served provider and billed cost, Anthropic's cache
    // writes and every raw usage were always missing.
    let meta: StepMetadata | undefined;
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            yield { type: 'text', delta: part.text };
            break;
          case 'reasoning-start': {
            const rm = reasoningMeta(part.providerMetadata);
            yield { type: 'reasoning', delta: '', block: true, ...(rm && { meta: rm }) };
            break;
          }
          case 'reasoning-delta': {
            const rm = reasoningMeta(part.providerMetadata);
            yield { type: 'reasoning', delta: part.text, ...(rm && { meta: rm }) };
            break;
          }
          case 'tool-call': {
            const cm = callMeta(part.providerMetadata);
            yield {
              type: 'tool_call',
              callId: part.toolCallId,
              tool: part.toolName,
              args: part.input,
              ...(cm && { meta: cm }),
            };
            break;
          }
          case 'error':
            throw failed(part.error);
          case 'finish-step':
            meta = (part.providerMetadata as StepMetadata | undefined) ?? meta;
            break;
          case 'finish': {
            const or = meta?.openrouter;
            // OpenRouter's reasoning_details for this step, to be sent back as received.
            if (m.provider === 'openrouter' && or?.reasoning_details?.length)
              yield {
                type: 'reasoning',
                delta: '',
                block: true,
                meta: { openrouter: { reasoning_details: or.reasoning_details } },
              };
            const usage = this.usageOf(m, part.totalUsage, meta);
            // Warm: the next call goes to the same upstream (CA5).
            if (
              pinKey &&
              or?.provider &&
              ((usage.cachedTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0)
            )
              this.pins.set(pinKey, { provider: or.provider, routing: pin ? pin.routing : fresh });
            yield {
              type: 'finish',
              finishReason: part.finishReason,
              ...(m.provider === 'openrouter' &&
                or && {
                  served: { provider: or.provider ?? null, model: or.model ?? null },
                  ...(typeof or.cost === 'number' && { costUsd: or.cost }),
                }),
              ...(reset && { cacheReset: reset }),
              usage,
            };
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      throw failed(err);
    }
  }
}
