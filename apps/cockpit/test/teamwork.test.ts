import type { FlowProvenance, RunEvent } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { summarise } from '../src/thread/Teamwork';
import {
  createDeltaBatcher,
  finishTeam,
  foldTeam,
  type TeamState,
  teamFromProvenance,
  useTeamwork,
} from '../src/thread/teamworkState';

type FlowEvent = Extract<RunEvent, { type: `flow.${string}` }>;

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 9, 0, s)).toISOString();
const ev = <T extends FlowEvent['type']>(
  type: T,
  body: Omit<Extract<FlowEvent, { type: T }>, 'type' | 'seq' | 'at' | 'message_id'>,
  s = 0,
): FlowEvent => ({ type, seq: ++seq, at: at(s), message_id: 'msg_1', ...body }) as unknown as FlowEvent;

function run(events: FlowEvent[]): TeamState | undefined {
  return events.reduce<TeamState | undefined>((t, e) => foldTeam(t, e), undefined);
}

const script: FlowEvent[] = [
  ev('flow.started', { flow_id: 'flw_1', name: 'Code team', version: 3 }),
  ev(
    'flow.node.started',
    { node_id: 'router', kind: 'router', label: 'Jev', model_id: 'openrouter/x', from: [] },
    1,
  ),
  ev(
    'flow.decision',
    { node_id: 'router', chose: ['code'], reason: 'It asks for a function.', confidence: 0.86 },
    2,
  ),
  ev(
    'flow.node.finished',
    { node_id: 'router', status: 'done', ms: 900, tokens_in: 120, tokens_out: 12, cost_usd: 0.0001 },
    2,
  ),
  ev(
    'flow.node.started',
    { node_id: 'c1', kind: 'model', label: 'Coder 1', model_id: 'node/qwen', from: ['router'] },
    3,
  ),
  ev(
    'flow.node.started',
    { node_id: 'c2', kind: 'model', label: 'Coder 2', model_id: 'node/qwen', from: ['router'] },
    3,
  ),
  ev('flow.node.delta', { node_id: 'c1', channel: 'reasoning', delta: 'Think. ' }, 4),
  ev('flow.node.delta', { node_id: 'c1', channel: 'text', delta: 'def f():' }, 4),
  ev('flow.node.delta', { node_id: 'c1', channel: 'text', delta: ' pass' }, 5),
  ev(
    'flow.node.finished',
    { node_id: 'c1', status: 'done', ms: 2000, tokens_in: 1, tokens_out: 2, cost_usd: 0.002 },
    6,
  ),
  ev(
    'flow.node.finished',
    { node_id: 'c2', status: 'cached', ms: 3, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    6,
  ),
  ev(
    'flow.node.started',
    { node_id: 'rev', kind: 'model', label: 'Reviewer', model_id: 'anthropic/x', from: ['c1', 'c2'] },
    7,
  ),
];

describe('teamwork from live events', () => {
  it('builds the steps, streams and decisions, and tracks what is running', () => {
    const t = run(script) as TeamState;
    expect(t.name).toBe('Code team');
    expect(t.steps.map((s) => s.nodeId)).toEqual(['router', 'c1', 'c2', 'rev']);
    const c1 = t.steps[1];
    expect(c1?.text).toBe('def f(): pass');
    expect(c1?.reasoning).toBe('Think. ');
    expect(t.steps[2]?.status).toBe('cached');
    expect(t.decisions.router?.chose).toEqual(['code']);
    expect(t.active).toEqual(['rev']);
    expect(t.cost).toBeCloseTo(0.0021, 6);
  });

  it('only replaces the step that changed, so the other rows keep their identity', () => {
    const before = run(script.slice(0, 7)) as TeamState;
    const after = foldTeam(
      before,
      ev('flow.node.delta', { node_id: 'c1', channel: 'text', delta: 'x' }),
    ) as TeamState;
    expect(after.steps[0]).toBe(before.steps[0]);
    expect(after.steps[2]).toBe(before.steps[2]);
    expect(after.steps[1]).not.toBe(before.steps[1]);
  });

  it('summarises parallel workers as one stage', () => {
    const t = run(script) as TeamState;
    expect(summarise(t.steps)).toBe('Jev → 2 coders → Reviewer');
  });
});

describe('teamwork from provenance (after a reload)', () => {
  const prov: FlowProvenance = {
    flow_id: 'flw_1',
    name: 'Code team',
    version: 3,
    scope: 'notebook',
    path: ['router', 'c1', 'rev'],
    decisions: [{ node_id: 'router', chose: ['code'], reason: 'It asks for a function.', confidence: 0.86 }],
    steps: [
      {
        node_id: 'rev',
        kind: 'model',
        label: 'Reviewer',
        model_id: 'anthropic/x',
        status: 'done',
        started_at: at(7),
        ms: 1500,
        tokens_in: 5,
        tokens_out: 5,
        cost_usd: 0.003,
        output: 'Looks right.',
      },
      {
        node_id: 'router',
        kind: 'router',
        label: 'Jev',
        model_id: 'openrouter/x',
        status: 'done',
        started_at: at(1),
        ms: 900,
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0.0001,
        output: '',
      },
      {
        node_id: 'c1',
        kind: 'model',
        label: 'Coder 1',
        model_id: 'node/qwen',
        status: 'done',
        started_at: at(3),
        ms: 2000,
        tokens_in: 1,
        tokens_out: 2,
        cost_usd: 0.002,
        output: 'def f(): pass',
        reasoning: 'Think.',
      },
    ],
    cost_usd: 0.0051,
  };

  it('orders steps by start, links each to the hop before it, and is done', () => {
    const t = teamFromProvenance(prov);
    expect(t.done).toBe(true);
    expect(t.steps.map((s) => s.nodeId)).toEqual(['router', 'c1', 'rev']);
    expect(t.steps[1]?.from).toEqual(['router']);
    expect(t.steps[1]?.reasoning).toBe('Think.');
    expect(t.decisions.router?.confidence).toBe(0.86);
    expect(t.ms).toBe(7_500);
    expect(summarise(t.steps)).toBe('Jev → Coder 1 → Reviewer');
  });
});

describe('delta batching', () => {
  it('merges deltas per node and channel into one apply per frame, and keeps order around other events', () => {
    const applied: FlowEvent[] = [];
    let frame: (() => void) | null = null;
    const b = createDeltaBatcher(
      (_m, e) => applied.push(e),
      (fn) => {
        frame = fn;
      },
    );
    b.push('m', ev('flow.node.delta', { node_id: 'a', channel: 'text', delta: 'he' }));
    b.push('m', ev('flow.node.delta', { node_id: 'a', channel: 'text', delta: 'llo' }));
    b.push('m', ev('flow.node.delta', { node_id: 'a', channel: 'reasoning', delta: 'hm' }));
    b.push('m', ev('flow.node.delta', { node_id: 'b', channel: 'text', delta: 'x' }));
    expect(applied).toHaveLength(0);
    (frame as unknown as () => void)();
    expect(applied).toHaveLength(3);
    const a = applied.find((e) => e.type === 'flow.node.delta' && e.node_id === 'a' && e.channel === 'text');
    expect(a && 'delta' in a ? a.delta : '').toBe('hello');

    // A finish flushes pending words first, so a node never ends before its last words.
    applied.length = 0;
    b.push('m', ev('flow.node.delta', { node_id: 'a', channel: 'text', delta: '!' }));
    b.push(
      'm',
      ev('flow.node.finished', {
        node_id: 'a',
        status: 'done',
        ms: 1,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      }),
    );
    expect(applied.map((e) => e.type)).toEqual(['flow.node.delta', 'flow.node.finished']);
  });
});

describe('the end of a run', () => {
  it('settles the live teamwork at once: done, nothing active, total time', () => {
    useTeamwork.setState({ teams: {} });
    const apply = useTeamwork.getState().apply;
    apply('msg_9', ev('flow.started', { flow_id: 'flw_1', name: 'Coding', version: 2 }, 0));
    apply(
      'msg_9',
      ev(
        'flow.node.started',
        { node_id: 'coder', kind: 'model', label: 'Coder', model_id: 'm', from: [] },
        1,
      ),
    );
    finishTeam('msg_9', at(5));
    const t = useTeamwork.getState().teams.msg_9 as TeamState;
    expect(t.done).toBe(true);
    expect(t.active).toEqual([]);
    expect(t.ms).toBe(5_000);
  });
});
