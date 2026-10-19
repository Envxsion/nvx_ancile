/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning kept and sent back by each provider's rule (CA1)
 *  Ref      |  ROADMAP.md CA1 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  DeepSeek's thinking mode with tools fails with a 400 when
 *           |  earlier reasoning_content is dropped. These tests capture
 *           |  the request each provider's client sends for the next
 *           |  step of a tool turn and require the reasoning to be in
 *           |  the right field (or absent where the provider must not
 *           |  get it), byte-stable from turn to turn.
 * ------------------------------------------------------------------
 */

import type { ModelConfig, Part } from '@nvx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { appendReasoning } from '../../src/conductor/pipeline';
import { sentOfAnswer, toSdkMessages } from '../../src/gateway/convert';
import { AiSdkClient } from '../../src/gateway/providers';
import { replayFor } from '../../src/gateway/replay';
import type { ModelMessage, ModelRequest, StreamChunk } from '../../src/gateway/types';

const base = {
  via: 'direct' as const,
  family: 'test',
  context_window: 200_000,
  max_output: 8_000,
  capabilities: ['tools'],
  price: { input_per_mtok: 1, output_per_mtok: 2 },
  enabled: true,
};
const model = (provider: string, provider_model: string, extra: Partial<ModelConfig> = {}): ModelConfig =>
  ({
    ...base,
    id: `${provider}/${provider_model}`,
    provider,
    provider_model,
    display_name: provider_model,
    ...extra,
  }) as ModelConfig;

const deepseek = model('deepseek', 'deepseek-v4-pro', { base_url: 'http://deepseek.test/v1' });
const anthropic = model('anthropic', 'claude-sonnet-5-5', { base_url: 'http://anthropic.test/v1' });
const google = model('google', 'gemini-3-pro');
const openrouter = model('openrouter', 'google/gemini-3-pro');
const openai = model('openai', 'gpt-5.6', { base_url: 'http://openai.test/v1' });
const mistral = model('mistral', 'mistral-large', { base_url: 'http://mistral.test/v1' });
const kimi = model('moonshot', 'kimi-k3', { base_url: 'http://kimi.test/v1' });

const TOOLS = [
  { name: 'fs_read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
];
const DETAILS = [{ type: 'reasoning.encrypted', data: 'ENC', index: 0 }];

/** One answer that thought, called a tool, got its result, thought again and spoke. */
const answer = (): Part[] => [
  {
    type: 'reasoning',
    text: 'I need the file first.',
    provider_meta: {
      anthropic: { signature: 'sig-1' },
      openrouter: { reasoning_details: DETAILS },
    },
  },
  {
    type: 'tool_call',
    call_id: 'c1',
    tool: 'fs_read',
    args: { path: 'a.md' },
    provider_meta: { google: { thoughtSignature: 'gsig-1' } },
  },
  { type: 'tool_result', call_id: 'c1', ok: true, result: { content: 'A' } },
  { type: 'reasoning', text: 'It says A.', provider_meta: { anthropic: { signature: 'sig-2' } } },
  { type: 'text', text: 'It says A.' },
];

const history = (parts: Part[] = answer(), over: Partial<ModelMessage> = {}): ModelMessage[] => [
  { role: 'user', content: 'what is in a.md?', parts: [{ type: 'text', text: 'what is in a.md?' }] },
  { role: 'assistant', content: 'It says A.', parts, ...over },
  { role: 'user', content: 'and b.md?', parts: [{ type: 'text', text: 'and b.md?' }] },
];

const secrets = { get: async () => 'test-key' };

/** What the client sends: every request body, the headers, with the call failing so nothing else is needed. */
async function wire(m: ModelConfig, req: Partial<ModelRequest>) {
  const sent: {
    url: string;
    body: Record<string, unknown>;
    text: string;
    headers: Record<string, string>;
  }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body ?? '');
    sent.push({
      url: String(url),
      text,
      body: JSON.parse(text || '{}'),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response('{"error":{"message":"stop here"}}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  const client = new AiSdkClient(secrets, { fetch });
  try {
    for await (const _ of client.stream(
      m,
      { messages: history(), tools: TOOLS, toolChoice: 'auto', ...req },
      new AbortController().signal,
    ));
  } catch {
    // expected: the stub always fails after reading the request
  }
  return sent[0] as (typeof sent)[number];
}

type Msg = Record<string, unknown>;
const messagesOf = (b: Record<string, unknown>) => (b.messages ?? []) as Msg[];

describe('DeepSeek (reasoning_content with tools)', () => {
  it('sends every earlier reasoning_content back, on the message it came from', async () => {
    const r = await wire(deepseek, {});
    const assistants = messagesOf(r.body).filter((x) => x.role === 'assistant');
    expect(assistants[0]).toMatchObject({
      reasoning_content: 'I need the file first.',
      tool_calls: [expect.objectContaining({ id: 'c1' })],
    });
    expect(assistants[1]).toMatchObject({ reasoning_content: 'It says A.', content: 'It says A.' });
    // Provider-specific signatures do not travel to a provider that did not issue them.
    expect(r.text).not.toContain('sig-1');
    expect(r.text).not.toContain('gsig-1');
    expect(r.text).not.toContain('ENC');
  });

  it('sends none when the request offers no tools (only a tool loop needs it)', async () => {
    const r = await wire(deepseek, { tools: [] });
    expect(r.text).not.toContain('reasoning_content');
  });

  it('keeps reasoning across a change of epoch: DeepSeek wants all of it back', async () => {
    const r = await wire(deepseek, {
      messages: history(answer(), { epochId: 'epc_old' }),
      cache: { threadId: 't', branch: 'b', epochId: 'epc_new' },
    });
    expect(r.text).toContain('I need the file first.');
  });

  it('keeps a cancelled stream exactly as far as it got (plain text cannot be rejected)', async () => {
    const parts: Part[] = [
      { type: 'reasoning', text: 'Let me think about the' },
      { type: 'text', text: 'Partly...' },
    ];
    const r = await wire(deepseek, { messages: history(parts) });
    expect(messagesOf(r.body).find((x) => x.role === 'assistant')).toMatchObject({
      reasoning_content: 'Let me think about the',
    });
  });
});

describe('Kimi (always)', () => {
  it('sends reasoning_content back even without tools', async () => {
    const r = await wire(kimi, { tools: [] });
    expect(r.text).toContain('I need the file first.');
  });
});

describe('Anthropic (thinking blocks, unchanged, with their signatures)', () => {
  it('sends each thinking block with its signature, before the tool call', async () => {
    const r = await wire(anthropic, {});
    const content = messagesOf(r.body).filter((x) => x.role === 'assistant')[0]?.content as Msg[];
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'I need the file first.', signature: 'sig-1' });
    expect(content[1]).toMatchObject({ type: 'tool_use', id: 'c1' });
    const second = messagesOf(r.body).filter((x) => x.role === 'assistant')[1]?.content as Msg[];
    expect(second[0]).toEqual({ type: 'thinking', thinking: 'It says A.', signature: 'sig-2' });
    expect(r.text).not.toContain('gsig-1');
  });

  it('drops a block cut off before its signature arrived, whole', async () => {
    const parts: Part[] = [
      { type: 'reasoning', text: 'Half a thought' },
      { type: 'text', text: 'Partly...' },
    ];
    const r = await wire(anthropic, { messages: history(parts) });
    expect(r.text).not.toContain('Half a thought');
    expect(r.text).not.toContain('"thinking"');
  });

  it('does not replay reasoning written in another epoch, whose signature belongs to its settings', async () => {
    const cache = { threadId: 't', branch: 'b', epochId: 'epc_new' };
    const old = await wire(anthropic, { messages: history(answer(), { epochId: 'epc_old' }), cache });
    expect(old.text).not.toContain('sig-1');
    const same = await wire(anthropic, { messages: history(answer(), { epochId: 'epc_new' }), cache });
    expect(same.text).toContain('sig-1');
  });
});

describe('Gemini (thought signature on the function-call turn)', () => {
  it('sends the signature on the function call and no reasoning text', async () => {
    const r = await wire(google, {});
    const contents = (r.body.contents ?? []) as { role: string; parts: Msg[] }[];
    const call = contents.flatMap((c) => c.parts).find((p) => p.functionCall);
    expect(call).toMatchObject({ functionCall: { name: 'fs_read' }, thoughtSignature: 'gsig-1' });
    expect(r.text).not.toContain('I need the file first.');
    expect(r.text).not.toContain('"sig-1"');
  });
});

describe('OpenRouter (reasoning_details for Anthropic and Gemini upstreams)', () => {
  it('sends reasoning_details on the assistant message, as received', async () => {
    const r = await wire(openrouter, {});
    const first = messagesOf(r.body).find((x) => x.role === 'assistant');
    expect(first?.reasoning_details).toEqual(DETAILS);
    expect(first?.reasoning_content).toBeUndefined();
    expect(r.text).not.toContain('gsig-1');
  });

  it('does not replay across epochs for a Claude model behind it', async () => {
    const claude = model('openrouter', 'anthropic/claude-sonnet-5-5');
    const cache = { threadId: 't', branch: 'b', epochId: 'epc_new' };
    const r = await wire(claude, { messages: history(answer(), { epochId: 'epc_old' }), cache });
    expect(r.text).not.toContain('reasoning_details');
  });
});

describe('providers that must not get reasoning', () => {
  it('OpenAI (Chat has none to return) and Mistral send none, whatever was stored', async () => {
    for (const m of [openai, mistral]) {
      const r = await wire(m, {});
      expect(r.text).not.toContain('I need the file first.');
      expect(r.text).not.toContain('reasoning_content');
      expect(r.text).not.toContain('sig-1');
    }
  });

  it('the rule table: none or unknown means none', () => {
    const ctx = { tools: true };
    expect(replayFor(openai, ctx).mode).toBe('none');
    expect(replayFor(mistral, ctx).mode).toBe('none');
    expect(replayFor(model('fireworks', 'x'), ctx).mode).toBe('none');
    expect(replayFor(model('endpoint-pod', 'x'), ctx).mode).toBe('none');
    expect(replayFor({ ...deepseek, via: 'controller' }, ctx).mode).toBe('none');
    expect(replayFor(deepseek, ctx).mode).toBe('text');
    expect(replayFor(deepseek, { tools: false }).mode).toBe('none');
    expect(replayFor(kimi, { tools: false }).mode).toBe('text');
    expect(replayFor(anthropic, ctx)).toMatchObject({ mode: 'blocks', acrossEpochs: false });
    expect(replayFor(google, ctx).mode).toBe('calls');
    expect(replayFor(openrouter, ctx).mode).toBe('details');
  });
});

describe('stored as received, and the same every turn', () => {
  it('the stored sent form keeps reasoning and signatures whatever the next provider is', () => {
    const stored = JSON.parse(sentOfAnswer(answer()) as string) as Msg[];
    const first = (stored[0]?.content ?? []) as Msg[];
    expect(first[0]).toMatchObject({
      type: 'reasoning',
      text: 'I need the file first.',
      providerOptions: { anthropic: { signature: 'sig-1' } },
    });
    expect(first[1]).toMatchObject({
      type: 'tool-call',
      providerOptions: { google: { thoughtSignature: 'gsig-1' } },
    });
  });

  it('turn N+1 starts with the bytes of turn N, reasoning included', async () => {
    const q1 = history()[0] as ModelMessage;
    const turn1 = await wire(deepseek, { messages: [q1] });
    const a = {
      role: 'assistant' as const,
      content: 'It says A.',
      parts: answer(),
      sent: sentOfAnswer(answer()) as string,
    };
    const turn2 = await wire(deepseek, {
      messages: [q1, a, { role: 'user', content: 'and b.md?', parts: [{ type: 'text', text: 'and b.md?' }] }],
    });
    const m1 = messagesOf(turn1.body);
    const m2 = messagesOf(turn2.body);
    expect(JSON.stringify(m2.slice(0, m1.length))).toBe(JSON.stringify(m1));
    // Turn 3 starts with turn 2, including the reasoning that came back in it.
    const q2 = {
      role: 'user' as const,
      content: 'and b.md?',
      parts: [{ type: 'text' as const, text: 'and b.md?' }],
    };
    const b = { role: 'assistant' as const, content: 'B.', parts: [{ type: 'text' as const, text: 'B.' }] };
    const turn3 = await wire(deepseek, { messages: [q1, a, q2, b, { role: 'user', content: 'ok' }] });
    expect(JSON.stringify(messagesOf(turn3.body).slice(0, m2.length))).toBe(JSON.stringify(m2));
  });

  it('an older answer sent before reasoning was kept is rebuilt from its parts, the same way each turn', async () => {
    const withoutReasoning = JSON.stringify([
      { role: 'assistant', content: [{ type: 'text', text: 'It says A.' }] },
    ]);
    const msgs = history(answer(), { sent: withoutReasoning });
    const r1 = await wire(deepseek, { messages: msgs });
    const r2 = await wire(deepseek, { messages: msgs });
    expect(r1.text).toContain('reasoning_content');
    expect(r1.text).toBe(r2.text);
  });

  it('a provider that takes none leaves the stored text alone', () => {
    const out = toSdkMessages(history(answer()), { tools: true });
    expect(JSON.stringify(out)).not.toContain('reasoning');
    expect(JSON.stringify(out)).not.toContain('sig-');
  });
});

describe('what arrives from the stream', () => {
  it('appendReasoning keeps blocks apart and attaches what was signed', () => {
    const parts: Part[] = [];
    const st = { fresh: false };
    appendReasoning(parts, { delta: '', block: true }, st);
    appendReasoning(parts, { delta: 'one ' }, st);
    appendReasoning(parts, { delta: 'two' }, st);
    appendReasoning(parts, { delta: '', meta: { anthropic: { signature: 's1' } } }, st);
    appendReasoning(parts, { delta: '', block: true }, st);
    appendReasoning(parts, { delta: 'three' }, st);
    expect(parts).toEqual([
      { type: 'reasoning', text: 'one two', provider_meta: { anthropic: { signature: 's1' } } },
      { type: 'reasoning', text: 'three' },
    ]);
  });

  it('reads Anthropic thinking with its signature from the wire', async () => {
    const sse = (events: [string, unknown][]) =>
      new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const fetch = vi.fn(async () =>
      sse([
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5-5',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm.' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'content_block_start',
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        [
          'message_delta',
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        ],
        ['message_stop', { type: 'message_stop' }],
      ]),
    ) as unknown as typeof globalThis.fetch;
    const client = new AiSdkClient(secrets, { fetch });
    const out: StreamChunk[] = [];
    for await (const c of client.stream(
      anthropic,
      { messages: history().slice(0, 1) },
      new AbortController().signal,
    ))
      out.push(c);
    const parts: Part[] = [];
    const st = { fresh: false };
    for (const c of out) if (c.type === 'reasoning') appendReasoning(parts, c, st);
    expect(parts).toEqual([
      { type: 'reasoning', text: 'Hmm.', provider_meta: { anthropic: { signature: 'SIG' } } },
    ]);
  });
});
