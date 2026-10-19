/**
 * A tool result kept with its call (mapper version 4), through the
 * service: imports, syncs that land between a call and its result, usage
 * of a response that spans two messages, and threads an older mapping
 * wrote, repaired in place on the next pass without losing what a live
 * turn wrote. Fake bridge and memory stores, as sessions.test.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Part, Usage } from '@nvx/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../../src/claudecode/bridge';
import type { CcSessionMessage } from '../../src/claudecode/bridge-protocol';
import { ClaudeCli } from '../../src/claudecode/cli';
import { ClaudeInstaller } from '../../src/claudecode/install';
import { MAPPER_VERSION, type PlannedMessage } from '../../src/claudecode/map';
import { applyExtension, ClaudeCodeService } from '../../src/claudecode/service';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { ClaudeVerifier } from '../../src/claudecode/verify';
import { digestParts } from '../../src/engines/digest';
import type { EventBus, GlobalEventInput } from '../../src/events/bus';
import { pairTools } from '../../src/explain/assemble';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { MemorySettings } from '../../src/settings';
import { MemoryThreadRepo, type MessageRecord } from '../../src/threads/repo';
import { assistant, type FakeWorld, fakeLauncher, info, toolResult, user, world } from './fake-bridge';

const WS = 'wsp_01TESTWORKSPACE000000000000';

class Bus implements EventBus {
  events: GlobalEventInput[] = [];
  async publish(e: GlobalEventInput) {
    this.events.push(e);
  }
  subscribe() {
    return () => undefined;
  }
}

let w: FakeWorld;
let launcher: ReturnType<typeof fakeLauncher>;
let bridge: BridgeClient;
let threads: MemoryThreadRepo;
let store: MemoryClaudeCodeStore;
let svc: ClaudeCodeService;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-cc-stray-'));
  w = world();
  launcher = fakeLauncher(w);
  bridge = new BridgeClient({ launch: launcher, idleMs: 60_000 });
  threads = new MemoryThreadRepo();
  store = new MemoryClaudeCodeStore(threads, 'win32');
  svc = new ClaudeCodeService({
    workspaceId: WS,
    settings: new MemorySettings(),
    bus: new Bus(),
    threads,
    notebooks: new MemoryNotebookRepo(),
    store,
    source: bridge,
    cli: new ClaudeCli({
      locate: () => ({ path: 'claude', cmd: 'claude', prefix: [] }),
      spawn: async (_c, args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '2.1.286 (Claude Code)', stderr: '', timedOut: false }
          : {
              code: 0,
              stdout: JSON.stringify({ loggedIn: true, projectsDirectory: dir }),
              stderr: '',
              timedOut: false,
            },
    }),
    installer: new ClaudeInstaller({ found: () => true }),
    verifier: new ClaudeVerifier({ manifest: async () => ({}) }),
    platform: 'win32',
    pathExists: () => true,
    auto: { startDelayMs: 0, debounceMs: 50, pauseMs: 0 },
  });
});

afterEach(async () => {
  svc.stop();
  bridge.stop();
  await launcher.close();
  await rm(dir, { recursive: true, force: true });
});

const TASK =
  '<task-notification>\n<task-id>b1x9</task-id>\n<status>completed</status>\n<summary>Build finished</summary>\n</task-notification>';
const call = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: `run ${id}` } });
const ms = (e: CcSessionMessage) => Date.parse(e.timestamp as string);
const textOf = (parts: Part[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
const ccOf = (m: MessageRecord | undefined) =>
  m?.provenance?.claude_code as { uuids?: string[]; kind?: string; results_moved_to?: string } | undefined;
const onlyResults = (m: MessageRecord) =>
  m.parts.some((p) => p.type === 'tool_result') &&
  m.parts.every((p) => p.type === 'tool_result' || (p.type === 'text' && !p.text.trim()));
const total = (msgs: MessageRecord[]) =>
  msgs.reduce(
    (t, m) => ({
      input: t.input + (m.usage?.input_tokens ?? 0),
      output: t.output + (m.usage?.output_tokens ?? 0),
      cached: t.cached + (m.usage?.cached_tokens ?? 0),
    }),
    { input: 0, output: 0, cached: 0 },
  );

async function bring(chain: CcSessionMessage[]) {
  w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\app' }), chain });
  const r = await svc.importSessions({ session_ids: ['s1'] });
  return r.imported[0]?.thread_id as string;
}

describe('a result with its call', () => {
  it('a notification between a call and its result: one answer holds both, and Why and digests pair them', async () => {
    const chain = [
      user('u1', 'Build it'),
      assistant('a1', [call('c1')]),
      user('n1', TASK),
      toolResult('r1', 'c1', 'built'),
      assistant('a2', [{ type: 'text', text: 'Built.' }]),
    ];
    const id = await bring(chain);
    const msgs = await threads.messages(id);
    expect(msgs.filter(onlyResults)).toEqual([]);
    const answer = msgs.find((m) => m.parts.some((p) => p.type === 'tool_call'));
    expect(answer?.parts).toEqual([
      { type: 'tool_call', call_id: 'c1', tool: 'Bash', args: { command: 'run c1' } },
      {
        type: 'tool_result',
        call_id: 'c1',
        ok: true,
        result: 'built',
        duration_ms: ms(chain[3] as CcSessionMessage) - ms(chain[1] as CcSessionMessage),
      },
    ]);
    const note = msgs.find((m) => ccOf(m)?.kind === 'notification');
    expect(note?.parent_id).toBe(answer?.id);
    expect(ccOf(note)?.uuids).toEqual(['n1', 'r1']);
    const after = msgs.find((m) => textOf(m.parts) === 'Built.');
    expect(after?.parent_id).toBe(note?.id);
    expect((await threads.getThread(id))?.active_head_id).toBe(after?.id);
    // The Why panel and other models' digests see the step with its result.
    const parts = answer?.parts ?? [];
    expect(pairTools(parts, [], () => undefined)).toMatchObject([
      { call_id: 'c1', ok: true, result: 'built' },
    ]);
    expect(digestParts(parts).text).toBe('[tool] ran `run c1` → exit 0');
  });

  it('a sync between the call, the notification and the result: the same thread, and nothing twice', async () => {
    const chain = [user('u1', 'Build it'), assistant('a1', [call('c1')]), user('n1', TASK)];
    const id = await bring(chain);
    const before = await threads.messages(id);
    chain.push(toolResult('r1', 'c1', 'built'), assistant('a2', [{ type: 'text', text: 'Built.' }]));
    await svc.syncThread(id);
    const msgs = await threads.messages(id);
    expect(msgs.filter(onlyResults)).toEqual([]);
    expect(msgs.map((m) => m.id).slice(0, before.length)).toEqual(before.map((m) => m.id));
    const answer = msgs.find((m) => m.parts.some((p) => p.type === 'tool_call'));
    expect(answer?.parts.map((p) => p.type)).toEqual(['tool_call', 'tool_result']);
    const note = msgs.find((m) => ccOf(m)?.kind === 'notification');
    expect(msgs.find((m) => textOf(m.parts) === 'Built.')?.parent_id).toBe(note?.id);
    expect((await svc.syncThread(id)).added).toBe(0);
    // What comes next hangs on, in order.
    chain.push(user('u2', 'Thanks'));
    await svc.syncThread(id);
    const last = (await threads.messages(id)).find((m) => textOf(m.parts) === 'Thanks');
    expect(last?.parent_id).toBe(msgs.find((m) => textOf(m.parts) === 'Built.')?.id);
  });

  it('a response that goes on after a notification is counted once, across syncs too', async () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 };
    const chain = [
      user('u1', 'Go'),
      assistant('a1', [call('c1')], { id: 'm1', usage }),
      user('n1', TASK),
      toolResult('r1', 'c1', 'one'),
    ];
    const id = await bring(chain);
    chain.push(
      assistant('a1b', [call('c2')], { id: 'm1', usage }),
      toolResult('r2', 'c2', 'two'),
      assistant('a3', [{ type: 'text', text: 'Both done.' }], {
        id: 'm2',
        usage: { input_tokens: 3, output_tokens: 7 },
      }),
    );
    await svc.syncThread(id);
    const msgs = await threads.messages(id);
    expect(total(msgs)).toEqual({ input: 113, output: 12, cached: 100 });
    expect(msgs.filter(onlyResults)).toEqual([]);
  });
});

describe('a thread an older mapping wrote', () => {
  const live = {
    session_id: 's1',
    uuid: 'a3',
    uuids: ['a3'],
    live: true,
    setup: { lean: false },
    cost_estimate: {
      usd: 0.02,
      note: "Claude Code's own estimate at API list prices; not what your account is billed.",
    },
  };
  const citation: Part = {
    type: 'citation_ref',
    marker: 1,
    chunk_id: 'chk_1',
    source_id: 'src_1',
    char_start: 0,
    char_end: 4,
    quote: 'Spec',
  };

  /** As version 3 left it: the result in an answer of its own, then a live turn from NVX Ancile. */
  async function olderThread(version: number) {
    const chain = [user('u1', 'Build it'), assistant('a1', [call('c1')]), user('n1', TASK)];
    const id = await bring(chain);
    const note = (await threads.messages(id)).find((m) => ccOf(m)?.kind === 'notification') as MessageRecord;
    const base = { thread_id: id, status: 'complete' as const, trace_id: '0'.repeat(32) };
    await threads.insertMessages([
      {
        ...base,
        id: 'msg_stray',
        parent_id: note.id,
        role: 'assistant',
        parts: [{ type: 'tool_result', call_id: 'c1', ok: true, result: 'built' }],
        provenance: { claude_code: { session_id: 's1', uuid: 'r1', uuids: ['r1'] } },
      },
      {
        ...base,
        id: 'msg_live_u',
        parent_id: 'msg_stray',
        role: 'user',
        parts: [{ type: 'text', text: 'Is it to spec?' }],
        provenance: { claude_code: { session_id: 's1', uuid: 'u2', uuids: ['ours-u2', 'u2'] } },
      },
      {
        ...base,
        id: 'msg_live_a',
        parent_id: 'msg_live_u',
        role: 'assistant',
        run_id: 'run_live',
        model_id: 'claude-code/claude-opus-5-5',
        parts: [{ type: 'text', text: 'Spec says yes [1].' }, citation],
        usage: { input_tokens: 10, output_tokens: 4, cached_tokens: 100, cost_usd: 0.02 },
        provenance: {
          model_name: 'Claude Code',
          claude_code: live,
          retrieval: { query: '', hits: [{ marker: 1, chunk_id: 'chk_1', cited: true }] },
          engine_context: { recalled: [] },
        },
      },
    ]);
    await threads.patchThread(id, { active_head_id: 'msg_live_a' });
    chain.push(
      toolResult('r1', 'c1', 'built'),
      user('u2', 'Is it to spec?'),
      assistant('a3', [{ type: 'text', text: 'Spec says yes [1].' }]),
    );
    const b = (await store.sessions(WS))[0] as NonNullable<Awaited<ReturnType<typeof store.sessions>>[0]>;
    await store.putSession(WS, { ...b, mapper_version: version });
    return { id, chain };
  }

  it('is repaired in place on the next pass: the result joins its call, and the live turn keeps everything', async () => {
    const { id, chain } = await olderThread(3);
    const before = await threads.messages(id);
    const liveBefore = await threads.getMessage('msg_live_a');
    svc.kick();
    await svc.idle();

    const after = await threads.messages(id);
    expect(after.map((m) => [m.id, m.parent_id])).toEqual(before.map((m) => [m.id, m.parent_id]));
    const answer = after.find((m) => m.parts.some((p) => p.type === 'tool_call'));
    expect(answer?.parts[1]).toEqual({
      type: 'tool_result',
      call_id: 'c1',
      ok: true,
      result: 'built',
      duration_ms: ms(chain[3] as CcSessionMessage) - ms(chain[1] as CcSessionMessage),
    });
    const stray = await threads.getMessage('msg_stray');
    expect(stray?.parts).toEqual([{ type: 'text', text: '' }]);
    expect(ccOf(stray)).toMatchObject({ uuids: ['r1'], results_moved_to: answer?.id });
    // The live turn: its citations, retrieval, cost, setup, run and id, all as they were.
    expect(await threads.getMessage('msg_live_a')).toEqual(liveBefore);
    expect((await threads.getThread(id))?.active_head_id).toBe('msg_live_a');
    expect((await store.sessions(WS))[0]?.mapper_version).toBe(MAPPER_VERSION);

    // Once repaired, a pass leaves it alone; the next entries hang where they belong.
    svc.kick();
    await svc.idle();
    expect(await threads.messages(id)).toEqual(after);
    chain.push(user('u3', 'Ship it'));
    await svc.syncThread(id);
    expect((await threads.messages(id)).find((m) => textOf(m.parts) === 'Ship it')?.parent_id).toBe(
      'msg_live_a',
    );
  });

  it('is never rebuilt when it holds a live turn, even from before full history', async () => {
    const { id } = await olderThread(2);
    const before = (await threads.messages(id)).map((m) => m.id);
    svc.kick();
    await svc.idle();
    expect((await threads.messages(id)).map((m) => m.id)).toEqual(before);
    expect((await threads.getMessage('msg_stray'))?.parts).toEqual([{ type: 'text', text: '' }]);
    expect((await threads.getMessage('msg_live_a'))?.provenance).toMatchObject({
      claude_code: live,
      retrieval: { hits: [{ marker: 1 }] },
    });
    expect((await store.sessions(WS))[0]?.mapper_version).toBe(MAPPER_VERSION);
  });
});

describe('writing what a plan adds to a message already there', () => {
  it('appends parts, entries, usage and notes, and says when the message is gone', async () => {
    await threads.createThread({ id: 'thr_x', workspace_id: WS });
    const usage: Usage = { input_tokens: 1, output_tokens: 2, cached_tokens: 0, cost_usd: 0 };
    await threads.insertMessage({
      id: 'msg_x',
      thread_id: 'thr_x',
      parent_id: null,
      role: 'assistant',
      parts: [{ type: 'tool_call', call_id: 'c1', tool: 'Bash', args: {} }],
      status: 'complete',
      trace_id: 't',
      usage,
      provenance: {
        retrieval: { kept: true },
        claude_code: { session_id: 's1', uuid: 'a1', uuids: ['a1'], unknown: { count: 1, types: ['x'] } },
      },
    });
    const p: PlannedMessage = {
      id: 'msg_x',
      extends: true,
      parent_id: null,
      role: 'assistant',
      parts: [{ type: 'tool_result', call_id: 'c1', ok: true, result: 'ok', duration_ms: 5 }],
      uuids: ['k1'],
      created_at: null,
      model_id: null,
      usage,
      kind: null,
      last_api_id: 'm1',
      unknown: { count: 1, types: ['y'] },
    };
    expect(await applyExtension(threads, p)).toBe(true);
    const m = await threads.getMessage('msg_x');
    expect(m?.parts.map((x) => x.type)).toEqual(['tool_call', 'tool_result']);
    expect(m?.usage).toEqual({ ...usage, input_tokens: 2, output_tokens: 4 });
    expect(m?.provenance).toEqual({
      retrieval: { kept: true },
      claude_code: {
        session_id: 's1',
        uuid: 'k1',
        uuids: ['a1', 'k1'],
        last_api_id: 'm1',
        unknown: { count: 2, types: ['x', 'y'] },
      },
    });
    expect(await applyExtension(threads, { ...p, id: 'msg_gone' })).toBe(false);
  });
});
