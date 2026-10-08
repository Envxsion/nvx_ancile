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
 *           |  check. TODO(phase-4): provider options (reasoning effort,
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
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  streamText,
  type ToolSet,
  tool,
} from 'ai';
import { toSdkMessages } from './convert';
import type { ModelClient, ModelRequest, StreamChunk } from './types';

export interface ProviderSecrets {
  /** Resolve a secret by name (from the encrypted store). */
  get(name: string): Promise<string | undefined>;
}

export interface ProviderEndpoints {
  controllerUrl?: string | undefined;
  controllerToken?: string | undefined;
  ollamaUrl?: string | undefined;
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
      name: 'controller',
      baseURL: `${ep.controllerUrl.replace(/\/$/, '')}/v1`,
      ...(!!ep.controllerToken && { apiKey: ep.controllerToken }),
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
        name: 'openrouter',
        baseURL: m.base_url ?? 'https://openrouter.ai/api/v1',
        apiKey: needKey('OpenRouter'),
      })(m.provider_model);
    case 'ollama':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: m.base_url ?? `${(ep.ollamaUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
      })(m.provider_model);
    default:
      if (!m.base_url)
        throw new ClassifiedError(
          'permanent',
          `${m.display_name} has no base_url; any OpenAI-compatible endpoint needs one.`,
        );
      return createOpenAICompatible({ name: m.provider, baseURL: m.base_url, ...(!!apiKey && { apiKey }) })(
        m.provider_model,
      );
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
  ) {}

  async *stream(m: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const model = await languageModelFor(m, this.secrets, this.endpoints);
    const result = streamText({
      model,
      ...(req.system !== undefined && { system: req.system }),
      messages: toSdkMessages(req.messages, { tools: m.capabilities.includes('tools') }) as SdkMessage[],
      ...(req.tools?.length && {
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
      ...(req.maxOutputTokens !== undefined && { maxOutputTokens: req.maxOutputTokens }),
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
          case 'finish':
            yield {
              type: 'finish',
              finishReason: part.finishReason,
              usage: {
                inputTokens: part.totalUsage.inputTokens ?? 0,
                outputTokens: part.totalUsage.outputTokens ?? 0,
                cachedTokens: part.totalUsage.cachedInputTokens ?? 0,
              },
            };
            break;
          default:
            break;
        }
      }
    } catch (err) {
      throw wrap(err);
    }
  }
}
