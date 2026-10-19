/**
 * The mapping and what it does not know: entries of a kind a newer Claude
 * Code writes and content blocks it has no part for are never dropped
 * silently, whichever way they arrive (the transcript reader or the SDK).
 */
import type { Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import type { CcSessionMessage } from '../../src/claudecode/bridge-protocol';
import {
  applyToMirror,
  classify,
  LOOSE_UUID_PREFIX,
  type MirrorState,
  placeOf,
  planRepair,
  planSync,
  provenanceOf,
  type StoredMessage,
  stepMs,
  unknownText,
  usageOf,
} from '../../src/claudecode/map';

const S = 'sess-map-0001';
const empty = (): MirrorState => ({ byUuid: new Map(), messages: new Map() });
let n = 0;
const ids = () => `m${n++}`;

const entry = (uuid: string, type: string, message: unknown, extra: Partial<CcSessionMessage> = {}) =>
  ({ type, uuid, session_id: S, message, parent_tool_use_id: null, ...extra }) as CcSessionMessage;

describe('what the mapping does not know', () => {
  it('reads an SDK entry of a new kind as unknown, not as your prompt', () => {
    expect(classify(entry('x', 'progress', { content: 'tick' }))).toEqual({
      kind: 'unknown',
      type: 'progress',
    });
    expect(classify(entry('y', 'user', { role: 'user', content: 42 }))).toEqual({
      kind: 'unknown',
      type: 'user_content',
    });
    // A user entry with no message at all is still nothing to show.
    expect(classify(entry('z', 'user', undefined))).toEqual({ kind: 'skip' });
  });

  it('counts unknown blocks on the message that holds them, with the entry kept raw', () => {
    n = 0;
    const answer = entry('a1', 'assistant', {
      id: 'api1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here.' },
        { type: 'hologram', frames: 2 },
      ],
    });
    const plan = planSync([entry('u1', 'user', { role: 'user', content: 'Go' }), answer], empty(), ids, null);
    const a = plan.planned.find((p) => p.role === 'assistant');
    expect(a?.parts).toEqual([{ type: 'text', text: 'Here.' }]);
    expect(a?.unknown).toEqual({ count: 1, types: ['hologram'] });
    expect(a?.raws?.[0]).toMatchObject({ uuid: 'a1', type: 'hologram' });
    expect(JSON.parse(a?.raws?.[0]?.raw ?? '{}')).toMatchObject({ uuid: 'a1' });
    expect(provenanceOf(S, a as NonNullable<typeof a>).unknown).toEqual({ count: 1, types: ['hologram'] });
  });

  it('gives a run of unknown entries between turns one marker, and a later sync adds nothing', () => {
    n = 0;
    const chain = [
      entry('u1', 'user', { role: 'user', content: 'Go' }),
      entry('k1', 'unknown', undefined, { unknown: { type: 'ledger', raw: '{"type":"ledger"}' } }),
      entry('k2', 'heartbeat', { beat: 1 }),
      entry('a1', 'assistant', { id: 'api1', role: 'assistant', content: [{ type: 'text', text: 'Ok' }] }),
    ];
    const plan = planSync(chain, empty(), ids, null);
    const marker = plan.planned.filter((p) => p.kind === 'unknown');
    expect(marker).toHaveLength(1);
    expect(marker[0]).toMatchObject({
      role: 'system',
      uuids: ['k1', 'k2'],
      unknown: { count: 2, types: ['ledger', 'heartbeat'] },
      parts: [{ type: 'text', text: unknownText(2) }],
    });
    expect(marker[0]?.raws?.map((r) => r.raw)[0]).toBe('{"type":"ledger"}');
    // The answer hangs off the marker, so the conversation reads in order.
    expect(plan.planned.find((p) => p.role === 'assistant')?.parent_id).toBe(marker[0]?.id);
    expect(unknownText(1)).toBe("1 entry this version of NVX Ancile can't show yet");
  });

  it('never starts a branch for an entry an older version skipped, and never goes on from a line with no uuid', () => {
    n = 0;
    const u1 = entry('u1', 'user', { role: 'user', content: 'Go' });
    const a1 = entry('a1', 'assistant', {
      id: 'api1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Ok' }],
    });
    const u2 = entry('u2', 'user', { role: 'user', content: 'More' });
    const first = planSync([u1, a1, u2], empty(), ids, null);
    const mirror = empty();
    applyToMirror(mirror, first);
    // A later read finds an entry between a1 and u2 that was skipped before, and a loose line after u2.
    const old = entry('k1', 'tool-progress', { x: 1 });
    const loose = entry(`${LOOSE_UUID_PREFIX}abc`, 'unknown', undefined, {
      unknown: { type: 'not_json', raw: 'oops' },
    });
    const again = planSync([u1, a1, old, u2, loose], mirror, ids, null);
    expect(again.planned.every((p) => p.extends)).toBe(true);
    const onAnswer = again.planned.find((p) => p.id === mirror.byUuid.get('a1'));
    expect(onAnswer).toMatchObject({ uuids: ['k1'], parts: [], unknown: { count: 1 } });
    const onPrompt = again.planned.find((p) => p.id === mirror.byUuid.get('u2'));
    expect(onPrompt).toMatchObject({ uuids: [loose.uuid], unknown: { count: 1, types: ['not_json'] } });
    // The prompt's place in the session is still its own entry.
    expect(placeOf([u2.uuid, loose.uuid])).toBe('u2');
    expect(again.head).toBe(mirror.byUuid.get('u2'));
  });
});

/* ---- results with their calls (mapper version 4) ---------------------------------------- */

const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const say = (uuid: string, s: number, api: string, content: unknown[], usage?: Record<string, number>) =>
  entry(
    uuid,
    'assistant',
    { id: api, role: 'assistant', model: 'claude-opus-5-5', content, ...(usage && { usage }) },
    {
      timestamp: at(s),
    },
  );
const use = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: `run ${id}` } });
const res = (uuid: string, s: number, id: string, extra: unknown[] = []) =>
  entry(
    uuid,
    'user',
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `out ${id}` }, ...extra] },
    { timestamp: at(s) },
  );
const ask = (uuid: string, s: number, text: string) =>
  entry(uuid, 'user', { role: 'user', content: text }, { timestamp: at(s) });
const TASK =
  '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Build finished</summary>\n</task-notification>';
const notice = (uuid: string, s: number) =>
  entry(
    uuid,
    'user',
    { role: 'user', content: TASK },
    { timestamp: at(s), origin: { kind: 'task-notification' } },
  );
const STOP = '[Request interrupted by user for tool use]';
const stoppedRes = (uuid: string, s: number, id: string) => res(uuid, s, id, [{ type: 'text', text: STOP }]);

const kinds = (planned: { role: string; kind: string | null; parts: { type: string }[] }[]) =>
  planned.map((p) => `${p.role}${p.kind ? `:${p.kind}` : ''}[${p.parts.map((x) => x.type).join(',')}]`);
/** Plan a chain in syncs: each step plans the chain so far against what the earlier steps wrote. */
function inSyncs(chain: CcSessionMessage[], cuts: number[]) {
  const mirror = empty();
  const plans = [];
  for (const cut of [...cuts, chain.length]) {
    const plan = planSync(chain.slice(0, cut), mirror, ids, null);
    applyToMirror(mirror, plan);
    plans.push(plan);
  }
  return { mirror, plans };
}

describe('a tool result joins the answer holding its call', () => {
  it('when a notification came between them: no answer of nothing but results, and what follows hangs where it did', () => {
    n = 0;
    const chain = [
      ask('u1', 0, 'Build it'),
      say('a1', 1, 'm1', [use('c1')]),
      notice('n1', 3),
      res('r1', 4, 'c1'),
      say('a2', 5, 'm2', [{ type: 'text', text: 'Built.' }]),
    ];
    const { planned, head } = planSync(chain, empty(), ids, null);
    expect(kinds(planned)).toEqual([
      'user[text]',
      'assistant[tool_call,tool_result]',
      'system:notification[text]',
      'assistant[text]',
    ]);
    const [u, a, note, a2] = planned;
    // The step took from the call's entry to the result's: 3 seconds.
    expect(a?.parts[1]).toMatchObject({ type: 'tool_result', call_id: 'c1', duration_ms: 3000 });
    expect(a?.parent_id).toBe(u?.id);
    expect(note?.parent_id).toBe(a?.id);
    // The result's entry keeps its place in the conversation: after the notification.
    expect(note?.uuids).toEqual(['n1', 'r1']);
    expect(provenanceOf(S, note as NonNullable<typeof note>).uuid).toBe('r1');
    expect(a2?.parent_id).toBe(note?.id);
    expect(head).toBe(a2?.id);
  });

  it('parallel calls: every result joins, and a response spread over two messages is counted once', () => {
    n = 0;
    const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 };
    const chain = [
      ask('u1', 0, 'Go'),
      say('a1', 1, 'm1', [use('c1')], u),
      notice('n1', 2),
      res('r1', 3, 'c1'),
      // More of the same API response, after the notification.
      say('a1b', 4, 'm1', [use('c2')], u),
      res('r2', 6, 'c2'),
      say('a3', 7, 'm2', [{ type: 'text', text: 'Both done.' }], { input_tokens: 3, output_tokens: 7 }),
    ];
    const { planned } = planSync(chain, empty(), ids, null);
    expect(kinds(planned)).toEqual([
      'user[text]',
      'assistant[tool_call,tool_result]',
      'system:notification[text]',
      'assistant[tool_call,tool_result,text]',
    ]);
    // m1 once (on the first message), m2 once.
    expect(planned[1]?.usage).toEqual({
      input_tokens: 110, // 10 fresh + 100 read from the cache: every prompt token
      output_tokens: 5,
      cached_tokens: 100,
      cache_write_tokens: 0,
      cache_reported: true,
      cost_usd: 0,
    });
    expect(planned[3]?.usage).toEqual({
      input_tokens: 3,
      output_tokens: 7,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_reported: true,
      cost_usd: 0,
    });
  });

  it('when a command came between them: its output still folds into the command', () => {
    n = 0;
    const chain = [
      ask('u1', 0, 'Go'),
      say('a1', 1, 'm1', [use('c1')]),
      ask(
        'c1x',
        2,
        '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>',
      ),
      res('r1', 3, 'c1'),
      ask('o1', 4, '<local-command-stdout>Set model to opus</local-command-stdout>'),
    ];
    const { planned } = planSync(chain, empty(), ids, null);
    expect(kinds(planned)).toEqual(['user[text]', 'assistant[tool_call,tool_result]', 'user:command[text]']);
    expect(planned[2]?.command?.output).toBe('Set model to opus');
    expect(planned[2]?.uuids).toEqual(['c1x', 'r1', 'o1']);
  });

  it('parallel calls stopped together: both results join, under one "Stopped by you"', () => {
    n = 0;
    const chain = [
      ask('u1', 0, 'Go'),
      say('a1', 1, 'm1', [use('c1')]),
      say('a1b', 1, 'm1', [use('c2')]),
      stoppedRes('r1', 2, 'c1'),
      stoppedRes('r2', 2, 'c2'),
    ];
    const one = planSync(chain, empty(), ids, null);
    expect(kinds(one.planned)).toEqual([
      'user[text]',
      'assistant[tool_call,tool_call,tool_result,tool_result]',
      'system:interrupted[text]',
    ]);
    expect(one.planned[2]?.uuids).toEqual(['r1+', 'r2', 'r2+']);
    // The same across a sync between the two results.
    n = 0;
    const { mirror, plans } = inSyncs(chain, [4]);
    expect(plans[1]?.planned.every((p) => p.extends)).toBe(true);
    const answer = plans[1]?.planned.find((p) => p.id === mirror.byUuid.get('a1'));
    expect(answer?.parts).toMatchObject([{ type: 'tool_result', call_id: 'c2' }]);
    expect(mirror.byUuid.get('r2+')).toBe(mirror.byUuid.get('r1+'));
    expect(planSync(chain, mirror, ids, null).planned).toEqual([]);
  });

  it('when a sync came between a call, a notification and the result: the same thread as one sync', () => {
    const chain = [
      ask('u1', 0, 'Build it'),
      say('a1', 1, 'm1', [use('c1')]),
      notice('n1', 3),
      res('r1', 4, 'c1'),
      say('a2', 5, 'm2', [{ type: 'text', text: 'Built.' }]),
      ask('u2', 6, 'Thanks'),
    ];
    n = 0;
    const { mirror, plans } = inSyncs(chain, [3, 4]);
    // Sync 2: the result joins the answer (an extension) and its entry goes on the notification.
    const answerId = mirror.byUuid.get('a1') as string;
    const noteId = mirror.byUuid.get('n1') as string;
    expect(plans[1]?.planned.map((p) => [p.id, p.extends, p.uuids, p.parts.map((x) => x.type)])).toEqual([
      [answerId, true, [], ['tool_result']],
      [noteId, true, ['r1'], []],
    ]);
    expect(plans[1]?.planned[0]?.parts[0]).toMatchObject({ duration_ms: 3000 });
    // Sync 3: the next answer hangs off the notification, then the prompt.
    const next = plans[2]?.planned.find((p) => p.role === 'assistant' && !p.extends);
    expect(next?.parent_id).toBe(noteId);
    expect(plans[2]?.planned.find((p) => p.role === 'user')?.parent_id).toBe(next?.id);
    // Nothing more to add.
    expect(planSync(chain, mirror, ids, null).planned).toEqual([]);
  });

  it('an entry it cannot show after the last sync stays in the answer that was going on (no marker of its own)', () => {
    const chain = [
      ask('u1', 0, 'Go'),
      say('a1', 1, 'm1', [use('c1')]),
      entry('k1', 'tool-progress', { x: 1 }, { timestamp: at(2) }),
      res('r1', 3, 'c1'),
      say('a2', 4, 'm2', [{ type: 'text', text: 'Done' }]),
    ];
    n = 0;
    const { mirror, plans } = inSyncs(chain, [2]);
    const answerId = mirror.byUuid.get('a1');
    expect(plans[1]?.planned).toHaveLength(1);
    expect(plans[1]?.planned[0]).toMatchObject({
      id: answerId,
      extends: true,
      uuids: ['k1', 'r1', 'a2'],
      unknown: { count: 1, types: ['tool-progress'] },
    });
    expect(plans[1]?.planned[0]?.parts.map((p) => p.type)).toEqual(['tool_result', 'text']);
    // One sync of the whole chain makes the same answer.
    n = 0;
    const one = planSync(chain, empty(), ids, null);
    expect(kinds(one.planned)).toEqual(['user[text]', 'assistant[tool_call,tool_result,text]']);
  });

  it('a duration only when both times are there, never negative, and not for a result in the same entry', () => {
    n = 0;
    const noTime = { ...res('r2', 0, 'c2') };
    delete noTime.timestamp;
    const chain = [
      ask('u1', 0, 'Go'),
      say('a1', 5, 'm1', [use('c1'), use('c2')]),
      // Written with an earlier time than its call (a clock moved): 0, not negative.
      res('r1', 4, 'c1'),
      noTime,
      say('a2', 6, 'm2', [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      ]),
    ];
    const { planned } = planSync(chain, empty(), ids, null);
    const results = planned[1]?.parts.filter((p) => p.type === 'tool_result');
    expect(results?.map((p) => (p.type === 'tool_result' ? [p.call_id, p.duration_ms] : null))).toEqual([
      ['c1', 0],
      ['c2', undefined],
      ['s1', undefined],
    ]);
    expect(stepMs(at(0), at(1.5))).toBe(1500);
    expect(stepMs(at(0), 'not a time')).toBeUndefined();
    expect(stepMs(undefined, at(1))).toBeUndefined();
  });

  it('a result whose call is nowhere on the chain stays where it was written', () => {
    n = 0;
    const { planned } = planSync([ask('u1', 0, 'Go'), res('r1', 1, 'gone')], empty(), ids, null);
    expect(kinds(planned)).toEqual(['user[text]', 'assistant[tool_result]']);
    expect(planned[1]?.parts[0]).not.toHaveProperty('duration_ms');
  });
});

/* ---- repairing what an older mapping wrote ---------------------------------------------- */

const stored = (
  id: string,
  role: string,
  parent: string | null,
  parts: Part[],
  cc: Record<string, unknown> | null,
  extra: Partial<StoredMessage> = {},
): StoredMessage => ({
  id,
  parent_id: parent,
  role,
  parts,
  usage: null,
  status: 'complete',
  provenance: cc ? { claude_code: { session_id: S, ...cc } } : {},
  ...extra,
});
const callPart = (id: string): Part => ({
  type: 'tool_call',
  call_id: id,
  tool: 'Bash',
  args: { command: `run ${id}` },
});
const resultPart = (id: string): Part => ({
  type: 'tool_result',
  call_id: id,
  ok: true,
  result: `out ${id}`,
});

describe('repairing a thread an older mapping wrote', () => {
  const chain = [
    ask('u1', 0, 'Build it'),
    say('a1', 1, 'm1', [use('c1')]),
    notice('n1', 3),
    res('r1', 4, 'c1'),
    ask('u2', 9, 'Thanks'),
  ];
  // What version 3 made of it: the result in an answer of its own after the notification.
  const v3 = () => [
    stored('U1', 'user', null, [{ type: 'text', text: 'Build it' }], { uuid: 'u1', uuids: ['u1'] }),
    stored('A1', 'assistant', 'U1', [callPart('c1')], { uuid: 'a1', uuids: ['a1'], last_api_id: 'm1' }),
    stored('N1', 'system', 'A1', [{ type: 'text', text: 'Build finished' }], {
      uuid: 'n1',
      uuids: ['n1'],
      kind: 'notification',
    }),
    stored('S1', 'assistant', 'N1', [resultPart('c1')], { uuid: 'r1', uuids: ['r1'] }),
    stored('U2', 'user', 'S1', [{ type: 'text', text: 'Thanks' }], { uuid: 'u2', uuids: ['u2'] }),
  ];

  it('moves the result to its call with its duration; the answer it leaves stays as an empty link', () => {
    const plan = planRepair(S, v3(), [chain]);
    expect(plan.counts).toEqual({ timed: 1, moved: 1, recounted: 0 });
    const byId = new Map(plan.updates.map((u) => [u.id, u]));
    expect([...byId.keys()].sort()).toEqual(['A1', 'S1']);
    expect(byId.get('A1')?.parts).toEqual([callPart('c1'), { ...resultPart('c1'), duration_ms: 3000 }]);
    // The host's provenance is untouched.
    expect(byId.get('A1')?.claude_code).toBeUndefined();
    expect(byId.get('S1')).toMatchObject({
      parts: [{ type: 'text', text: '' }],
      // It keeps its entries and its place: nothing that points at it, or hangs off it, moves.
      claude_code: { session_id: S, uuid: 'r1', uuids: ['r1'], results_moved_to: 'A1' },
    });
  });

  it('is done once: repairing the repaired thread changes nothing', () => {
    const msgs = v3();
    for (const u of planRepair(S, msgs, [chain]).updates) {
      const m = msgs.find((x) => x.id === u.id) as StoredMessage;
      if (u.parts) m.parts = u.parts;
      if (u.claude_code) m.provenance = { ...m.provenance, claude_code: u.claude_code };
    }
    expect(planRepair(S, msgs, [chain]).updates).toEqual([]);
    // A repair cut short (the result already moved, the stray not yet emptied) does not add it twice.
    const half = v3();
    (half[1] as StoredMessage).parts = [callPart('c1'), resultPart('c1')];
    const again = planRepair(S, half, [chain]);
    expect(
      again.updates.find((u) => u.id === 'A1')?.parts?.filter((p) => p.type === 'tool_result'),
    ).toHaveLength(1);
    expect(again.updates.find((u) => u.id === 'S1')?.parts).toEqual([{ type: 'text', text: '' }]);
  });

  it('keeps what else the answer holds, and a live turn its citations, cost and setup', () => {
    const msgs = v3();
    const live = {
      uuid: 'a1',
      uuids: ['a1'],
      live: true,
      setup: { lean: true },
      cost_estimate: { usd: 0.12, note: 'estimate' },
    };
    msgs[1] = stored(
      'A1',
      'assistant',
      'U1',
      [
        { type: 'text', text: 'Checking [1].' },
        {
          type: 'citation_ref',
          marker: 1,
          chunk_id: 'k',
          source_id: 'src',
          char_start: 0,
          char_end: 4,
          quote: 'Spec',
        },
        callPart('c1'),
      ],
      live,
      { usage: { input_tokens: 1, output_tokens: 2, cached_tokens: 0, cost_usd: 0.12 } },
    );
    msgs[3] = stored('S1', 'assistant', 'N1', [resultPart('c1'), { type: 'text', text: 'Built.' }], {
      uuid: 'a2',
      uuids: ['r1', 'a2'],
    });
    const byId = new Map(planRepair(S, msgs, [chain]).updates.map((u) => [u.id, u]));
    expect(byId.get('A1')?.parts?.map((p) => p.type)).toEqual([
      'text',
      'citation_ref',
      'tool_call',
      'tool_result',
    ]);
    expect(byId.get('A1')?.usage).toBeUndefined();
    expect(byId.get('S1')).toMatchObject({
      parts: [{ type: 'text', text: 'Built.' }],
      claude_code: { uuids: ['r1', 'a2'], results_moved_to: 'A1' },
    });
  });

  it('leaves a result whose call is on another branch, another session, and messages still being written', () => {
    const msgs = v3();
    // The call's answer is a sibling, not above it.
    msgs[3] = stored('S1', 'assistant', 'U1', [resultPart('c1')], { uuid: 'r1', uuids: ['r1'] });
    expect(planRepair(S, msgs, [chain]).counts.moved).toBe(0);
    // Another session's messages are left to that session's own sync.
    expect(planRepair('another-session', v3(), [chain]).updates).toEqual([]);
    const busy = v3();
    (busy[3] as StoredMessage).status = 'streaming';
    expect(planRepair(S, busy, [chain]).updates).toEqual([]);
  });

  it('takes off a response counted twice, only where the stored tokens are what the older rule counted', () => {
    const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 };
    const twice = [
      ask('u1', 0, 'Go'),
      say('a1', 1, 'm1', [use('c1')], u),
      notice('n1', 2),
      res('r1', 3, 'c1'),
      say('a1b', 4, 'm1', [use('c2')], u),
      res('r2', 5, 'c2'),
      say('a3', 6, 'm2', [{ type: 'text', text: 'Done.' }], { input_tokens: 3, output_tokens: 7 }),
    ];
    const once = { input_tokens: 110, output_tokens: 5, cached_tokens: 100, cost_usd: 0 };
    const both = { input_tokens: 113, output_tokens: 12, cached_tokens: 100, cost_usd: 0 };
    const msgs = (second: StoredMessage['usage']) => [
      stored('U1', 'user', null, [{ type: 'text', text: 'Go' }], { uuid: 'u1', uuids: ['u1'] }),
      stored('A1', 'assistant', 'U1', [callPart('c1')], { uuid: 'a1', uuids: ['a1'] }, { usage: once }),
      stored('N1', 'system', 'A1', [{ type: 'text', text: '' }], {
        uuid: 'n1',
        uuids: ['n1'],
        kind: 'notification',
      }),
      stored(
        'S1',
        'assistant',
        'N1',
        [resultPart('c1'), callPart('c2'), resultPart('c2'), { type: 'text', text: 'Done.' }],
        { uuid: 'a3', uuids: ['r1', 'a1b', 'r2', 'a3'] },
        { usage: second },
      ),
    ];
    // As version 3 counted it: m1 again in the second message (with m2). Only m1 comes off, and
    // a cost (a live turn's estimate) stays.
    const fixed = planRepair(S, msgs({ ...both, cost_usd: 0.25 }), [twice]);
    expect(fixed.counts.recounted).toBe(1);
    expect(fixed.updates.find((x) => x.id === 'S1')?.usage).toEqual({
      input_tokens: 3,
      output_tokens: 7,
      cached_tokens: 0,
      cost_usd: 0.25,
    });
    // Already right (written by this version), or numbers it cannot account for: left as they are.
    const right = { input_tokens: 3, output_tokens: 7, cached_tokens: 0, cost_usd: 0 };
    for (const usage of [right, { ...both, input_tokens: 99 }])
      expect(planRepair(S, msgs(usage), [twice]).updates.find((x) => x.id === 'S1')?.usage).toBeUndefined();
    // An entry it cannot find in the transcript: left as it is.
    expect(planRepair(S, msgs(both), [twice.filter((e) => e.uuid !== 'a1b')]).counts.recounted).toBe(0);
    expect(planRepair(S, msgs(both), [twice]).updates.find((x) => x.id === 'A1')?.usage).toBeUndefined();
  });
});

describe('usage in the gateway meaning (CA2)', () => {
  it('counts cache reads and writes inside input, and says how many of them were which', () => {
    const e = say('a1', 0, 'm1', [], {
      input_tokens: 5,
      output_tokens: 7,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
    });
    expect(usageOf(e)).toEqual({
      input_tokens: 325,
      output_tokens: 7,
      cached_tokens: 300,
      cache_write_tokens: 20,
      cache_reported: true,
      cost_usd: 0,
    });
  });

  it('reports a cache that was zero as zero, not as unknown', () => {
    const u = usageOf(say('a2', 0, 'm2', [], { input_tokens: 4, output_tokens: 1 }));
    expect(u).toMatchObject({
      input_tokens: 4,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_reported: true,
    });
  });
});
