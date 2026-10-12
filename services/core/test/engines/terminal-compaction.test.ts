/**
 * Claude Code compacts in the terminal mid-session, in a thread other
 * models answer too (track G). From a fixture transcript: the compaction
 * comes in as Claude Code's own rows (a divider and its summary); NVX
 * Ancile's compaction summary stays the record a gateway model reads; the
 * terminal's summary never reaches a gateway model or NVX Ancile's budget;
 * and the next live turn from NVX Ancile carries the same session on
 * instead of seeding a fresh one from a summary of turns Claude Code has
 * already compacted itself.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CcSessionInfo,
  LiveBridge,
  LiveEvent,
  LiveOpenParams,
} from '../../src/claudecode/bridge-protocol';
import { ClaudeCodeLive, type LiveServiceView } from '../../src/claudecode/live';
import { planSync } from '../../src/claudecode/map';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { readTranscript } from '../../src/claudecode/transcript';
import { claudeHooks } from '../../src/engines/claude';
import { pathTo, planClaudeTurn } from '../../src/engines/context';
import { gatewayContextHook } from '../../src/engines/gateway';
import { MemoryEngineStore } from '../../src/engines/store';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import type { RunContext } from '../../src/runs/engine';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { MemoryBranchStore } from '../../src/threads/branches';
import { isClaudeCodeCompaction, pathBudget } from '../../src/threads/compact';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const SID = '0b8f7c1e-2222-4a6e-9f00-000000000002';
const CWD = join(tmpdir(), 'ancile-terminal-compaction', 'app');
const CC_SUMMARY = 'This session is being continued from a previous conversation. TERMINAL-SUMMARY-TEXT';
const ANCILE_SUMMARY = 'ANCILE-SUMMARY: the login bug was fixed and explained.';

let seq = 0;
const at = () => new Date(Date.UTC(2026, 9, 1, 9, 0, seq++)).toISOString();
const base = (uuid: string, parentUuid: string | null) => ({
  uuid,
  parentUuid,
  isSidechain: false,
  sessionId: SID,
  cwd: CWD,
  timestamp: at(),
  userType: 'external',
  version: '2.1.300',
});
const prompt = (uuid: string, parent: string | null, text: string) => ({
  ...base(uuid, parent),
  type: 'user',
  message: { role: 'user', content: text },
});
const say = (uuid: string, parent: string, api: string, text: string) => ({
  ...base(uuid, parent),
  type: 'assistant',
  message: { id: api, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
});

/**
 * The session's own file: q1/r1 came from the terminal, q3/r3 were a turn
 * sent from NVX Ancile (Claude Code wrote them under the ids NVX Ancile
 * gave), then the person went on in the terminal, Claude Code compacted by
 * itself, and one more turn followed.
 */
const fixture = () => {
  seq = 0;
  return [
    prompt('q1', null, 'Fix the login bug'),
    say('r1', 'q1', 'm1', 'Fixed.'),
    prompt('q3', 'r1', 'Now add a test'),
    say('r3', 'q3', 'm3', 'Test added.'),
    {
      ...base('cb', null),
      type: 'system',
      subtype: 'compact_boundary',
      logicalParentUuid: 'r3',
      compactMetadata: { trigger: 'auto' },
    },
    { ...prompt('cs', 'cb', CC_SUMMARY), isCompactSummary: true, isVisibleInTranscriptOnly: true },
    prompt('q6', 'cs', 'Run the suite'),
    say('r6', 'q6', 'm6', 'All green.'),
  ];
};

class Bridge implements LiveBridge {
  opened: LiveOpenParams[] = [];
  sent: string[] = [];
  private fns = new Set<(e: LiveEvent) => void>();
  async open(p: LiveOpenParams) {
    this.opened.push(p);
    return { handle: `h${this.opened.length}` };
  }
  async send(handle: string, text: string) {
    this.sent.push(text);
    setTimeout(() => {
      const m = (message: Record<string, unknown>) =>
        this.push({ event: 'session.message', data: { handle, message } });
      m({ type: 'system', subtype: 'init', session_id: SID });
      m({
        type: 'assistant',
        uuid: `w-${this.sent.length}`,
        session_id: SID,
        parent_tool_use_id: null,
        message: { id: `api-${this.sent.length}`, content: [{ type: 'text', text: 'Done.' }] },
      });
      m({ type: 'result', subtype: 'success', is_error: false, session_id: SID });
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

let dir: string;
let threads: MemoryThreadRepo;
let runs: MemoryRunStore;
let events: MemoryRunEventLog;
let branches: MemoryBranchStore;
let store: MemoryEngineStore;
let bridge: Bridge;
let live: ClaudeCodeLive;

const service: LiveServiceView = {
  cliPath: async () => ({ path: 'claude', version: '2.1.300' }),
  cliEnv: async () => ({}),
  syncSession: async () => ({ thread_id: 'thr_1', added: 0, notebook_id: null }),
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
    once: async (s, kind, input, effect) => {
      const out = await effect();
      await runs.putStep({
        runId,
        seq: s,
        kind,
        idempotencyKey: `${runId}:${s}`,
        status: 'succeeded',
        input,
        output: out,
      });
      return out;
    },
  };
  const out = await live.handler().execute(ctx);
  const rec = runs.runs.get(runId);
  if (rec) rec.status = out.kind === 'done' ? 'succeeded' : 'failed';
  return out;
}

const cc = (uuid: string, extra: Record<string, unknown> = {}) => ({
  claude_code: { session_id: SID, uuid, uuids: [uuid], ...extra },
});

/**
 * The thread as NVX Ancile holds it before the terminal went on: q1/r1 from
 * the transcript, a turn by GPT-5, then q3/r3 sent from NVX Ancile; then
 * the transcript is synced in through the same mapping an import uses.
 */
async function build(withTerminal: boolean) {
  await threads.createThread({
    id: 'thr_1',
    workspace_id: WS,
    title: 'Login bug',
    notebook_id: 'nbk_1',
    settings: { claude_code: { session_id: SID, cwd: CWD, last_uuid: 'r3', synced_at: '' } },
  });
  const row = (id: string, parent: string | null, role: 'user' | 'assistant', text: string, extra = {}) => ({
    id,
    thread_id: 'thr_1',
    parent_id: parent,
    role,
    parts: [{ type: 'text' as const, text }],
    status: 'complete' as const,
    trace_id: 't',
    ...extra,
  });
  await threads.insertMessages([
    row('m_q1', null, 'user', 'Fix the login bug', { provenance: cc('q1') }),
    row('m_r1', 'm_q1', 'assistant', 'Fixed.', { provenance: cc('r1') }),
    row('m_u2', 'm_r1', 'user', 'Explain it simply'),
    row('m_a2', 'm_u2', 'assistant', 'It refreshes the token early.', { model_id: 'openai/gpt-5' }),
    row('m_q3', 'm_a2', 'user', 'Now add a test', { provenance: cc('q3') }),
    row('m_r3', 'm_q3', 'assistant', 'Test added.', { provenance: cc('r3', { live: true }) }),
  ]);
  let head = 'm_r3';
  if (withTerminal) {
    const path = join(dir, `${SID}.jsonl`);
    await writeFile(
      path,
      `${fixture()
        .map((r) => JSON.stringify(r))
        .join('\n')}\n`,
    );
    const read = await readTranscript(path, SID);
    if (!read.ok) throw new Error(read.reason);
    expect(read.stats.compactions).toBe(1);
    const mirror = await new MemoryClaudeCodeStore(threads).mirror('thr_1');
    let n = 0;
    const plan = planSync(read.chains.at(-1) ?? [], mirror, () => `m_new${n++}`, head);
    await threads.insertMessages(
      plan.planned
        .filter((p) => !p.extends)
        .map((p) => ({
          id: p.id,
          thread_id: 'thr_1',
          parent_id: p.parent_id,
          role: p.role,
          parts: p.parts,
          status: 'complete' as const,
          trace_id: 't',
          provenance: {
            claude_code: {
              session_id: SID,
              uuid: p.uuids.at(-1) ?? '',
              uuids: p.uuids,
              ...(p.kind && { kind: p.kind }),
            },
          },
        })),
    );
    head = plan.head ?? head;
  }
  await threads.patchThread('thr_1', { active_head_id: head, root_message_id: 'm_q1' });
  // NVX Ancile compacted the mixed path up to Claude Code's turn sent from it.
  await branches.addSummary({
    id: 'sum1',
    thread_id: 'thr_1',
    upto_message_id: 'm_r3',
    kind: 'compaction',
    content: ANCILE_SUMMARY,
    tokens: 12,
    model_id: 'x',
  });
  return head;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-terminal-compaction-'));
  threads = new MemoryThreadRepo();
  runs = new MemoryRunStore();
  events = new MemoryRunEventLog();
  branches = new MemoryBranchStore();
  store = new MemoryEngineStore();
  store.known.add('nbk_1');
  bridge = new Bridge();
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
    }),
  });
});
afterEach(async () => {
  live.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('Claude Code compacted in the terminal, in a mixed thread', () => {
  it('comes in as its own rows: a divider and the summary, hung after the turn it followed', async () => {
    const head = await build(true);
    const path = pathTo(await threads.messages('thr_1'), head);
    const kinds = path.map(
      (m) => (m.provenance?.claude_code as { kind?: string } | undefined)?.kind ?? m.role,
    );
    expect(kinds).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'compact_boundary',
      'compact_summary',
      'user',
      'assistant',
    ]);
    expect(path.filter(isClaudeCodeCompaction)).toHaveLength(2);
  });

  it('the next live turn carries the same session on: no fresh session, no summary sent again', async () => {
    const head = await build(true);
    const sent = await live.send('thr_1', {
      text: 'And the docs?',
      parent_id: head,
      idempotency_key: 'key-tc-0001',
    });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened[0]).toMatchObject({ resume: SID });
    expect(bridge.opened[0]?.fork).toBeUndefined();
    expect(bridge.sent[0]).toBe('And the docs?');
    expect(sent.context_shared).toBeUndefined();
    expect((await store.seenForThread(WS, 'thr_1')).size).toBe(0);
  });

  it('without the terminal compaction, the same thread is seeded from NVX Ancile’s summary once', async () => {
    const head = await build(false);
    const sent = await live.send('thr_1', {
      text: 'And the docs?',
      parent_id: head,
      idempotency_key: 'key-tc-0002',
    });
    await execute(sent.run_id);
    expect(bridge.opened[0]?.resume).toBeUndefined();
    expect(bridge.sent[0]).toContain(ANCILE_SUMMARY);
  });

  it('a summary newer than the terminal compaction still seeds (it covers turns Claude Code never compacted)', async () => {
    const head = await build(true);
    const messages = await threads.messages('thr_1');
    const plan = planClaudeTurn({
      messages,
      parentId: head,
      threadSessionId: SID,
      summary: { id: 'sum2', uptoMessageId: head, content: 'newer' },
      seen: () => false,
    });
    expect(plan.seed).toEqual({ summaryId: 'sum2' });
  });

  it('a gateway model reads NVX Ancile’s summary, never the terminal’s, and its budget leaves the terminal rows out', async () => {
    const head = await build(true);
    await threads.insertMessages([
      {
        id: 'm_u7',
        thread_id: 'thr_1',
        parent_id: head,
        role: 'user',
        parts: [{ type: 'text', text: 'Summarise where we are' }],
        status: 'complete',
        trace_id: 't',
      },
    ]);
    const messages = await threads.messages('thr_1');
    const hook = gatewayContextHook({ threads, store });
    const out = await hook({
      threadId: 'thr_1',
      notebookId: 'nbk_1',
      messages,
      userMessageId: 'm_u7',
      model: { id: 'openai/gpt-5', context_window: 32_000, max_output: 2_000 } as never,
      compaction: { summaryId: 'sum1', skipThrough: 'm_r3', note: `Summary:\n\n${ANCILE_SUMMARY}` } as never,
      fixedTokens: 200,
    });
    const sent = [out.note, ...(out.history ?? []).map((m) => m.content)].join('\n');
    expect(sent).toContain(ANCILE_SUMMARY);
    expect(sent).not.toContain('TERMINAL-SUMMARY-TEXT');
    expect(out.report?.summary_id).toBe('sum1');

    const path = pathTo(messages, 'm_u7');
    const withRows = pathBudget({ headId: 'm_u7', path, summaries: [], model: undefined });
    const withoutRows = pathBudget({
      headId: 'm_u7',
      path: path.filter((m) => !isClaudeCodeCompaction(m)),
      summaries: [],
      model: undefined,
    });
    expect(withRows.used.history).toBe(withoutRows.used.history);
  });
});
