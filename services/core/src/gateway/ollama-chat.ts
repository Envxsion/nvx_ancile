/**
 * ------------------------------------------------------------------
 *  Title    |  Ollama, as a model
 *  Ref      |  docs/models.md (Ollama), DESIGN.md §7
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Talk to Ollama through its own /api/chat, so every call
 *           |  says how much context to load (options.num_ctx). Its
 *           |  OpenAI-compatible endpoint cannot, and Ollama then uses
 *           |  its server default (2,048 or 4,096 tokens) and silently
 *           |  drops the start of a longer prompt.
 *  How      |  Messages go through toSdkMessages (one normalisation for
 *           |  every provider) and are reshaped for Ollama. The reply is
 *           |  newline-delimited JSON; the last line carries the counts.
 *           |  When Ollama reports reading far fewer prompt tokens than
 *           |  were sent, and the count sits at a typical server window,
 *           |  the stream carries a warning, once per thread and model.
 *  Note     |  num_ctx is the model's configured window, capped by
 *           |  OLLAMA_MAX_CONTEXT so a large window does not overflow a
 *           |  small GPU. Context assembly budgets to the same number
 *           |  (servedWindow), so what is sent always fits.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { ClassifiedError, classifyStatus } from '@nvx/resilience';
import { tracedFetch } from '../context';
import { type SdkMessage, toSdkMessages } from './convert';
import { effortOptions } from './effort';
import type { ModelRequest, StreamChunk } from './types';

/** The most context Ollama is asked to load, whatever a model's card says. */
export const OLLAMA_MAX_CONTEXT = 32_768;

/** Ollama's own defaults: a prompt read up to one of these was cut by the server. */
const SERVER_DEFAULTS = [2_048, 4_096, 8_192];

export const TRUNCATED_WARNING = {
  code: 'model.context_truncated',
  message:
    'This local model only read part of the conversation. Raise its context length in Ollama, or choose a model with a larger window.',
} as const;

/** True when a model is served by Ollama directly (not through the Controller). */
export function isOllama(m: Pick<ModelConfig, 'provider' | 'via'>): boolean {
  return m.provider === 'ollama' && m.via !== 'controller';
}

/** The window a model really gets: for Ollama, the num_ctx it is asked for. */
export function servedWindow(m: Pick<ModelConfig, 'provider' | 'via' | 'context_window'>): number {
  return isOllama(m) ? Math.min(m.context_window, OLLAMA_MAX_CONTEXT) : m.context_window;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

/** The SDK-shaped messages, as Ollama's /api/chat takes them. */
export function toOllamaMessages(msgs: SdkMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content });
    else if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ role: 'user', content: m.content });
      else {
        const text = m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
        const images = m.content.flatMap((c) =>
          c.type === 'image' ? [Buffer.from(c.image).toString('base64')] : [],
        );
        out.push({ role: 'user', content: text, ...(images.length > 0 && { images }) });
      }
    } else if (m.role === 'assistant') {
      const text = m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
      const calls = m.content.flatMap((c) =>
        c.type === 'tool-call' ? [{ function: { name: c.toolName, arguments: c.input ?? {} } }] : [],
      );
      out.push({ role: 'assistant', content: text, ...(calls.length > 0 && { tool_calls: calls }) });
    } else {
      for (const c of m.content) {
        if (c.type !== 'tool-result') continue;
        const v = c.output.value;
        out.push({
          role: 'tool',
          tool_name: c.toolName,
          content: typeof v === 'string' ? v : JSON.stringify(v),
        });
      }
    }
  }
  return out;
}

/** About how many tokens a request is, the way context assembly counts them. */
function estimate(system: string | undefined, msgs: OllamaMessage[]): number {
  let chars = system?.length ?? 0;
  for (const m of msgs) chars += m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  return Math.ceil(chars / 4);
}

/** Ollama read far less than was sent, and stopped at a typical window: it cut the prompt. */
export function looksTruncated(sent: number, read: number, numCtx: number): boolean {
  if (read <= 0 || sent < read * 1.5) return false;
  return [...SERVER_DEFAULTS, numCtx].some((n) => Math.abs(read - n) <= n * 0.05);
}

interface OllamaLine {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface OllamaChatOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Threads already warned, by `${threadId}:${modelId}`. */
  warned?: Set<string>;
  /** Image bytes, by URL, for a vision model (providers.imagesFor). */
  images?: ReadonlyMap<string, { data: Uint8Array; mime: string }>;
}

const warnedDefault = new Set<string>();

export async function* ollamaChat(
  m: ModelConfig,
  req: ModelRequest,
  signal: AbortSignal,
  opts: OllamaChatOptions,
): AsyncGenerator<StreamChunk> {
  const doFetch = opts.fetch ?? (tracedFetch as typeof fetch);
  const warned = opts.warned ?? warnedDefault;
  const tools = m.capabilities.includes('tools');
  const vision = m.capabilities.includes('vision');
  const messages = toOllamaMessages(
    toSdkMessages(req.messages, { tools, vision, ...(opts.images && { images: opts.images }) }),
  );
  if (req.system !== undefined) messages.unshift({ role: 'system', content: req.system });
  const numCtx = req.local?.numCtx ?? servedWindow(m);
  const think = effortOptions(m, req.effort).think;
  const body = {
    model: m.provider_model,
    messages,
    stream: true,
    // LM1: a notebook's keep-alive preset (Pro).
    ...(req.local?.keepAlive !== undefined && { keep_alive: req.local.keepAlive }),
    // EN1: gpt-oss reads "low", "medium" or "high"; undefined for a model that takes no effort.
    ...(think && { think }),
    options: {
      num_ctx: numCtx,
      // LM1: GPU layers, only when something chose them (0 is a choice: CPU only).
      ...(req.local?.numGpu !== undefined && { num_gpu: req.local.numGpu }),
      ...(req.maxOutputTokens !== undefined && { num_predict: req.maxOutputTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    },
    ...(tools &&
      req.tools?.length && {
        tools: req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
  };
  const base = opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  let res: Response;
  try {
    res = await doFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ClassifiedError('transient', `Ollama did not answer at ${base}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* plain text */
    }
    throw new ClassifiedError(
      classifyStatus(res.status, detail),
      `Ollama answered ${res.status}: ${detail.slice(0, 300)}`,
      {
        status: res.status,
      },
    );
  }

  const sent = estimate(req.system, messages);
  const decoder = new TextDecoder();
  let buf = '';
  let calls = 0;
  const handle = function* (line: OllamaLine): Generator<StreamChunk> {
    if (line.error) throw new ClassifiedError('transient', `Ollama stopped: ${line.error}`);
    const msg = line.message;
    if (msg?.thinking) yield { type: 'reasoning', delta: msg.thinking };
    if (msg?.content) yield { type: 'text', delta: msg.content };
    for (const c of msg?.tool_calls ?? []) {
      if (!c.function?.name) continue;
      calls += 1;
      yield {
        type: 'tool_call',
        callId: `ollama-${Date.now().toString(36)}-${calls}`,
        tool: c.function.name,
        args: c.function.arguments ?? {},
      };
    }
    if (line.done) {
      const read = line.prompt_eval_count ?? 0;
      const key = `${req.meta?.threadId ?? ''}:${m.id}`;
      if (looksTruncated(sent, read, numCtx) && !warned.has(key)) {
        warned.add(key);
        yield { type: 'warning', ...TRUNCATED_WARNING };
      }
      yield {
        type: 'finish',
        finishReason: calls > 0 ? 'tool-calls' : line.done_reason === 'length' ? 'length' : 'stop',
        usage: { inputTokens: read, outputTokens: line.eval_count ?? 0 },
      };
    }
  };
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (raw) yield* handle(JSON.parse(raw) as OllamaLine);
        nl = buf.indexOf('\n');
      }
      if (done) break;
    }
    if (buf.trim()) yield* handle(JSON.parse(buf.trim()) as OllamaLine);
  } finally {
    reader.releaseLock();
  }
}
