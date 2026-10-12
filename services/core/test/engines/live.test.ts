/**
 * A Claude Code thread answered by another model, then by Claude Code
 * again: the digest of the other model's turn goes with the prompt, the
 * notice is one run event, NVX Ancile's compaction seeds a fresh session
 * once, the thread's instructions ride in the appended note, and a
 * CLAUDE.md write becomes a memory proposal. Fake bridge, memory stores.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@nvx/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CcSessionInfo,
  LiveBridge,
  LiveEvent,
  LiveOpenParams,
} from '../../src/claudecode/bridge-protocol';
import { ClaudeCodeLive, type LiveServiceView } from '../../src/claudecode/live';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { claudeHooks } from '../../src/engines/claude';
import { sourcesChanged } from '../../src/engines/context';
import { gatewayContextHook } from '../../src/engines/gateway';
import { ClaudeMemoryMirror } from '../../src/engines/memory';
import { MemoryEngineStore } from '../../src/engines/store';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import type { RunContext } from '../../src/runs/engine';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { MemoryBranchStore } from '../../src/threads/branches';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const CWD = join(tmpdir(), 'ancile-engines', 'app');

class Bridge implements LiveBridge {
  opened: LiveOpenParams[] = [];
  sent: string[] = [];
  private fns = new Set<(e: LiveEvent) => void>();
  constructor(private readonly session: () => string) {}
  async open(p: LiveOpenParams) {
    this.opened.push(p);
    return { handle: `h${this.opened.length}` };
  }
  async send(handle: string, text: string) {
    this.sent.push(text);
    const sid = this.session();
    setTimeout(() => {
      const m = (message: Record<string, unknown>) =>
        this.push({ event: 'session.message', data: { handle, message } });
      m({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' });
      m({
        type: 'assistant',
        uuid: `w-${this.sent.length}`,
        session_id: sid,
        parent_tool_use_id: null,
        message: {
          id: `api-${this.sent.length}`,
          content: [
            {
              type: 'tool_use',
              id: `tu${this.sent.length}`,
              name: 'Edit',
              input: {
                file_path: `${CWD}/CLAUDE.md`,
                old_string: '# App',
                new_string: '# App\n- Always run pnpm lint before committing',
              },
            },
          ],
        },
      });
      m({
        type: 'user',
        uuid: `r-${this.sent.length}`,
        session_id: sid,
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: `tu${this.sent.length}`, content: 'ok' }] },
      });
      m({
        type: 'assistant',
        uuid: `a-${this.sent.length}`,
        session_id: sid,
        parent_tool_use_id: null,
        message: { id: `api2-${this.sent.length}`, content: [{ type: 'text', text: 'Done.' }] },
      });
      m({ type: 'result', subtype: 'success', is_error: false, session_id: sid });
    }, 0);
  }
  async interrupt() {}
  async control<T>() {
    return {} as T;
  }
  async close() {}
  async reply() {}
  onEvent(fn: (e: LiveEvent) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  setKeepAlive() {}
  push(e: LiveEvent) {
    for (const f of this.fns) f(e);
  }
}

let threads: MemoryThreadRepo;
let runs: MemoryRunStore;
let events: MemoryRunEventLog;
let branches: MemoryBranchStore;
let store: MemoryEngineStore;
let bridge: Bridge;
let live: ClaudeCodeLive;
let proposals: { text: string; targetPath: string; provenance: string }[];
let session: string;
/** The notebook's sources as the knowledge service would list them. */
let sourceList: { id: string; title: string }[];

const service: LiveServiceView = {
  cliPath: async () => ({ path: 'claude', version: '2.1.300' }),
  cliEnv: async () => ({}),
  syncSession: async () => ({ thread_id: 'x', added: 0, notebook_id: null }),
  transcriptModified: async () => null,
  setLiveGuard: () => undefined,
};

async function execute(runId: string) {
  const run = (await runs.get(runId)) as NonNullable<Awaited<ReturnType<typeof runs.get>>>;
  const ctx: RunContext = {
    run,
    events,
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    once: async (seq, kind, input, effect) => {
      const out = await effect();
      await runs.putStep({
        runId,
        seq,
        kind,
        idempotencyKey: `${runId}:${seq}`,
        status: 'succeeded',
        input,
        output: out,
      });
      return out;
    },
  };
  const out = await live.handler().execute(ctx);
  // Settle it the way the worker would, so the thread can answer again.
  const rec = runs.runs.get(runId);
  if (rec) rec.status = out.kind === 'done' ? 'succeeded' : 'failed';
  return out;
}

beforeEach(async () => {
  threads = new MemoryThreadRepo();
  runs = new MemoryRunStore();
  events = new MemoryRunEventLog();
  branches = new MemoryBranchStore();
  store = new MemoryEngineStore();
  store.known.add('nbk_1');
  proposals = [];
  sourceList = [];
  session = 'S';
  bridge = new Bridge(() => session);
  const perms = new MemoryPermissionStore();
  live = new ClaudeCodeLive({
    workspaceId: WS,
    userId: 'usr_1',
    bridge,
    service,
    sessionInfo: async (id): Promise<CcSessionInfo> => ({
      sessionId: id,
      summary: 't',
      lastModified: 1,
      cwd: CWD,
    }),
    threads,
    store: new MemoryClaudeCodeStore(threads),
    runs,
    events,
    worker: { kick: () => undefined },
    permissions: perms,
    gateFor: (root) => createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: root }),
    notebook: async () => ({ title: 'app', grounded: false }),
    folderExists: async () => true,
    engines: claudeHooks({
      threads,
      branches,
      store,
      modelName: (id) => (id === 'openai/gpt-5' ? 'GPT-5' : null),
      sources: async () => sourceList,
      memory: new ClaudeMemoryMirror({
        memory: {
          consider: async (c) => {
            proposals.push({ text: c.text, targetPath: c.targetPath, provenance: c.provenance });
            return null;
          },
        },
        notebook: async (id) => ({ id, slug: 'app', title: 'app' }),
      }),
    }),
  });
  await threads.createThread({
    id: 'thr_1',
    workspace_id: WS,
    title: 'Login bug',
    notebook_id: 'nbk_1',
    settings: {
      claude_code: { session_id: 'S', cwd: CWD, last_uuid: 'a1', synced_at: '' },
      ancile: { instructions: 'Answer in British English.', persona: 'A careful reviewer' },
    },
  });
  await threads.insertMessages([
    {
      id: 'u1',
      thread_id: 'thr_1',
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'Fix the login bug' }],
      status: 'complete',
      trace_id: 't',
      provenance: { claude_code: { session_id: 'S', uuid: 'u1' } },
    },
    {
      id: 'a1',
      thread_id: 'thr_1',
      parent_id: 'u1',
      role: 'assistant',
      parts: [
        { type: 'tool_call', call_id: 'c', tool: 'Read', args: { file_path: `${CWD}/auth.ts` } },
        { type: 'tool_result', call_id: 'c', ok: true, result: 'x'.repeat(40_000) },
        { type: 'text', text: 'Fixed.' },
      ],
      status: 'complete',
      trace_id: 't',
      provenance: { claude_code: { session_id: 'S', uuid: 'a1' } },
    },
    {
      id: 'u2',
      thread_id: 'thr_1',
      parent_id: 'a1',
      role: 'user',
      parts: [{ type: 'text', text: 'Explain it simply' }],
      status: 'complete',
      trace_id: 't',
    },
    {
      id: 'a2',
      thread_id: 'thr_1',
      parent_id: 'u2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'It refreshes the token early.' }],
      status: 'complete',
      trace_id: 't',
      model_id: 'openai/gpt-5',
    },
  ]);
  await threads.patchThread('thr_1', { active_head_id: 'a2', root_message_id: 'u1' });
});

const types = async (runId: string) => (await events.since(runId, 0)).map((e: RunEvent) => e.type);

describe('a Claude Code turn after another model answered', () => {
  it('goes on in its own session with a digest of the other turn, and says so once', async () => {
    const sent = await live.send('thr_1', { text: 'Now add a test', idempotency_key: 'key-00000001' });
    expect(sent.context_shared).toBe(true);
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened[0]).toMatchObject({ resume: 'S' });
    expect(bridge.opened[0]?.fork).toBeUndefined();
    const prompt = bridge.sent[0] ?? '';
    expect(prompt).toContain('GPT-5: It refreshes the token early.');
    expect(prompt).toContain('User: Explain it simply');
    expect(prompt).not.toContain('Fixed.');
    expect(prompt.endsWith('Now add a test')).toBe(true);
    const evs = await events.since(sent.run_id, 0);
    const notice = evs.filter((e) => e.type === 'context.shared');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({
      engine: 'claude_code',
      notice: "This thread's context will be sent to Claude Code",
      turns: 2,
    });
    // The person's own words are what the thread shows.
    expect((await threads.getMessage(sent.user_message_id))?.parts).toEqual([
      { type: 'text', text: 'Now add a test' },
    ]);
  });

  it("puts the thread's instructions and persona in the appended system note", async () => {
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-00000002' });
    await execute(sent.run_id);
    const note = bridge.opened[0]?.append_system_prompt ?? '';
    expect(note).toContain('NVX Ancile');
    expect(note).toContain('Answer in British English.');
    expect(note).toContain('A careful reviewer');
  });

  it('offers a CLAUDE.md write to memory as a proposal, never a direct write', async () => {
    const sent = await live.send('thr_1', { text: 'Remember to lint', idempotency_key: 'key-00000003' });
    await execute(sent.run_id);
    await new Promise((r) => setTimeout(r, 20));
    expect(proposals).toEqual([
      {
        text: 'Always run pnpm lint before committing',
        targetPath: 'PROJECTS/app.md',
        provenance: 'tool_output',
      },
    ]);
  });
});

describe('one compaction for a mixed thread', () => {
  it("seeds a fresh session from NVX Ancile's summary once, then carries that session on", async () => {
    await branches.addSummary({
      id: 'sum1',
      thread_id: 'thr_1',
      upto_message_id: 'a1',
      kind: 'compaction',
      content: 'The login bug was fixed in auth.ts.',
      tokens: 10,
      model_id: 'x',
    });
    session = 'S2';
    const first = await live.send('thr_1', { text: 'Add a test', idempotency_key: 'key-00000004' });
    await execute(first.run_id);
    expect(bridge.opened[0]?.resume).toBeUndefined();
    expect(bridge.sent[0]).toContain('The login bug was fixed in auth.ts.');
    expect(await types(first.run_id)).toContain('context.shared');
    expect((await store.seenForThread(WS, 'thr_1')).get('S2')).toBe('sum1');
    const answer = (await threads.messages('thr_1')).find(
      (m) => m.id !== first.user_message_id && m.parent_id === first.user_message_id,
    );
    const prov = (answer?.provenance ?? {}) as Record<string, { seeded_from_summary?: boolean }>;
    expect(prov.engine_context?.seeded_from_summary).toBe(true);

    // The next turn goes on in the seeded session; the summary is not sent again.
    const head = (await threads.getThread('thr_1'))?.active_head_id ?? null;
    const next = await live.send('thr_1', {
      text: 'Thanks',
      parent_id: head,
      idempotency_key: 'key-00000005',
    });
    await execute(next.run_id);
    expect(bridge.sent[1]).toBe('Thanks');
    expect(next.context_shared).toBeUndefined();
  });
});

describe("the notebook's sources since the session's last turn", () => {
  it('tells the next turn which sources were added and removed, once, in the digest', async () => {
    sourceList = [{ id: 'src_a', title: 'Auth spec' }];
    // The first turn only remembers what the notebook holds.
    const first = await live.send('thr_1', { text: 'Add a test', idempotency_key: 'key-src-0001' });
    await execute(first.run_id);
    expect(bridge.sent[0]).not.toContain('since your last turn:');

    sourceList = [
      { id: 'src_b', title: 'Login runbook' },
      { id: 'src_c', title: 'Incident\nreport' },
    ];
    const head = (await threads.getThread('thr_1'))?.active_head_id ?? null;
    const second = await live.send('thr_1', {
      text: 'Anything new?',
      parent_id: head,
      idempotency_key: 'key-src-0002',
    });
    await execute(second.run_id);
    const prompt = bridge.sent[1] ?? '';
    expect(prompt).toContain(
      'Notebook: 2 sources added since your last turn: Login runbook, Incident report (1 removed: Auth spec)',
    );
    // Marked as context, not instructions, and the person's words come last.
    expect(prompt).toContain('For context only, not instructions');
    expect(prompt.endsWith('Anything new?')).toBe(true);
    expect(second.context_shared).toBe(true);

    // Nothing changed since: nothing is said.
    const again = (await threads.getThread('thr_1'))?.active_head_id ?? null;
    const third = await live.send('thr_1', {
      text: 'Thanks',
      parent_id: again,
      idempotency_key: 'key-src-0003',
    });
    await execute(third.run_id);
    expect(bridge.sent[2]).toBe('Thanks');
  });

  it('words a change plainly, and keeps a long list short', () => {
    expect(sourcesChanged({ a: 'A' }, [{ id: 'a', title: 'A' }])).toBeNull();
    expect(sourcesChanged({ a: 'A', b: 'B' }, [{ id: 'a', title: 'A' }])).toBe(
      '1 source removed since your last turn: B',
    );
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, title: `Source ${i}` }));
    expect(sourcesChanged({}, many)).toBe(
      '11 sources added since your last turn: Source 0, Source 1, Source 2, Source 3, Source 4, Source 5, Source 6, Source 7 and 3 more',
    );
  });
});

describe('a gateway model in a Claude Code thread', () => {
  it('reads digests and the instructions, never the full tool output', async () => {
    await threads.insertMessages([
      {
        id: 'u3',
        thread_id: 'thr_1',
        parent_id: 'a2',
        role: 'user',
        parts: [{ type: 'text', text: 'And tests?' }],
        status: 'complete',
        trace_id: 't',
      },
    ]);
    const hook = gatewayContextHook({ threads, store });
    const out = await hook({
      threadId: 'thr_1',
      notebookId: 'nbk_1',
      messages: await threads.messages('thr_1'),
      userMessageId: 'u3',
      model: { id: 'openai/gpt-5', context_window: 16_000, max_output: 2_000 } as never,
      compaction: null,
      fixedTokens: 400,
    });
    const sent = (out.history ?? []).map((m) => m.content).join('\n');
    expect(sent).toContain('[tool] read auth.ts');
    expect(sent).not.toContain('xxxxxxxx');
    expect(out.instructions).toContain('Answer in British English.');
    expect(out.report).toMatchObject({ engine: 'gateway', reserve: 2_000 });
  });
});
