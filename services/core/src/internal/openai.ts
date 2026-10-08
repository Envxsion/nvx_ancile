/**
 * ------------------------------------------------------------------
 *  Title    |  Internal OpenAI-compatible endpoint
 *  Ref      |  DESIGN.md §1.2, §4.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every other Ancile service that spends tokens (the lab's
 *           |  agent engine now, Knowledge in Phase 3) calls these
 *           |  routes with any OpenAI client, and the calls go through
 *           |  the same gateway, fallbacks, refusal handling and traces
 *           |  as chat. No service holds a provider key but Core.
 *  How      |  `model` is a model id ("anthropic/claude-sonnet-5-5"),
 *           |  a task class ("chat.default", "utility"), or "ancile"
 *           |  for the default chain. OpenAI messages become Ancile
 *           |  parts (tool calls and their results folded into the
 *           |  assistant turn), the gateway streams, and the stream is
 *           |  written back as OpenAI chunks, tool calls included.
 *  Note     |  Tool calls are returned, never executed here: the caller
 *           |  (the agent engine) runs its own tools behind Core's
 *           |  permission bridge. TODO(phase-3): embeddings.
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import type { Part } from '@nvx/contracts';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ChainFailedError, type Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import { NoRouteError } from '../gateway/router';
import type { ModelMessage, ModelRequest, ToolDef } from '../gateway/types';
import { body } from '../http/body';
import { notImplemented } from '../obs/errors';

const Content = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  z.null(),
]);

const ChatMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: Content }).passthrough(),
  z.object({ role: z.literal('developer'), content: Content }).passthrough(),
  z.object({ role: z.literal('user'), content: Content }).passthrough(),
  z
    .object({
      role: z.literal('assistant'),
      content: Content.optional(),
      tool_calls: z
        .array(
          z.object({
            id: z.string(),
            type: z.literal('function').optional(),
            function: z.object({ name: z.string(), arguments: z.string() }),
          }),
        )
        .optional(),
    })
    .passthrough(),
  z.object({ role: z.literal('tool'), tool_call_id: z.string(), content: Content }).passthrough(),
]);

export const ChatCompletionRequest = z
  .object({
    model: z.string(),
    messages: z.array(ChatMessage).min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()).optional(),
          }),
        }),
      )
      .optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
  })
  .passthrough();

type ChatRequest = z.infer<typeof ChatCompletionRequest>;

const text = (c: z.infer<typeof Content> | undefined): string =>
  c == null
    ? ''
    : typeof c === 'string'
      ? c
      : c.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])).join('');

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw };
  }
}

/** OpenAI chat messages → Ancile's request: system prompt, then messages with parts. */
export function fromOpenAI(req: ChatRequest): ModelRequest {
  const system: string[] = [];
  const messages: ModelMessage[] = [];
  const owner = new Map<string, ModelMessage>(); // call id → assistant message holding it
  for (const m of req.messages) {
    if (m.role === 'system' || m.role === 'developer') system.push(text(m.content));
    else if (m.role === 'user')
      messages.push({
        role: 'user',
        content: text(m.content),
        parts: [{ type: 'text', text: text(m.content) }],
      });
    else if (m.role === 'assistant') {
      const parts: Part[] = [];
      const t = text(m.content);
      if (t) parts.push({ type: 'text', text: t });
      for (const call of m.tool_calls ?? [])
        parts.push({
          type: 'tool_call',
          call_id: call.id,
          tool: call.function.name,
          args: parseArgs(call.function.arguments),
        });
      const msg: ModelMessage = { role: 'assistant', content: t, parts };
      for (const call of m.tool_calls ?? []) owner.set(call.id, msg);
      messages.push(msg);
    } else if (m.role === 'tool') {
      const host = owner.get(m.tool_call_id);
      const result: Part = {
        type: 'tool_result',
        call_id: m.tool_call_id,
        ok: true,
        result: text(m.content),
      };
      if (host) host.parts?.push(result);
      else messages.push({ role: 'assistant', content: '', parts: [result] });
    }
  }
  const tools: ToolDef[] = (req.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    inputSchema: (t.function.parameters as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
    },
  }));
  const maxOut = req.max_completion_tokens ?? req.max_tokens;
  return {
    ...(system.length && { system: system.join('\n\n') }),
    messages,
    ...(tools.length && { tools }),
    ...(maxOut !== undefined && { maxOutputTokens: maxOut }),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
  };
}

export interface InternalDeps {
  registry: ModelRegistry;
  gateway: Gateway;
}

const FINISH: Record<string, string> = {
  'tool-calls': 'tool_calls',
  length: 'length',
  'content-filter': 'content_filter',
};

function openAIError(status: number, message: string, type: string) {
  return { status, body: { error: { message, type, code: type } } };
}

export function internalRoutes(deps?: InternalDeps) {
  const r = new Hono();

  r.get('/openai/models', (c) => {
    const data = deps
      ? deps.registry
          .info()
          .filter(
            (m) =>
              m.status === 'ready' &&
              !m.capabilities.includes('embeddings') &&
              !m.capabilities.includes('rerank'),
          )
          .map((m) => ({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: m.provider,
            name: m.display_name,
            context_window: m.context_window,
          }))
      : [];
    return c.json({ object: 'list', data });
  });

  r.post('/openai/embeddings', () => {
    throw notImplemented(3, 'The internal embeddings endpoint');
  });

  r.post('/openai/chat/completions', async (c) => {
    if (!deps) throw notImplemented(2, 'The internal model endpoint');
    const req = await body(c, ChatCompletionRequest);
    const isModelId = !!deps.registry.get(req.model);
    const taskClass = isModelId || req.model === 'ancile' ? 'chat.default' : req.model;
    let chain: ReturnType<ModelRegistry['chain']>;
    try {
      chain = deps.registry.chain(taskClass, isModelId ? req.model : null);
    } catch (err) {
      const e = openAIError(503, (err as Error).message, 'model_not_configured');
      return c.json(e.body, e.status as 503);
    }
    const mreq = fromOpenAI(req);
    const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const abort = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => abort.abort());

    if (!req.stream) {
      let content = '';
      let answeredBy = chain[0]?.id ?? req.model;
      const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
      let finish = 'stop';
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      try {
        for await (const ev of deps.gateway.stream(chain, mreq, abort.signal)) {
          if (ev.type === 'model') answeredBy = ev.modelId;
          if (ev.type !== 'chunk') continue;
          const ch = ev.chunk;
          if (ch.type === 'text') content += ch.delta;
          else if (ch.type === 'tool_call')
            calls.push({
              id: ch.callId,
              type: 'function',
              function: { name: ch.tool, arguments: JSON.stringify(ch.args ?? {}) },
            });
          else if (ch.type === 'finish') {
            finish = FINISH[ch.finishReason] ?? 'stop';
            usage.prompt_tokens += ch.usage.inputTokens;
            usage.completion_tokens += ch.usage.outputTokens;
          }
        }
      } catch (err) {
        const status = err instanceof ChainFailedError || err instanceof NoRouteError ? 503 : 500;
        const e = openAIError(status, (err as Error).message, 'upstream_failed');
        return c.json(e.body, e.status as 503);
      }
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      return c.json({
        id,
        object: 'chat.completion',
        created,
        model: answeredBy,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: content || null,
              ...(calls.length && { tool_calls: calls }),
            },
            finish_reason: calls.length ? 'tool_calls' : finish,
          },
        ],
        usage,
      });
    }

    return streamSSE(c, async (stream) => {
      let model = chain[0]?.id ?? req.model;
      let toolIndex = 0;
      let sawTools = false;
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let finish = 'stop';
      const send = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        stream.writeSSE({
          data: JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }),
        });
      stream.onAbort(() => abort.abort());
      try {
        await send({ role: 'assistant', content: '' });
        for await (const ev of deps.gateway.stream(chain, mreq, abort.signal)) {
          if (ev.type === 'model') model = ev.modelId;
          if (ev.type !== 'chunk') continue;
          const ch = ev.chunk;
          if (ch.type === 'text') await send({ content: ch.delta });
          else if (ch.type === 'reasoning') await send({ reasoning_content: ch.delta });
          else if (ch.type === 'tool_call') {
            sawTools = true;
            await send({
              tool_calls: [
                {
                  index: toolIndex++,
                  id: ch.callId,
                  type: 'function',
                  function: { name: ch.tool, arguments: JSON.stringify(ch.args ?? {}) },
                },
              ],
            });
          } else if (ch.type === 'finish') {
            finish = FINISH[ch.finishReason] ?? 'stop';
            usage.prompt_tokens += ch.usage.inputTokens;
            usage.completion_tokens += ch.usage.outputTokens;
          }
        }
        await send({}, sawTools ? 'tool_calls' : finish);
        if (req.stream_options?.include_usage) {
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          await stream.writeSSE({
            data: JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage }),
          });
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          await stream.writeSSE({
            data: JSON.stringify({ error: { message: (err as Error).message, type: 'upstream_failed' } }),
          });
        }
      }
      await stream.writeSSE({ data: '[DONE]' });
    });
  });

  return r;
}
