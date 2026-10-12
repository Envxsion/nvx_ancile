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
 *           |  OpenRouter, vLLM, LM Studio, the Controller's data plane)
 *           |  goes through the openai-compatible provider, so a new
 *           |  endpoint is configuration, not code.
 *  Note     |  Written against AI SDK 5 stream parts (text-delta.text,
 *           |  reasoning-delta, tool-call.input, finish.totalUsage).
 *           |  Tools are passed without execute(): the model proposes a
 *           |  call, and the conductor runs it after the permission
 *           |  check. OpenRouter calls carry the routing `provider`
 *           |  object (openrouter/service.ts) and report which provider
 *           |  served and what it billed (servedExtractor).
 *           |  TODO(phase-4): provider options (reasoning effort,
 *           |  prompt caching).
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
import { toSdkMessages } from './convert';
import { isOllama, ollamaChat } from './ollama-chat';
import type { ModelClient, ModelMessage, ModelRequest, StreamChunk } from './types';

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

export const servedExtractor = {
  async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
    const s: Served = { provider: null, model: null, cost: null };
    readServed(s, parsedBody);
    return { openrouter: { ...s } };
  },
  createStreamExtractor() {
    const s: Served = { provider: null, model: null, cost: null };
    return {
      processChunk: (raw: unknown) => readServed(s, raw),
      buildMetadata: () => ({ openrouter: { ...s } }),
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
}

export const DEFAULT_SECRET: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export async function languageModelFor(
  m: ModelConfig,
  secrets: ProviderSecrets,
  ep: ProviderEndpoints,
): Promise<LanguageModel> {
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
    })(m.provider_model);
  }

  switch (m.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: needKey('Anthropic'), ...(!!m.base_url && { baseURL: m.base_url }) })(
        m.provider_model,
      );
    case 'openai':
      return createOpenAI({ apiKey: needKey('OpenAI'), ...(!!m.base_url && { baseURL: m.base_url }) })(
        m.provider_model,
      );
    case 'google':
      return createGoogleGenerativeAI({ apiKey: needKey('Google') })(m.provider_model);
    case 'openrouter':
      return createOpenAICompatible({
        // Ask for usage in streamed answers: without it vLLM, Ollama and LM Studio send none,
        // and every token count and cost for them read zero.
        includeUsage: true,
        name: 'openrouter',
        baseURL: m.base_url ?? 'https://openrouter.ai/api/v1',
        apiKey: needKey('OpenRouter'),
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
    default:
      if (!m.base_url)
        throw new ClassifiedError(
          'permanent',
          `${m.display_name} has no base_url; any OpenAI-compatible endpoint needs one.`,
        );
      return createOpenAICompatible({
        // Ask for usage in streamed answers: without it vLLM, Ollama and LM Studio send none,
        // and every token count and cost for them read zero.
        includeUsage: true,
        name: m.provider,
        baseURL: m.base_url,
        ...(!!apiKey && { apiKey }),
      })(m.provider_model);
  }
}

/** Wrap whatever the SDK threw so classify() sees status codes and causes. */
function wrap(err: unknown): unknown {
  if (err instanceof ClassifiedError) return err;
  const e = err as { statusCode?: number; responseHeaders?: Record<string, string>; message?: string };
  const cls = classify(err);
  const retryAfter = e.responseHeaders?.['retry-after'];
  return new ClassifiedError(cls, e.message ?? String(err), {
    ...(e.statusCode !== undefined && { status: e.statusCode }),
    ...(retryAfter !== undefined &&
      Number.isFinite(Number(retryAfter)) && { retryAfterMs: Number(retryAfter) * 1000 }),
    cause: err,
  });
}

export class AiSdkClient implements ModelClient {
  constructor(
    private readonly secrets: ProviderSecrets,
    private readonly endpoints: ProviderEndpoints,
    private readonly images?: ImageBytes,
    private readonly openrouter?: OpenRouterRouting,
  ) {}

  async *stream(m: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
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
    // A routing problem never stops the call: it goes out as OpenRouter's default.
    const routing =
      m.provider === 'openrouter' && this.openrouter ? await this.openrouter(m, req).catch(() => null) : null;
    const maxOutputTokens = req.maxOutputTokens ?? routing?.max_tokens ?? undefined;
    const result = streamText({
      model,
      ...(req.system !== undefined && { system: req.system }),
      messages: toSdkMessages(req.messages, {
        tools: m.capabilities.includes('tools'),
        vision,
        ...(images && { images }),
      }) as SdkMessage[],
      // A model without the tools capability is never offered tools: vLLM started
      // without a tool parser refuses the whole request ("auto" tool choice requires
      // --enable-auto-tool-choice), so every turn to such a GPU node failed.
      ...(req.tools?.length &&
        m.capabilities.includes('tools') && {
          tools: Object.fromEntries(
            req.tools.map((t) => [
              t.name,
              tool({
                description: t.description,
                inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
              }),
            ]),
          ) as ToolSet,
        }),
      abortSignal: signal,
      maxRetries: 0, // retries are the gateway's job, with its own policy
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      ...(routing && {
        providerOptions: {
          openrouter: { provider: routing.provider as Record<string, JSONValue>, usage: { include: true } },
        },
      }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    });
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            yield { type: 'text', delta: part.text };
            break;
          case 'reasoning-delta':
            yield { type: 'reasoning', delta: part.text };
            break;
          case 'tool-call':
            yield { type: 'tool_call', callId: part.toolCallId, tool: part.toolName, args: part.input };
            break;
          case 'error':
            throw wrap(part.error);
          case 'finish': {
            const or = (part as { providerMetadata?: { openrouter?: Partial<Served> } }).providerMetadata
              ?.openrouter;
            yield {
              type: 'finish',
              finishReason: part.finishReason,
              ...(m.provider === 'openrouter' &&
                or && {
                  served: { provider: or.provider ?? null, model: or.model ?? null },
                  ...(typeof or.cost === 'number' && { costUsd: or.cost }),
                }),
              usage: {
                inputTokens: part.totalUsage.inputTokens ?? 0,
                outputTokens: part.totalUsage.outputTokens ?? 0,
                cachedTokens: part.totalUsage.cachedInputTokens ?? 0,
              },
            };
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      throw wrap(err);
    }
  }
}
