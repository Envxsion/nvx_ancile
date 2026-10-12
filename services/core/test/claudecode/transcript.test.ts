/**
 * The full-history transcript reader, on synthetic JSONL files shaped like
 * Claude Code's (key names learned from real files, never their content):
 * rewinds, parallel tool calls, compactions, queued prompts, sidechains,
 * lines it does not know and a half-written last line. Then a thread
 * rebuilt from one, through the same mapping an import uses.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../../src/claudecode/bridge';
import { ClaudeCli } from '../../src/claudecode/cli';
import { ClaudeInstaller } from '../../src/claudecode/install';
import { MAPPER_VERSION } from '../../src/claudecode/map';
import { ClaudeCodeService } from '../../src/claudecode/service';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import {
  buildChains,
  coversSdkChain,
  findTranscript,
  MAX_UNKNOWN_SHARE,
  parseEntries,
  readTranscript,
} from '../../src/claudecode/transcript';
import { ClaudeVerifier } from '../../src/claudecode/verify';
import type { EventBus } from '../../src/events/bus';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { setLogTap } from '../../src/obs/logger';
import { MemorySettings } from '../../src/settings';
import { MemoryThreadRepo, textOf } from '../../src/threads/repo';
import { type FakeWorld, fakeLauncher, info, world } from './fake-bridge';

const SID = '7b0c4b2e-1111-4a6e-9f00-000000000001';
const CWD = 'C:\\Code\\app';
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
  version: '2.1.286',
});
const prompt = (uuid: string, parent: string | null, text: string) => ({
  ...base(uuid, parent),
  type: 'user',
  message: { role: 'user', content: text },
});
const say = (uuid: string, parent: string, api: string, content: unknown[]) => ({
  ...base(uuid, parent),
  type: 'assistant',
  message: { id: api, role: 'assistant', model: 'claude-opus-5-5', content },
});
const text = (uuid: string, parent: string, api: string, t: string) =>
  say(uuid, parent, api, [{ type: 'text', text: t }]);
const call = (uuid: string, parent: string, api: string, id: string) =>
  say(uuid, parent, api, [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.ts' } }]);
const result = (uuid: string, parent: string, source: string, id: string) => ({
  ...base(uuid, parent),
  type: 'user',
  sourceToolAssistantUUID: source,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const system = (
  uuid: string,
  parent: string | null,
  subtype: string,
  extra: Record<string, unknown> = {},
) => ({
  ...base(uuid, parent),
  type: 'system',
  subtype,
  ...extra,
});
const attachment = (uuid: string, parent: string, a: Record<string, unknown>) => ({
  ...base(uuid, parent),
  type: 'attachment',
  attachment: a,
});

/** A session with a rewind, parallel tool calls, a compaction and a queued prompt. */
function session() {
  seq = 0;
  return [
    { type: 'permission-mode', permissionMode: 'default', sessionId: SID },
    prompt('u1', null, 'Start'),
    text('a1', 'u1', 'm1', 'Started.'),
    system('s1', 'a1', 'turn_duration', { durationMs: 10 }),
    prompt('u2', 's1', 'Second'),
    text('a2', 'u2', 'm2', 'The old answer'),
    // Esc Esc: rewound to s1 and asked again.
    prompt('u2b', 's1', 'Second, differently'),
    call('c1', 'u2b', 'm3', 't1'),
    call('c2', 'c1', 'm3', 't2'),
    result('r1', 'c1', 'c1', 't1'),
    attachment('h1', 'r1', { type: 'hook_success', hookName: 'x' }),
    result('r2', 'c2', 'c2', 't2'),
    text('a4', 'r2', 'm4', 'Both read.'),
    {
      ...system('cb', null, 'compact_boundary', {
        logicalParentUuid: 'a4',
        compactMetadata: { trigger: 'auto' },
      }),
    },
    {
      ...prompt('cs', 'cb', 'Summary of what came before'),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    },
    attachment('q1', 'cs', {
      type: 'queued_command',
      prompt: 'Also this',
      source_uuid: 'qsrc',
      origin: { kind: 'human' },
    }),
    text('a5', 'q1', 'm5', 'After compaction.'),
    { ...text('side1', 'a5', 'm6', 'A subagent line'), isSidechain: true },
    { type: 'last-prompt', leafUuid: 'a5', sessionId: SID },
  ];
}

const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-transcript-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSession(rows: unknown[], raw = '') {
  const folder = join(dir, 'C--Code-app');
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${SID}.jsonl`);
  await writeFile(path, jsonl(rows) + raw);
  return path;
}

describe('the transcript reader', () => {
  it('finds the file by session id among the project folders', async () => {
    const path = await writeSession(session());
    await mkdir(join(dir, 'other'), { recursive: true });
    expect(await findTranscript(dir, SID)).toBe(path);
    expect(await findTranscript(dir, 'not-there-0000')).toBeNull();
    expect(await findTranscript(dir, '../escape')).toBeNull();
  });

  it('reads every branch and everything before a compaction, active path last', async () => {
    const r = await readTranscript(await writeSession(session()), SID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.chains.map((c) => c.map((e) => e.uuid));
    // The rewound branch, then the active path.
    expect(ids[0]).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(ids[1]).toEqual(['u1', 'a1', 'u2b', 'c1', 'r1', 'c2', 'r2', 'a4', 'cs', 'qsrc', 'a5']);
    expect(r.stats).toMatchObject({ compactions: 1, branches: 1, folded: 1, unknown: 0, partialTail: false });
    // In the SDK's own shape, so the mapping treats it alike.
    const active = r.chains[1] ?? [];
    expect(active.find((e) => e.uuid === 'cs')).toMatchObject({ type: 'user', isCompactSummary: true });
    expect(active.find((e) => e.uuid === 'qsrc')).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'Also this' },
      origin: { kind: 'human' },
    });
    expect(ids.flat()).not.toContain('side1');
    expect(active.every((e) => e.session_id === SID && e.parent_tool_use_id === null)).toBe(true);
  });

  it('leaves a half-written last line for next time', async () => {
    const r = await readTranscript(await writeSession(session(), '{"type":"user","uuid":"half'), SID);
    expect(r.ok && r.stats.partialTail).toBe(true);
    expect(r.ok && r.stats.unknown).toBe(0);
  });

  it('keeps a line that is not JSON, and gives up when there are too many', async () => {
    const rows = session();
    const few = await readTranscript(
      await writeSession([...rows, ...Array(200).fill(rows[1])], 'not json\n'),
      SID,
    );
    expect(few.ok).toBe(true);
    expect(few.ok && few.stats).toMatchObject({ unknown: 1, unreadable: 1 });
    // Kept, raw, after the entry written before it.
    expect(few.ok && few.chains.at(-1)?.find((e) => e.type === 'unknown')).toMatchObject({
      type: 'unknown',
      unknown: { type: 'not_json', raw: 'not json' },
    });
    const many = await readTranscript(await writeSession(rows, 'not json\n'.repeat(10)), SID);
    expect(many.ok).toBe(false);
    expect(!many.ok && many.reason).toMatch(/too many/);
    expect(MAX_UNKNOWN_SHARE).toBeLessThan(0.05);
  });

  it('counts entry kinds it does not know as unknown, but reads around them', () => {
    const { entries, unknown } = parseEntries([
      JSON.stringify({ type: 'brand-new-kind', uuid: 'x', parentUuid: null }),
    ]);
    expect(unknown).toBe(1);
    expect(entries).toHaveLength(1);
  });

  it('keeps every line it does not know, raw, where it was written', async () => {
    seq = 0;
    const tagged = { ...base('n1', 'a1'), type: 'tool-progress', detail: { step: 2 } };
    const rows = [
      prompt('u1', null, 'Start'),
      text('a1', 'u1', 'm1', 'Started.'),
      // A new kind of entry in the middle of the conversation: the next prompt hangs off it.
      tagged,
      prompt('u2', 'n1', 'Go on'),
      // A new kind with no uuid of its own, after the prompt.
      { type: 'session-ledger', sessionId: SID, total: 3 },
      text('a2', 'u2', 'm2', 'Done.'),
    ];
    const lines = rows.map((r) => JSON.stringify(r));
    const r = await readTranscript(await writeSession(rows), SID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats).toMatchObject({ unknown: 2, unreadable: 0 });
    const active = r.chains.at(-1) ?? [];
    expect(active.map((e) => e.type)).toEqual([
      'user',
      'assistant',
      'unknown',
      'user',
      'unknown',
      'assistant',
    ]);
    const kept = active.filter((e) => e.type === 'unknown');
    expect(kept.map((e) => e.unknown?.type)).toEqual(['tool-progress', 'session-ledger']);
    // Exactly the line as written, so a later version can read it.
    expect(kept.map((e) => e.unknown?.raw)).toEqual([lines[2], lines[4]]);
    // A line with no uuid gets the same id on every read.
    const again = await readTranscript(r.path, SID);
    expect(
      again.ok &&
        again.chains
          .at(-1)
          ?.filter((e) => e.type === 'unknown')
          .map((e) => e.uuid),
    ).toEqual(kept.map((e) => e.uuid));
  });

  it('does not give up on a file full of entry kinds it does not know', async () => {
    seq = 0;
    const rows = [
      prompt('u1', null, 'Start'),
      ...Array.from({ length: 20 }, (_, i) => ({ type: 'heartbeat', n: i, sessionId: SID })),
      text('a1', 'u1', 'm1', 'Started.'),
    ];
    const r = await readTranscript(await writeSession(rows), SID);
    expect(r.ok).toBe(true);
    expect(r.ok && r.stats.unknown).toBe(20);
    expect(r.ok && r.chains.at(-1)?.filter((e) => e.type === 'unknown')).toHaveLength(20);
  });

  it('checks it holds what the SDK returns', () => {
    seq = 0;
    const { chains } = buildChains(parseEntries(session().map((r) => JSON.stringify(r))).entries, SID);
    const sdk = chains[1]?.slice(-3) ?? [];
    expect(coversSdkChain(chains, sdk)).toBe(true);
    const strange = Array.from({ length: 5 }, (_, i) => ({ ...(sdk[0] as (typeof sdk)[0]), uuid: `x${i}` }));
    expect(coversSdkChain(chains, [...sdk, ...strange])).toBe(false);
  });
});

describe('a thread with the full history', () => {
  let w: FakeWorld;
  let launcher: ReturnType<typeof fakeLauncher>;
  let bridge: BridgeClient;
  let threads: MemoryThreadRepo;
  let store: MemoryClaudeCodeStore;
  let svc: ClaudeCodeService;
  const bus: EventBus = { publish: async () => undefined, subscribe: () => () => undefined };

  beforeEach(() => {
    w = world();
    launcher = fakeLauncher(w);
    bridge = new BridgeClient({ launch: launcher, idleMs: 60_000 });
    threads = new MemoryThreadRepo();
    store = new MemoryClaudeCodeStore(threads, 'win32');
    svc = new ClaudeCodeService({
      workspaceId: 'wsp_1',
      settings: new MemorySettings(),
      bus,
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
  });

  /** What the SDK gives: the current chain from the compaction on. */
  const sdkChain = async () => {
    const r = await readTranscript(await writeSession(session()), SID);
    return r.ok ? (r.chains[1] ?? []).slice(-3) : [];
  };

  it('brings in every branch and what came before the compaction, head on the latest', async () => {
    w.sessions.set(SID, { info: info(SID, { cwd: CWD }), chain: await sdkChain() });
    const r = await svc.importSessions({ session_ids: [SID] });
    const id = r.imported[0]?.thread_id as string;
    const msgs = await threads.messages(id);
    const texts = msgs.map((m) => textOf(m.parts));
    expect(texts).toEqual(
      expect.arrayContaining([
        'Start',
        'Started.',
        'Second',
        'The old answer',
        'Second, differently',
        'Both read.',
        'Also this',
        'After compaction.',
      ]),
    );
    const started = msgs.find((m) => textOf(m.parts) === 'Started.');
    // The rewind is a branch: two prompts hang off the first answer.
    expect(
      msgs
        .filter((m) => m.parent_id === started?.id)
        .map((m) => textOf(m.parts))
        .sort(),
    ).toEqual(['Second', 'Second, differently']);
    // The compaction divider sits after "Both read.", and the summary after it.
    const divider = msgs.find(
      (m) => (m.provenance?.claude_code as { kind?: string })?.kind === 'compact_boundary',
    );
    expect(textOf(msgs.find((m) => m.id === divider?.parent_id)?.parts ?? [])).toContain('Both read.');
    const head = (await threads.getThread(id))?.active_head_id;
    expect(textOf(msgs.find((m) => m.id === head)?.parts ?? [])).toBe('After compaction.');
    // The parallel tool calls and both results are in one answer.
    const tools = msgs.find((m) => textOf(m.parts).includes('Both read.'));
    expect(tools?.parts.filter((p) => p.type === 'tool_result')).toHaveLength(2);
    // Syncing again adds nothing.
    expect((await svc.syncThread(id)).added).toBe(0);
  });

  it('rebuilds a thread imported by the older mapping with its full history', async () => {
    const chain = await sdkChain();
    w.sessions.set(SID, { info: info(SID, { cwd: CWD }), chain });
    // As phase 1.1 left it: only the chain the SDK gave, built by mapping version 2.
    const r = await svc.importSessions({ session_ids: [SID] });
    const id = r.imported[0]?.thread_id as string;
    const keep = new Set(chain.map((e) => e.uuid));
    const msgs = await threads.messages(id);
    const drop = msgs.filter(
      (m) => !(m.provenance?.claude_code as { uuids?: string[] })?.uuids?.some((u) => keep.has(u)),
    );
    await threads.discardMessages(drop.map((m) => m.id));
    const b = (await store.sessions('wsp_1'))[0];
    await store.putSession('wsp_1', { ...(b as NonNullable<typeof b>), mapper_version: 2 });
    expect((await threads.messages(id)).length).toBeLessThan(msgs.length);

    svc.kick();
    await svc.idle();
    const after = await threads.messages(id);
    expect(after.length).toBe(msgs.length);
    expect(after.map((m) => textOf(m.parts))).toContain('The old answer');
    expect((await store.sessions('wsp_1'))[0]?.mapper_version).toBe(MAPPER_VERSION);
  });

  it('shows a quiet marker for entries it cannot show, keeps them raw, and warns once per version', async () => {
    seq = 0;
    const rows = [
      prompt('u1', null, 'Start'),
      say('a1', 'u1', 'm1', [
        { type: 'text', text: 'Started.' },
        { type: 'hologram', frames: 3 },
      ]),
      prompt('u2', 'a1', 'Go on'),
      { ...base('n1', 'u2'), type: 'tool-progress', detail: 'secret words never logged' },
      { ...base('n2', 'n1'), type: 'tool-progress', detail: 'more' },
      text('a2', 'n2', 'm2', 'Done.'),
    ];
    const path = await writeSession(rows);
    const read = await readTranscript(path, SID);
    const sdk = read.ok ? (read.chains.at(-1) ?? []).filter((e) => e.type !== 'unknown') : [];
    w.sessions.set(SID, { info: info(SID, { cwd: CWD }), chain: sdk });
    const logged: Record<string, unknown>[] = [];
    setLogTap((l) => logged.push(l));
    try {
      const r = await svc.importSessions({ session_ids: [SID] });
      const id = r.imported[0]?.thread_id as string;
      const msgs = await threads.messages(id);
      // The answer says it holds one entry it cannot show (the block of a new kind).
      const answer = msgs.find((m) => textOf(m.parts) === 'Started.');
      expect(answer?.provenance?.claude_code).toMatchObject({ unknown: { count: 1, types: ['hologram'] } });
      // The two new entries between the turns are one quiet marker.
      const marker = msgs.filter((m) => (m.provenance?.claude_code as { kind?: string })?.kind === 'unknown');
      expect(marker).toHaveLength(1);
      const goOn = msgs.find((m) => textOf(m.parts) === 'Go on');
      expect(marker[0]).toMatchObject({ role: 'system', parent_id: goOn?.id });
      expect(textOf(marker[0]?.parts ?? [])).toBe("2 entries this version of NVX Ancile can't show yet");
      expect(msgs.find((m) => textOf(m.parts) === 'Done.')?.parent_id).toBe(marker[0]?.id);
      // Kept raw, with the version that wrote them.
      const kept = await store.unknownFor(id);
      expect(kept.map((k) => k.uuid).sort()).toEqual(['a1', 'n1', 'n2']);
      expect(kept.find((k) => k.uuid === 'n1')?.raw).toBe(JSON.stringify(rows[3]));
      expect([...store.unknown.values()][0]?.cli_version).toBe('2.1.286');
      // One warning for this Claude Code version: counts and kinds, never what they say.
      const warns = logged.filter((l) => String(l.msg).includes('cannot show yet'));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({ level: 'warn', cli_version: '2.1.286', entries: 3 });
      expect(JSON.stringify(warns)).not.toContain('secret words');
      // Syncing again adds nothing, and does not warn again.
      expect((await svc.syncThread(id)).added).toBe(0);
      await svc.keepUnknown(id, 'another-session-0001', [{ uuid: 'z', type: 'tool-progress', raw: '{}' }]);
      expect(
        logged.filter((l) => l.level === 'warn' && String(l.msg).includes('cannot show yet')),
      ).toHaveLength(1);
    } finally {
      setLogTap(null);
    }
  });

  it('falls back to the SDK chain when the file is missing', async () => {
    const chain = await sdkChain();
    await rm(join(dir, 'C--Code-app'), { recursive: true, force: true });
    w.sessions.set(SID, { info: info(SID, { cwd: CWD }), chain });
    const h = await svc.history(SID);
    expect(h.via).toBe('sdk');
    expect(h.chains).toEqual([chain]);
  });
});
