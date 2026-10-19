/**
 * ------------------------------------------------------------------
 *  Title    |  Every flow node kind, run on its own
 *  Ref      |  ROADMAP FW1, DESIGN.md §16
 *  ID       |  core/test/flows
 * ------------------------------------------------------------------
 *  Purpose  |  Rule, parallel, context, tool, template, human, join,
 *           |  retrieve, fact-check, loop and subflow each run through
 *           |  the real executor, and each piece that used to return
 *           |  nothing when it was not wired now says what is missing.
 *  How      |  A fake runtime lends the pieces; nothing is mocked in
 *           |  the executor itself.
 * ------------------------------------------------------------------
 */

import {
  ContextPolicy,
  type Flow,
  type FlowEdge,
  type FlowNode,
  FlowSettings,
  ModelParams,
} from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { executeFlow, type FlowRuntime, initialFlowState } from '../../src/flows/execute';

const settings = FlowSettings.parse({});
const pos = { x: 0, y: 0 };
const io: FlowNode[] = [
  { id: 'input', kind: 'input', position: pos, params: {} },
  { id: 'output', kind: 'output', position: pos, params: { template: '' } },
];
const model = (id: string): FlowNode => ({
  id,
  kind: 'model',
  position: pos,
  params: ModelParams.parse({ model: 'offline/test', role: `Node:${id}` }),
});
const edge = (from: string, to: string, label?: string): FlowEdge => ({
  id: `${from}-${to}${label ? `-${label}` : ''}`,
  from,
  to,
  ...(label && { label }),
});
const flow = (nodes: FlowNode[], edges: FlowEdge[], id = 'f'): Flow =>
  ({ id, name: id, version: 1, scope: 'workspace', nodes, edges, settings }) as never;

const reply = (text: string) => ({
  text,
  reasoning: '',
  modelId: 'm',
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
});

function runtime(over: Partial<FlowRuntime> & { text?: string } = {}): FlowRuntime {
  const { text, ...rest } = over;
  return {
    signal: new AbortController().signal,
    input: {
      text: text ?? 'Please summarise the pump report',
      threadId: null,
      notebookId: 'nbk',
      notebookTitle: null,
      workspaceId: 'w',
      messageId: 'm',
      hasAttachment: false,
      branchDepth: 1,
    },
    model: (id) =>
      ({
        id,
        display_name: id,
        context_window: 32_000,
        price: { input_per_mtok: 0, output_per_mtok: 0 },
      }) as never,
    contextFor: () => ({ conversation: async () => [], sources: async () => '', memory: async () => '' }),
    call: async (_c, req) => reply(`out:${/Node:(\w+)/.exec(req.system ?? '')?.[1] ?? '?'}`),
    loadFlow: async () => undefined,
    emit: async () => undefined,
    speak: () => undefined,
    setAnswer: async () => undefined,
    save: async () => undefined,
    ...rest,
  };
}

async function run(f: Flow, rt: FlowRuntime) {
  const state = initialFlowState(f);
  const out = await executeFlow(state, rt);
  return { out, state };
}
const answerOf = (o: Awaited<ReturnType<typeof run>>['out']) => (o.kind === 'done' ? o.answer : '(waiting)');

describe('rule', () => {
  const rule = (default_route?: string): FlowNode => ({
    id: 'r',
    kind: 'rule',
    position: pos,
    params: {
      rules: [
        { label: 'long', all: [{ field: 'length', op: 'gt', value: 30 }] },
        { label: 'code', all: [{ field: 'text', op: 'contains', value: 'bug' }] },
      ],
      ...(default_route && { default_route }),
    },
  });
  const graph = (d?: string) =>
    flow(
      [...io, rule(d), model('long'), model('code'), model('plain')],
      [
        edge('input', 'r'),
        edge('r', 'long', 'long'),
        edge('r', 'code', 'code'),
        edge('r', 'plain', 'plain'),
        edge('long', 'output'),
        edge('code', 'output'),
        edge('plain', 'output'),
      ],
    );

  it('takes the first rule that matches, and only that route runs', async () => {
    expect(answerOf((await run(graph(), runtime())).out)).toBe('out:long');
    expect(answerOf((await run(graph(), runtime({ text: 'a bug' }))).out)).toBe('out:code');
  });

  it('falls to the default route when nothing matches', async () => {
    expect(answerOf((await run(graph('plain'), runtime({ text: 'hi' }))).out)).toBe('out:plain');
  });
});

describe('parallel, context and template', () => {
  it('passes the message through a parallel and a context node to every branch', async () => {
    const f = flow(
      [
        ...io,
        { id: 'p', kind: 'parallel', position: pos, params: {} },
        { id: 'c', kind: 'context', position: pos, params: ContextPolicy.parse({}) },
        model('a'),
        model('b'),
        { id: 'j', kind: 'join', position: pos, params: { mode: 'all', judge_instructions: '' } },
      ],
      [
        edge('input', 'p'),
        edge('p', 'c'),
        edge('c', 'a'),
        edge('c', 'b'),
        edge('a', 'j'),
        edge('b', 'j'),
        edge('j', 'output'),
      ],
    );
    const { out } = await run(f, runtime());
    expect(answerOf(out)).toContain('out:a');
    expect(answerOf(out)).toContain('out:b');
  });

  it('fills a template from the message and an earlier step', async () => {
    const f = flow(
      [
        ...io,
        model('a'),
        { id: 't', kind: 'template', position: pos, params: { template: 'Q: {{input}} / A: {{a}}' } },
      ],
      [edge('input', 'a'), edge('a', 't'), edge('t', 'output')],
    );
    expect(answerOf((await run(f, runtime({ text: 'why?' }))).out)).toBe('Q: why? / A: out:a');
  });
});

describe('join', () => {
  const joined = (mode: 'first' | 'vote') =>
    flow(
      [
        ...io,
        model('a'),
        model('b'),
        model('c'),
        { id: 'j', kind: 'join', position: pos, params: { mode, judge_instructions: '' } },
      ],
      [
        edge('input', 'a'),
        edge('input', 'b'),
        edge('input', 'c'),
        edge('a', 'j'),
        edge('b', 'j'),
        edge('c', 'j'),
        edge('j', 'output'),
      ],
    );
  it('keeps the first answer, or the one most branches gave', async () => {
    expect(answerOf((await run(joined('first'), runtime())).out)).toBe('out:a');
    const rt = runtime({
      call: async (_c, req) => reply(/Node:c/.test(req.system ?? '') ? 'odd' : 'same'),
    });
    expect(answerOf((await run(joined('vote'), rt)).out)).toBe('same');
  });
});

describe('tool', () => {
  const toolFlow = (args = '{"q":"{{input}}"}') =>
    flow(
      [...io, { id: 't', kind: 'tool', position: pos, params: { tool: 'web.search', args } }],
      [edge('input', 't'), edge('t', 'output')],
    );
  it('runs the tool on the filled-in arguments and passes its output on', async () => {
    const seen: unknown[] = [];
    const rt = runtime({
      text: 'pumps',
      tool: async (_k, tool, args) => {
        seen.push([tool, args]);
        return { status: 'done', value: { ok: true, output: 'three results' } };
      },
    });
    expect(answerOf((await run(toolFlow(), rt)).out)).toBe('three results');
    expect(seen).toEqual([['web.search', { q: 'pumps' }]]);
  });

  it('says a tool failed instead of passing on an empty string', async () => {
    const rt = runtime({ tool: async () => ({ status: 'done', value: { ok: false, output: 'offline' } }) });
    expect(answerOf((await run(toolFlow(), rt)).out)).toBe('The tool failed: offline');
  });

  it('refuses arguments that are not JSON once filled in, and waits for an approval', async () => {
    const rt = runtime({ tool: async () => ({ status: 'done', value: { ok: true, output: '' } }) });
    await expect(run(toolFlow('not json'), rt)).rejects.toMatchObject({ code: 'flow.invalid' });
    const waiting = runtime({ tool: async () => ({ status: 'waiting' }) });
    expect((await run(toolFlow(), waiting)).out).toEqual({ kind: 'waiting' });
  });
});

describe('human', () => {
  const ask = flow(
    [...io, { id: 'h', kind: 'human', position: pos, params: { question: 'Send it?', show_upstream: true } }],
    [edge('input', 'h'), edge('h', 'output')],
  );
  it('passes your answer on, waits while it is open, and fails loudly when it times out', async () => {
    const done = runtime({ ask: async () => ({ status: 'done', value: 'Yes, go ahead.' }) });
    expect(answerOf((await run(ask, done)).out)).toBe('Yes, go ahead.');
    expect((await run(ask, runtime({ ask: async () => ({ status: 'waiting' }) }))).out).toEqual({
      kind: 'waiting',
    });
    const late = runtime({ ask: async () => ({ status: 'expired' }) });
    await expect(run(ask, late)).rejects.toMatchObject({ code: 'flow.human_timeout' });
  });
});

describe('retrieve', () => {
  const find = flow(
    [
      ...io,
      { id: 'f', kind: 'retrieve', position: pos, params: { query: '{{input}}', k: 4, rerank: false } },
    ],
    [edge('input', 'f'), edge('f', 'output')],
  );
  it('passes the passages on, and an unwired search is an error, not an empty answer', async () => {
    const seen: unknown[] = [];
    const rt = runtime({
      text: 'pump speed',
      retrieve: async (q) => {
        seen.push(q);
        return 'Passage 1';
      },
    });
    expect(answerOf((await run(find, rt)).out)).toBe('Passage 1');
    expect(seen).toEqual([{ query: 'pump speed', k: 4, rerank: false }]);
    await expect(run(find, runtime())).rejects.toMatchObject({ code: 'flow.retrieve_unavailable' });
  });
});

describe('factcheck', () => {
  const checked = flow(
    [
      ...io,
      model('a'),
      model('fix'),
      { id: 'fc', kind: 'factcheck', position: pos, params: { min_confidence: 0.7, caveat: true } },
    ],
    [
      edge('input', 'a'),
      edge('a', 'fc'),
      edge('fc', 'output', 'ok'),
      edge('fc', 'fix', 'unsure'),
      edge('fix', 'output'),
    ],
  );
  const verdict = (confidence: number | null) =>
    runtime({ factcheck: async () => ({ confidence, summary: 'Two of three claims.' }) });

  it('keeps a supported answer, and sends an unsupported one down the unsure route', async () => {
    expect(answerOf((await run(checked, verdict(0.9))).out)).toBe('out:a');
    expect(answerOf((await run(checked, verdict(0.2))).out)).toBe('out:fix');
  });

  it('treats a check that could not run as unsure, not as a pass', async () => {
    expect(answerOf((await run(checked, verdict(null))).out)).toBe('out:fix');
  });

  it('is an error when fact-checking is not wired', async () => {
    await expect(run(checked, runtime())).rejects.toMatchObject({ code: 'flow.factcheck_unavailable' });
  });
});

describe('loop', () => {
  it('stops at its limit and returns the last version', async () => {
    let n = 0;
    const f = flow(
      [
        ...io,
        { id: 'l', kind: 'loop', position: pos, params: { max_iterations: 2, until: 'done' } },
        model('body'),
      ],
      [edge('input', 'l'), edge('l', 'body', 'body'), edge('l', 'output')],
    );
    const { out } = await run(f, runtime({ call: async () => reply(`draft ${++n}`) }));
    expect(n).toBe(2);
    expect(answerOf(out)).toBe('draft 2');
  });
});

describe('subflow', () => {
  const sub = (id: string, next: string | null): Flow =>
    next
      ? flow(
          [...io, { id: 's', kind: 'subflow', position: pos, params: { flow_id: next } }],
          [edge('input', 's'), edge('s', 'output')],
          id,
        )
      : flow([...io, model('leaf')], [edge('input', 'leaf'), edge('leaf', 'output')], id);
  const flows = (links: Record<string, string | null>) => async (id: string) =>
    id in links ? sub(id, links[id] as string | null) : undefined;

  it('runs three levels of nesting', async () => {
    const rt = runtime({ loadFlow: flows({ a: 'b', b: 'c', c: null }) });
    expect(answerOf((await run(sub('top', 'a'), rt)).out)).toBe('out:leaf');
  });

  it('refuses a fourth level and a flow that was deleted, in words', async () => {
    const deep = runtime({ loadFlow: flows({ a: 'b', b: 'c', c: 'd', d: null }) });
    await expect(run(sub('top', 'a'), deep)).rejects.toMatchObject({ code: 'flow.invalid' });
    await expect(run(sub('top', 'gone'), runtime())).rejects.toMatchObject({ code: 'flow.invalid' });
  });
});
