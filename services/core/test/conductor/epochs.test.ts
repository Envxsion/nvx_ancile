/**
 * ------------------------------------------------------------------
 *  Title    |  Prompts that start the same way (CA2, CA3, CA4)
 *  Ref      |  ROADMAP.md CA2-CA4 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Providers cache a request by its exact start. These tests
 *           |  capture what the model client is sent for turn N and
 *           |  turn N+1 of one thread, render it the way Anthropic's
 *           |  messages and an OpenAI-compatible endpoint read it, and
 *           |  require turn N's tools, system and every message to be a
 *           |  strict prefix of turn N+1's. They also pin when a new
 *           |  epoch may start, and that a declared tool still goes
 *           |  through permissions at the moment it runs.
 * ------------------------------------------------------------------
 */

import type { Message, Part, SearchResponse } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeTarget,
  cacheTtlMs,
  contextBlock,
  type EpochRecord,
  epochReason,
  MCP_BRIDGE_NAME,
  newTrack,
  toolDrift,
  toolsBlock,
  toolsInScope,
} from '../../src/conductor/epoch';
import { sentOfAnswer, toSdkMessages } from '../../src/gateway/convert';
import type { ModelRequest } from '../../src/gateway/types';
import type { ToolSpec } from '../../src/tools/registry';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

// Each test runs several full turns through the conductor; under a loaded parallel run 5 s is too tight.
vi.setConfig({ testTimeout: 15_000 });

let h: Harness;
afterEach(async () => h?.close());

/* ---- what each provider path reads ------------------------------------------ */

type Wire = { head: { tools: string; system: string }; blocks: string[] };

const resultText = (o: { type: string; value: unknown }) =>
  typeof o.value === 'string' ? o.value : JSON.stringify(o.value);

/** Anthropic's messages: tools, then system, then content blocks in order. */
function anthropic(req: ModelRequest): Wire {
  const blocks: string[] = [];
  for (const m of toSdkMessages(req.messages, { tools: true })) {
    if (m.role === 'user')
      blocks.push(JSON.stringify({ role: 'user', type: 'text', text: JSON.stringify(m.content) }));
    else if (m.role === 'assistant')
      for (const c of m.content)
        blocks.push(
          JSON.stringify(
            c.type === 'text'
              ? { role: 'assistant', type: 'text', text: c.text }
              : c.type === 'tool-call'
                ? { role: 'assistant', type: 'tool_use', id: c.toolCallId, name: c.toolName, input: c.input }
                : c,
          ),
        );
    else if (m.role === 'tool')
      for (const c of m.content)
        if (c.type === 'tool-result')
          blocks.push(
            JSON.stringify({
              role: 'user',
              type: 'tool_result',
              tool_use_id: c.toolCallId,
              content: resultText(c.output),
            }),
          );
  }
  return {
    head: {
      tools: JSON.stringify(
        (req.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      ),
      system: req.system ?? '',
    },
    blocks,
  };
}

/** An OpenAI-compatible chat request: tools, then one message per entry. */
function openai(req: ModelRequest): Wire {
  const blocks: string[] = [];
  blocks.push(JSON.stringify({ role: 'system', content: req.system ?? '' }));
  for (const m of toSdkMessages(req.messages, { tools: true })) {
    if (m.role === 'user') blocks.push(JSON.stringify({ role: 'user', content: m.content }));
    else if (m.role === 'assistant') {
      const text = m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
      const calls = m.content.flatMap((c) =>
        c.type === 'tool-call'
          ? [
              {
                id: c.toolCallId,
                type: 'function',
                function: { name: c.toolName, arguments: JSON.stringify(c.input) },
              },
            ]
          : [],
      );
      blocks.push(
        JSON.stringify({
          role: 'assistant',
          content: text || null,
          ...(calls.length && { tool_calls: calls }),
        }),
      );
    } else if (m.role === 'tool')
      for (const c of m.content)
        if (c.type === 'tool-result')
          blocks.push(
            JSON.stringify({ role: 'tool', tool_call_id: c.toolCallId, content: resultText(c.output) }),
          );
  }
  return {
    head: {
      tools: JSON.stringify(
        (req.tools ?? []).map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      ),
      system: '',
    },
    blocks,
  };
}

/** Turn N's request must be the start of turn N+1's, byte for byte, on both provider paths. */
function expectPrefix(a: ModelRequest, b: ModelRequest) {
  for (const render of [anthropic, openai]) {
    const x = render(a);
    const y = render(b);
    expect(y.head.tools).toBe(x.head.tools);
    expect(y.head.system).toBe(x.head.system);
    expect(y.blocks.length).toBeGreaterThan(x.blocks.length - 1);
    expect(y.blocks.slice(0, x.blocks.length)).toEqual(x.blocks);
  }
}

const chatCalls = () => h.provider.calls.filter((c) => c.req.tools?.length).map((c) => c.req);
const lastOf = (n: number) => chatCalls().at(n) as ModelRequest;

async function reply(
  t: string,
  text: string,
  parent: string | null = null,
  extra: Record<string, unknown> = {},
) {
  const sent = await h.send(t, text, { parent_id: parent, ...extra });
  await h.settle(sent.run_id);
  return sent;
}

const epochOf = async (messageId: string) =>
  ((await h.repo.getMessage(messageId)) as Message).provenance.epoch as {
    id: string;
    reason: string;
    started: boolean;
  };

const DAY = 86_400_000;

/** An MCP tool that records what it was run with. */
function mcpTool(
  name: string,
  server: string,
  run: (a: unknown) => void = () => undefined,
  description = `Tool ${name}`,
): ToolSpec {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false },
    action: `mcp.${server}.${name.split('__')[1]}`,
    tier: 'auto',
    destructive: false,
    source: { kind: 'mcp', server },
    resource: () => `mcp:${server}/${name.split('__')[1]}`,
    execute: async (args) => {
      run(args);
      return { ok: true, args };
    },
  };
}

const hit = (n: number, text: string) => ({
  kind: 'chunk' as const,
  chunk_id: `chk_${n}`,
  source_id: `src_${n}`,
  source_title: `Source ${n}`,
  text,
  heading_path: [],
  page: n,
  char_start: 0,
  char_end: text.length,
  score: 1,
  rerank_score: null,
  ranks: { vector: n, text: n },
});
const passages = (...texts: string[]): SearchResponse => ({
  hits: texts.map((t, i) => hit(i + 1, t)),
  mode: 'hybrid',
  embedder: 'local/test',
  ms: 1,
});

/* ---- the prefix test ------------------------------------------------------------ */

describe('turn N is the start of turn N+1', () => {
  it('holds for a plain turn', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/say first answer');
    await reply(t, 'a second question', a.assistant_message_id);
    expectPrefix(lastOf(0), lastOf(1));
    // Nothing that varies is in the system prompt.
    expect(lastOf(1).system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('holds when a turn is grounded in passages, and the passages stay with their question', async () => {
    let n = 0;
    h = await harness({
      retriever: {
        search: async () =>
          ++n === 1
            ? passages('The P-300 pump moves 42 litres a minute.')
            : passages('Service intervals are every 600 hours.'),
      },
    });
    const t = await h.newThread({ notebook_id: 'nbk_pumps' });
    const a = await reply(t, '/say It moves 42 litres a minute [1].');
    await reply(t, 'How often is it serviced?', a.assistant_message_id);
    expectPrefix(lastOf(0), lastOf(1));
    // The first question is sent again as it was sent: with its own passages.
    const blocks = anthropic(lastOf(1)).blocks;
    expect(blocks[0]).toContain('The P-300 pump moves 42 litres a minute.');
    const msgs = lastOf(1).messages;
    expect(msgs.at(-1)?.content).toContain('Service intervals are every 600 hours.');
    expect(msgs.at(-1)?.content).not.toContain('42 litres');
  });

  it('holds across a tool call and its result, within the turn and into the next', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/tool fs_list {"path":"/workspace"}');
    const calls = chatCalls();
    expect(calls).toHaveLength(2);
    expectPrefix(calls[0] as ModelRequest, calls[1] as ModelRequest);
    await reply(t, 'and now?', a.assistant_message_id);
    expectPrefix(lastOf(1), lastOf(2));
  });

  it('holds when memory was written between the turns, and says so at the end', async () => {
    h = await harness({ memory: true });
    const t = await h.newThread();
    const a = await reply(t, '/say first');
    const file = await (h.memory as NonNullable<typeof h.memory>).file('USER.md');
    await (h.memory as NonNullable<typeof h.memory>).save('USER.md', {
      content: file.content.replace('## Preferences\n', '## Preferences\n- Always use metric units.\n'),
      base_sha: file.version,
    });
    await reply(t, 'second', a.assistant_message_id);
    expectPrefix(lastOf(0), lastOf(1));
    const end = lastOf(1).messages.at(-1)?.content ?? '';
    expect(end).toMatch(/Memory update \(commit [0-9a-f]{7}\)/);
    expect(end).toContain('Always use metric units.');
    expect(lastOf(1).system).not.toContain('metric');
    // It is said once: the turn after it does not repeat it.
    const b = (await h.repo.messages(t)).filter((m) => m.role === 'assistant').at(-1) as Message;
    await reply(t, 'third', b.id);
    expect(lastOf(2).messages.at(-1)?.content).not.toContain('Memory update');
    expectPrefix(lastOf(1), lastOf(2));
  });

  it('holds when an MCP server reconnects with the same tools', async () => {
    h = await harness();
    h.tools.register(mcpTool('srv__echo', 'srv'));
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    h.tools.unregisterSource((s) => s.kind === 'mcp');
    h.tools.register(mcpTool('srv__echo', 'srv'));
    await reply(t, 'two', a.assistant_message_id);
    expectPrefix(lastOf(0), lastOf(1));
    const first = await epochOf(a.assistant_message_id);
    const second = await epochOf(
      ((await h.repo.messages(t)).filter((m) => m.role === 'assistant').at(-1) as Message).id,
    );
    expect(second).toMatchObject({ id: first.id, started: false });
  });

  it('holds when a new MCP server appears mid-thread: the bridge reaches it, nothing declared changes', async () => {
    const ran: unknown[] = [];
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    h.tools.register(mcpTool('late__ping', 'late', (x) => ran.push(x), 'Ping the late server.'));
    const b = await reply(
      t,
      `/tool ${MCP_BRIDGE_NAME} {"name":"late__ping","arguments":{"x":7}}`,
      a.assistant_message_id,
    );
    expectPrefix(lastOf(0), lastOf(1));
    expect(lastOf(1).tools?.map((x) => x.name)).not.toContain('late__ping');
    expect(lastOf(1).tools?.map((x) => x.name)).toContain(MCP_BRIDGE_NAME);
    // The model is told what it can reach, at the end of the request.
    expect(lastOf(1).messages.at(-1)?.content).toContain('late__ping: Ping the late server.');
    expect(ran).toEqual([{ x: 7 }]);
    // The stored call is the model's own; the step shown is the tool it reached.
    const m = (await h.repo.getMessage(b.assistant_message_id)) as Message;
    expect(m.parts.find((p) => p.type === 'tool_call')).toMatchObject({ tool: MCP_BRIDGE_NAME });
    expectPrefix(lastOf(1), lastOf(2));
    // The next epoch makes it native.
    h.clock.now += DAY;
    const c = (await h.repo.messages(t)).filter((x) => x.role === 'assistant').at(-1) as Message;
    await reply(t, 'once more', c.id);
    expect(lastOf(-1).tools?.map((x) => x.name)).toContain('late__ping');
  });

  it('holds when the date changes between the turns', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    h.clock.now += DAY;
    await reply(t, 'two', a.assistant_message_id);
    expectPrefix(lastOf(0), lastOf(1));
    const day = (r: ModelRequest) =>
      /Today's date: (\d{4}-\d{2}-\d{2})/.exec(r.messages.at(-1)?.content ?? '')?.[1];
    expect(day(lastOf(1))).not.toBe(day(lastOf(0)));
    // Idle for a day is a cold cache, but nothing frozen went stale, so no new epoch.
    const m = (await h.repo.messages(t)).filter((x) => x.role === 'assistant').at(-1) as Message;
    expect((await epochOf(m.id)).started).toBe(false);
  });

  it('holds across several parallel tool results, in call order', () => {
    const call = (n: number): Part => ({
      type: 'tool_call',
      call_id: `c${n}`,
      tool: 'fs_read',
      args: { path: `f${n}` },
    });
    const result = (n: number): Part => ({
      type: 'tool_result',
      call_id: `c${n}`,
      ok: true,
      result: { b: n, a: `r${n}` },
    });
    const round1: Part[] = [{ type: 'text', text: 'Looking.' }, call(1), call(2), result(1), result(2)];
    const sent = JSON.parse(sentOfAnswer([...round1, { type: 'text', text: 'Done.' }]) as string) as {
      role: string;
      content: { toolCallId?: string }[];
    }[];
    expect(sent.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(sent[0]?.content.filter((c) => c.toolCallId).map((c) => c.toolCallId)).toEqual(['c1', 'c2']);
    expect(sent[1]?.content.map((c) => c.toolCallId)).toEqual(['c1', 'c2']);
    // What a round sent is the start of what the answer is stored as.
    const mid = toSdkMessages([{ role: 'assistant', content: '', parts: round1 }]);
    expect(sent.slice(0, mid.length)).toEqual(JSON.parse(JSON.stringify(mid)));
  });
});

/* ---- two threads, one notebook ----------------------------------------------- */

describe('a new thread starts warm', () => {
  it('shares the same tools and system prompt as another thread of its notebook', async () => {
    h = await harness();
    h.tools.register(mcpTool('srv__echo', 'srv'));
    const one = await h.newThread({ notebook_id: 'nbk_pumps' });
    const two = await h.newThread({ notebook_id: 'nbk_pumps' });
    await reply(one, '/say hello');
    await reply(two, 'a different first question');
    const [a, b] = [lastOf(0), lastOf(1)];
    expect(b.system).toBe(a.system);
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    // Their questions differ, so only the start is shared.
    expect(anthropic(a).blocks[0]).not.toBe(anthropic(b).blocks[0]);
  });
});

/* ---- when an epoch may start --------------------------------------------------- */

describe('epochs', () => {
  const answerIds = async (t: string) =>
    (await h.repo.messages(t)).filter((m) => m.role === 'assistant').map((m) => m.id);

  it('start for a new thread and not for time passing, a reconnect or a new date', async () => {
    h = await harness();
    h.tools.register(mcpTool('srv__echo', 'srv'));
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    expect(await epochOf(a.assistant_message_id)).toMatchObject({ reason: 'new_thread', started: true });
    // Time passes, a server reconnects, a new server arrives, the date moves: still the same epoch.
    h.clock.now += 3 * DAY;
    h.tools.unregisterSource((s) => s.kind === 'mcp');
    h.tools.register(mcpTool('srv__echo', 'srv'));
    const b = await reply(t, 'two', a.assistant_message_id);
    expect((await epochOf(b.assistant_message_id)).started).toBe(false);
    expect((await epochOf(b.assistant_message_id)).id).toBe((await epochOf(a.assistant_message_id)).id);
  });

  it('start when a declared tool changes its description, and say why', async () => {
    h = await harness();
    h.tools.register(mcpTool('srv__echo', 'srv', () => undefined, 'Echo, version 1.'));
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    h.tools.register(mcpTool('srv__echo', 'srv', () => undefined, 'Echo, version 2.'));
    const b = await reply(t, 'two', a.assistant_message_id);
    expect(await epochOf(b.assistant_message_id)).toMatchObject({ reason: 'tools_changed', started: true });
    expect(lastOf(1).tools?.find((x) => x.name === 'srv__echo')?.description).toBe('Echo, version 2.');
  });

  it('start when the model family changes, and when thinking is toggled', async () => {
    h = await harness({
      models: [fakeModel('other', 'echo', 'other-family')],
      taskClasses: { 'chat.default': ['offline/test'] },
    });
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    const b = await reply(t, 'two', a.assistant_message_id, { model: 'fake/other' });
    expect(await epochOf(b.assistant_message_id)).toMatchObject({ reason: 'model_family', started: true });
    await h.call('PATCH', `/threads/${t}`, { thinking: true });
    const c = await reply(t, 'three', b.assistant_message_id, { model: 'fake/other' });
    expect(await epochOf(c.assistant_message_id)).toMatchObject({
      reason: 'thinking_toggled',
      started: true,
    });
    const d = await reply(t, 'four', c.assistant_message_id, { model: 'fake/other' });
    expect((await epochOf(d.assistant_message_id)).started).toBe(false);
  });

  it('refresh memory only at a cold point', async () => {
    h = await harness({ memory: true });
    const mem = h.memory as NonNullable<typeof h.memory>;
    const write = async (line: string) => {
      const f = await mem.file('USER.md');
      await mem.save('USER.md', {
        content: f.content.replace('## Preferences\n', `## Preferences\n${line}\n`),
        base_sha: f.version,
      });
    };
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    await write('- Prefers short answers.');
    // Warm: the cache is alive, so the snapshot stays and the news goes at the end.
    h.clock.now += 60_000;
    const b = await reply(t, 'two', a.assistant_message_id);
    expect((await epochOf(b.assistant_message_id)).started).toBe(false);
    expect(lastOf(1).system).not.toContain('short answers');
    // Cold: the cache would have expired anyway, so the snapshot is refreshed.
    h.clock.now += 10 * 60_000;
    const c = await reply(t, 'three', b.assistant_message_id);
    expect(await epochOf(c.assistant_message_id)).toMatchObject({ reason: 'memory_refresh', started: true });
    expect(lastOf(2).system).toContain('short answers');
    expect(lastOf(2).messages.at(-1)?.content).not.toContain('Memory update');
    expect((await answerIds(t)).length).toBe(3);
  });

  it('decide by the closed list (unit)', () => {
    const prev: EpochRecord = {
      id: 'epc_1',
      thread_id: 't',
      reason: 'new_thread',
      model_family: 'f',
      thinking: false,
      system_text: 's',
      tools_json: '[]',
      tools_hash: 'h',
      memory_commit: null,
      memory_text: '',
      instructions: '',
      display_name: '',
      compaction_id: null,
      track: newTrack({ tool_hashes: {} }),
      started_at: new Date(0).toISOString(),
      last_used_at: new Date(0).toISOString(),
    };
    const base = {
      prev,
      lane: 'f',
      thinking: false,
      specs: [],
      compactionId: null,
      now: 1_000,
      ttlMs: 300_000,
      frozenIsStale: true,
    };
    expect(epochReason({ ...base, prev: undefined })).toBe('new_thread');
    expect(epochReason(base)).toBeNull(); // stale, but warm
    expect(epochReason({ ...base, now: 301_000 })).toBe('memory_refresh');
    expect(epochReason({ ...base, now: 301_000, frozenIsStale: false })).toBeNull();
    expect(epochReason({ ...base, lane: 'g' })).toBe('model_family');
    expect(epochReason({ ...base, thinking: true })).toBe('thinking_toggled');
    expect(epochReason({ ...base, compactionId: 'sum_1' })).toBe('compaction');
    const tool = mcpTool('srv__a', 'srv');
    const withTool = { ...prev, track: newTrack({ tool_hashes: toolsBlock([tool]).hashes }) };
    expect(epochReason({ ...base, prev: withTool, specs: [tool] })).toBeNull();
    expect(epochReason({ ...base, prev: withTool, specs: [{ ...tool, description: 'changed' }] })).toBe(
      'tools_changed',
    );
    // A model without tools never sees the tools check.
    expect(
      epochReason({ ...base, prev: withTool, specs: [{ ...tool, description: 'changed' }] }, false),
    ).toBeNull();
    // The provider's shortest cache life sets the cold point.
    expect(cacheTtlMs('anthropic')).toBe(300_000);
  });
});

/* ---- the tools block ------------------------------------------------------------- */

describe('the tools block', () => {
  const tool = (name: string, schema: unknown, extra: Partial<ToolSpec> = {}): ToolSpec => ({
    ...mcpTool(name, 'srv'),
    inputSchema: schema,
    ...extra,
  });

  it('is sorted by name with schema keys in a fixed order, whatever the registration order', () => {
    const a = tool('b__two', {
      type: 'object',
      required: ['x'],
      properties: { y: { type: 'string' }, x: { type: 'number' } },
    });
    const b = tool('a__one', { properties: { z: {} }, type: 'object' });
    const one = toolsBlock([a, b]);
    const two = toolsBlock([
      b,
      tool('b__two', {
        properties: { x: { type: 'number' }, y: { type: 'string' } },
        required: ['x'],
        type: 'object',
      }),
    ]);
    expect(one.json).toBe(two.json);
    expect(one.hash).toBe(two.hash);
    expect(one.defs.map((d) => d.name)).toEqual(['a__one', 'b__two', MCP_BRIDGE_NAME]);
  });

  it("never offers a notebook another notebook's tools", () => {
    const mine = tool('ext__mine', {}, { notebookId: 'nbk_a' });
    const everyone = tool('srv__all', {});
    expect(toolsInScope([mine, everyone], 'nbk_a').map((t) => t.name)).toEqual(['ext__mine', 'srv__all']);
    expect(toolsInScope([mine, everyone], 'nbk_b').map((t) => t.name)).toEqual(['srv__all']);
    expect(toolsInScope([mine, everyone], null).map((t) => t.name)).toEqual(['srv__all']);
  });

  it('is empty for a model without tools', () => {
    expect(toolsBlock([tool('srv__a', {})], false).defs).toEqual([]);
  });

  it('puts a tool that appeared later behind the bridge, and keeps a removed one declared', () => {
    const epoch = {
      tools_json: '',
      track: newTrack({ tool_hashes: toolsBlock([tool('srv__a', {})]).hashes }),
    };
    const drift = toolDrift(epoch, [tool('late__b', {})]);
    expect(drift.bridged.map((t) => t.name)).toEqual(['late__b']);
    expect(drift.removed).toEqual(['srv__a']);
    expect(drift.changed).toEqual([]);
  });

  it('reads a bridge call, with the arguments as an object or as JSON text', () => {
    expect(bridgeTarget({ name: 'srv__a', arguments: { x: 1 } })).toEqual({ name: 'srv__a', args: { x: 1 } });
    expect(bridgeTarget({ name: 'srv__a', arguments: '{"x":2}' })).toEqual({
      name: 'srv__a',
      args: { x: 2 },
    });
    expect(bridgeTarget({ name: 'srv__a' })).toEqual({ name: 'srv__a', args: {} });
    expect(bridgeTarget({})).toHaveProperty('error');
    expect(bridgeTarget({ name: 'srv__a', arguments: '{nope' })).toHaveProperty('error');
  });

  it('is fixed in the request: the choice is auto and the tools are the epoch block', async () => {
    h = await harness();
    const t = await h.newThread();
    await reply(t, '/say one');
    expect(lastOf(0).toolChoice).toBe('auto');
    const names = (lastOf(0).tools ?? []).map((x) => x.name);
    expect(names).toEqual([...names].sort());
  });
});

/* ---- permissions still decide what runs ---------------------------------------------- */

describe('a declared tool is still checked when it runs', () => {
  it('refuses a call that is not allowed, with a reason, and never runs it', async () => {
    h = await harness();
    let ran = 0;
    const spec = h.tools.get('fs_read') as ToolSpec;
    h.tools.register({ ...spec, execute: async () => ++ran });
    const t = await h.newThread();
    const a = await reply(t, '/tool fs_read {"path":"/workspace/../etc/passwd"}');
    const m = (await h.repo.getMessage(a.assistant_message_id)) as Message;
    const res = m.parts.find((p) => p.type === 'tool_result') as Extract<Part, { type: 'tool_result' }>;
    expect(res.ok).toBe(false);
    expect(res.declined_reason).toBeTruthy();
    expect(ran).toBe(0);
    // The tool was in the list all along.
    expect(lastOf(0).tools?.map((x) => x.name)).toContain('fs_read');
  });

  it('asks about the tool a bridge call reaches, with its real arguments, before running it', async () => {
    let ran = 0;
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    h.tools.register({ ...mcpTool('late__write', 'late', () => ran++), tier: 'gated' });
    const sent = await h.send(t, `/tool ${MCP_BRIDGE_NAME} {"name":"late__write","arguments":{"x":3}}`, {
      parent_id: a.assistant_message_id,
    });
    const run = await h.settle(sent.run_id);
    expect(run.status).toBe('waiting_approval');
    expect(ran).toBe(0);
    const ask = (await h.eventsOf(sent.run_id)).find((e) => e.type === 'approval.required');
    expect(ask).toMatchObject({ tool: 'late__write', action: 'mcp.late.write' });
  });

  it('refuses the bridge for a tool that is not from an MCP server, or not there at all', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, `/tool ${MCP_BRIDGE_NAME} {"name":"fs_list","arguments":{"path":"/workspace"}}`);
    const res = ((await h.repo.getMessage(a.assistant_message_id)) as Message).parts.find(
      (p) => p.type === 'tool_result',
    ) as Extract<Part, { type: 'tool_result' }>;
    expect(res.ok).toBe(false);
    expect(String(res.result)).toContain('only reaches tools from connected MCP servers');
  });

  it('says why a declared tool that went away was not run, and does not start a new epoch', async () => {
    let ran = 0;
    h = await harness();
    h.tools.register(mcpTool('gone__tool', 'gone', () => ran++));
    const t = await h.newThread();
    const a = await reply(t, '/say one');
    h.tools.unregisterSource((s) => s.kind === 'mcp');
    const b = await reply(t, '/tool gone__tool {"x":1}', a.assistant_message_id);
    expect(lastOf(1).tools?.map((x) => x.name)).toContain('gone__tool');
    const res = ((await h.repo.getMessage(b.assistant_message_id)) as Message).parts.find(
      (p) => p.type === 'tool_result',
    ) as Extract<Part, { type: 'tool_result' }>;
    expect(res.ok).toBe(false);
    expect(String(res.result)).toContain('is not available now');
    expect(ran).toBe(0);
    expect((await epochOf(b.assistant_message_id)).started).toBe(false);
  });
});

/* ---- the end of the request ----------------------------------------------------------- */

describe('the context block', () => {
  it('holds the varying parts, in a fixed order, in front of the newest question', () => {
    const block = contextBlock({
      date: '2026-10-19',
      memoryUpdate: { text: 'Memory: x', commits: ['abc1234'] },
      memoryRanked: 'ranked',
      instructionsUpdate: '',
      note: 'Summary of the earlier part of this conversation: s',
      answerInstructions: 'Fuse the candidates.',
      bridged: [],
      sources: 'Sources:\n[1] p',
    });
    const at = (s: string) => block.indexOf(s);
    expect(block.startsWith("Today's date: 2026-10-19 (UTC).")).toBe(true);
    expect(at('Memory update (commit abc1234)')).toBeLessThan(at('Memory that may bear'));
    expect(at('Memory that may bear')).toBeLessThan(at('Summary of the earlier'));
    expect(at('Summary of the earlier')).toBeLessThan(at('Instructions for this answer only'));
    expect(at('Instructions for this answer only')).toBeLessThan(at('Sources:'));
  });

  it("puts this answer's instructions and the date at the end, not in the system prompt", async () => {
    h = await harness();
    const t = await h.newThread();
    await reply(t, '/say one', null, {});
    const sys = lastOf(0).system ?? '';
    expect(sys).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(lastOf(0).messages.at(-1)?.content).toContain("Today's date:");
  });

  it('keeps the old layout for a family whose switch is off', async () => {
    h = await harness({ endContext: () => false });
    const t = await h.newThread();
    await reply(t, '/say one');
    const req = lastOf(0);
    expect(req.system).toMatch(/It is \d{4}-\d{2}-\d{2} \(UTC\)/);
    expect(req.messages.at(-1)?.content).not.toContain("Today's date:");
    // The tools are still one canonical block.
    expect(req.toolChoice).toBe('auto');
  });
});

/* ---- stored as sent ---------------------------------------------------------------------- */

describe('messages are stored as they were sent', () => {
  it('keeps the question with its context, and the answer as the provider messages it became', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/tool fs_list {"path":"/workspace"}');
    const forms = await h.repo.sentForms([a.user_message_id, a.assistant_message_id]);
    const user = JSON.parse(forms.get(a.user_message_id)?.sent as string) as {
      role: string;
      content: string;
    }[];
    expect(user).toHaveLength(1);
    expect(user[0]?.content).toContain("Today's date:");
    expect(user[0]?.content.endsWith('/tool fs_list {"path":"/workspace"}')).toBe(true);
    const answer = JSON.parse(forms.get(a.assistant_message_id)?.sent as string) as { role: string }[];
    expect(answer.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(forms.get(a.assistant_message_id)?.epoch_id).toMatch(/^epc_/);
  });

  it('sends what was stored even if the stored parts read differently now', async () => {
    h = await harness();
    const t = await h.newThread();
    const a = await reply(t, '/say first');
    // The parts change (a caption, a tidy-up); the stored sent form does not.
    await h.repo.updateMessage(a.assistant_message_id, { parts: [{ type: 'text', text: 'REWRITTEN' }] });
    await reply(t, 'second', a.assistant_message_id);
    const sent = JSON.stringify(lastOf(-1).messages);
    expect(sent).toContain('"sent"');
    const blocks = anthropic(lastOf(-1)).blocks.join('\n');
    expect(blocks).toContain('first');
    expect(blocks).not.toContain('REWRITTEN');
  });

  it('still renders messages that have no stored sent form', async () => {
    h = await harness();
    const t = await h.newThread();
    const u = await h.repo.insertMessage({
      id: 'msg_01OLDUSER0000000000000000A',
      thread_id: t,
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'an old question' }],
      status: 'complete',
      trace_id: 'a'.repeat(32),
    });
    const o = await h.repo.insertMessage({
      id: 'msg_01OLDASST0000000000000000A',
      thread_id: t,
      parent_id: u.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'an old answer' }],
      status: 'complete',
      trace_id: 'a'.repeat(32),
    });
    expect((await h.repo.sentForms([u.id, o.id])).size).toBe(0);
    await reply(t, 'a new one', o.id);
    const text = anthropic(lastOf(0)).blocks.join('\n');
    expect(text).toContain('an old question');
    expect(text).toContain('an old answer');
    expect(lastOf(0).messages.at(-1)?.content).toContain('a new one');
    // The old message got an epoch to continue from, so the next turn starts warm.
    expect((await epochOf(((await h.repo.messages(t)).at(-1) as Message).id)).reason).toBe('new_thread');
  });
});
