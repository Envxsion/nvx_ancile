/**
 * Sessions, import, sync and auto-import, against a fake bridge (an
 * in-process WebSocket server) and the memory stores. No Claude Code,
 * no Agent SDK, no network.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalEvent, Part } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { BridgeClient } from '../../src/claudecode/bridge';
import { ClaudeCli } from '../../src/claudecode/cli';
import { ClaudeInstaller } from '../../src/claudecode/install';
import { MAPPER_VERSION } from '../../src/claudecode/map';
import { claudeCodeRoutes } from '../../src/claudecode/routes';
import {
  ClaudeCodeService,
  expandHome,
  importOrder,
  NOTEBOOK_HUES,
  notebookNames,
  pickHue,
} from '../../src/claudecode/service';
import { cwdWithin, MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { ClaudeVerifier } from '../../src/claudecode/verify';
import type { EventBus, GlobalEventInput } from '../../src/events/bus';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { errorHandler } from '../../src/obs/errors';
import { MemorySettings, SETTING } from '../../src/settings';
import { MemoryThreadRepo } from '../../src/threads/repo';
import { assistant, type FakeWorld, fakeLauncher, info, toolResult, user, world } from './fake-bridge';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

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
let notebooks: MemoryNotebookRepo;
let settings: MemorySettings;
let bus: Bus;
let svc: ClaudeCodeService;
let dir: string;
let now = NOW;

const make = (extra: Partial<ConstructorParameters<typeof ClaudeCodeService>[0]> = {}) =>
  new ClaudeCodeService({
    workspaceId: WS,
    settings,
    bus,
    threads,
    notebooks,
    store: new MemoryClaudeCodeStore(threads, 'win32'),
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
    now: () => now,
    pathExists: (p) => !p.includes('gone'),
    auto: { startDelayMs: 0, debounceMs: 50, pauseMs: 0 },
    ...extra,
  });

beforeEach(async () => {
  now = NOW;
  dir = await mkdtemp(join(tmpdir(), 'ancile-cc-'));
  w = world();
  launcher = fakeLauncher(w);
  bridge = new BridgeClient({ launch: launcher, idleMs: 60_000 });
  threads = new MemoryThreadRepo();
  notebooks = new MemoryNotebookRepo();
  settings = new MemorySettings();
  bus = new Bus();
  svc = make();
});

afterEach(async () => {
  svc.stop();
  bridge.stop();
  await launcher.close();
  await rm(dir, { recursive: true, force: true });
});

/** A session with a prompt, a tool call and its result, and an answer. */
function basicChain() {
  return [
    user('u1', 'Fix the login bug'),
    assistant('a1', [{ type: 'thinking', thinking: 'Look at auth.ts', signature: 'sig1' }], {
      id: 'm1',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    }),
    assistant('a2', [{ type: 'tool_use', id: 'call1', name: 'Read', input: { file_path: 'auth.ts' } }], {
      id: 'm1',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    }),
    toolResult('r1', 'call1', 'export const x = 1;'),
    assistant('a3', [{ type: 'text', text: 'Fixed.' }], {
      id: 'm2',
      usage: { input_tokens: 3, output_tokens: 7 },
    }),
  ];
}

/** basicChain with uuids of its own: separate sessions never share entries (a fork does). */
const chainOf = (p: string) => basicChain().map((e) => ({ ...e, uuid: `${p}-${e.uuid}` }));

const textOf = (parts: Part[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

describe('listing sessions', () => {
  it('lists newest first with bindings, filters, and live and missing folders', async () => {
    w.sessions.set('s1', {
      info: info('s1', { cwd: 'C:\\Code\\cyberfolio', customTitle: 'nvx_folio', lastModified: NOW - 10_000 }),
      chain: [],
    });
    w.sessions.set('s2', {
      info: info('s2', { cwd: 'C:\\Old\\gone', summary: 'Old work', lastModified: NOW - 3_600_000 }),
      chain: [],
    });
    const page = await svc.listSessions();
    expect(page.items.map((s) => s.session_id)).toEqual(['s1', 's2']);
    expect(page.items[0]).toMatchObject({
      title: 'nvx_folio',
      project: 'cyberfolio',
      active_elsewhere: true,
      cwd_missing: false,
      thread_id: null,
    });
    expect(page.items[1]).toMatchObject({ cwd_missing: true, active_elsewhere: false });
    expect((await svc.listSessions({ q: 'old' })).items.map((s) => s.session_id)).toEqual(['s2']);
    // Windows folders match without case or slash direction.
    expect((await svc.listSessions({ cwd: 'c:/code/CYBERFOLIO/' })).items.map((s) => s.session_id)).toEqual([
      's1',
    ]);
    const first = await svc.listSessions({ limit: 1 });
    expect(first.next_cursor).toBe('1');
    expect((await svc.listSessions({ limit: 1, cursor: first.next_cursor })).items[0]?.session_id).toBe('s2');
  });

  it('marks a session a terminal has open right now, however long it has been idle', async () => {
    svc.stop();
    svc = make({
      holders: {
        holder: async (q) => (q.sessionId === 's2' ? { pid: 4242, how: 'session' as const } : null),
      },
    });
    w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\a', lastModified: NOW - 10_000 }), chain: [] });
    w.sessions.set('s2', {
      info: info('s2', { cwd: 'C:\\Code\\b', lastModified: NOW - 3_600_000 }),
      chain: [],
    });
    const page = await svc.listSessions();
    expect(page.items.map((s) => [s.session_id, s.open_in_terminal, s.active_elsewhere])).toEqual([
      ['s1', false, true],
      ['s2', true, false],
    ]);
  });

  it('says clearly when the SDK cannot be loaded', async () => {
    w.sdkError = 'registry.npmjs.org unreachable';
    await expect(svc.listSessions()).rejects.toMatchObject({ code: 'claude_code.sdk_unavailable' });
  });
});

describe('importing', () => {
  it('makes a notebook named after the folder, a bound thread, and the message tree', async () => {
    w.sessions.set('s1', {
      info: info('s1', { cwd: 'C:\\Code\\cyberfolio', customTitle: 'nvx_folio' }),
      chain: basicChain(),
    });
    const r = await svc.importSessions({ session_ids: ['s1'] });
    expect(r.failed).toEqual([]);
    const imp = r.imported[0];
    expect(imp?.added).toBe(2);
    const nb = await notebooks.get(imp?.notebook_id as string);
    expect(nb?.title).toBe('cyberfolio');
    expect(await svc.projects()).toEqual([{ cwd: 'C:\\Code\\cyberfolio', notebook_id: nb?.id }]);

    const thread = await threads.getThread(imp?.thread_id as string);
    expect(thread?.title).toBe('nvx_folio');
    expect(thread?.settings.claude_code).toMatchObject({
      session_id: 's1',
      cwd: 'C:\\Code\\cyberfolio',
      last_uuid: 'a3',
    });
    const msgs = await threads.messages(thread?.id as string);
    const [u, a] = msgs;
    expect(u).toMatchObject({
      role: 'user',
      parent_id: null,
      parts: [{ type: 'text', text: 'Fix the login bug' }],
    });
    expect(a?.parent_id).toBe(u?.id);
    expect(a?.role).toBe('assistant');
    expect(a?.model_id).toBe('claude-code/claude-opus-5-5');
    expect(a?.parts.map((p) => p.type)).toEqual(['reasoning', 'tool_call', 'tool_result', 'text']);
    expect(a?.parts[0]).toMatchObject({ provider_meta: { anthropic: { signature: 'sig1' } } });
    expect(a?.parts[1]).toMatchObject({ call_id: 'call1', tool: 'Read', args: { file_path: 'auth.ts' } });
    expect(a?.parts[2]).toMatchObject({ call_id: 'call1', ok: true, result: 'export const x = 1;' });
    // One API response spans entries a1 and a2: its usage counts once.
    expect(a?.usage).toEqual({ input_tokens: 13, output_tokens: 12, cached_tokens: 100, cost_usd: 0 });
    expect(a?.provenance).toMatchObject({
      claude_code: { session_id: 's1', uuid: 'a3', uuids: ['a1', 'a2', 'r1', 'a3'] },
    });
    expect(thread?.active_head_id).toBe(a?.id);
    expect(bus.events).toContainEqual({ type: 'claude_code.changed', what: 'thread', thread_id: thread?.id });
  });

  it('is idempotent: importing again adds nothing', async () => {
    w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\app' }), chain: basicChain() });
    const a = await svc.importSessions({ session_ids: ['s1'] });
    const b = await svc.importSessions({ session_ids: ['s1'] });
    expect(b.imported[0]).toMatchObject({ thread_id: a.imported[0]?.thread_id, added: 0 });
    expect((await threads.messages(a.imported[0]?.thread_id as string)).length).toBe(2);
  });

  it('puts sessions in a chosen notebook, and reports unknown sessions as failed', async () => {
    const nb = await notebooks.create({ id: 'nbk_1', workspace_id: WS, title: 'Mine' });
    w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\app' }), chain: basicChain() });
    const r = await svc.importSessions({ session_ids: ['s1', 'nope'], notebook_id: nb.id });
    expect(r.imported[0]?.notebook_id).toBe('nbk_1');
    expect(r.failed).toEqual([
      {
        session_id: 'nope',
        title: 'That Claude Code session is not on this computer',
        hint: expect.any(String),
      },
    ]);
  });

  it('brings in a session whose folder no longer exists', async () => {
    w.sessions.set('s1', { info: info('s1', { cwd: 'D:\\gone\\proj' }), chain: basicChain() });
    const r = await svc.importSessions({ session_ids: ['s1'] });
    expect(r.imported).toHaveLength(1);
    expect((await svc.listSessions()).items[0]).toMatchObject({
      cwd_missing: true,
      thread_id: r.imported[0]?.thread_id,
    });
  });

  it('cuts very large tool results, with a note', async () => {
    const big = 'x'.repeat(200_000);
    w.sessions.set('s1', {
      info: info('s1'),
      chain: [
        user('u1', 'go'),
        assistant('a1', [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }]),
        toolResult('r1', 'c', big, true),
      ],
    });
    const r = await svc.importSessions({ session_ids: ['s1'] });
    const a = (await threads.messages(r.imported[0]?.thread_id as string))[1];
    const res = a?.parts.find((p) => p.type === 'tool_result');
    expect(res).toMatchObject({ ok: false });
    expect((res as { result: string }).result.length).toBeLessThan(70_000);
    expect((res as { result: string }).result).toMatch(/more characters not brought in/);
  });

  it('marks where Claude Code compacted the conversation', async () => {
    w.sessions.set('s1', {
      info: info('s1'),
      chain: [
        ...basicChain(),
        user('c1', 'Summary of the work so far', { isCompactSummary: true }),
        user('u2', 'Carry on'),
      ],
    });
    const r = await svc.importSessions({ session_ids: ['s1'] });
    const msgs = await threads.messages(r.imported[0]?.thread_id as string);
    const kindOf = (k: string) =>
      msgs.find((m) => (m.provenance.claude_code as { kind?: string })?.kind === k);
    const marker = kindOf('compact_boundary');
    const summary = kindOf('compact_summary');
    expect(marker).toMatchObject({ role: 'system', parts: [{ type: 'text', text: '' }] });
    expect(summary).toMatchObject({
      role: 'system',
      parent_id: marker?.id,
      parts: [{ type: 'text', text: 'Summary of the work so far' }],
    });
    expect(msgs.at(-1)?.parent_id).toBe(summary?.id);
  });

  it('collapses a subagent onto the call that started it', async () => {
    const chain = [
      user('u1', 'Research it'),
      assistant('a1', [
        {
          type: 'tool_use',
          id: 'task1',
          name: 'Task',
          input: { description: 'Find the docs', prompt: 'Look' },
        },
      ]),
      toolResult('r1', 'task1', 'Found them'),
    ];
    const sub = [
      { ...user('su1', 'Look'), parent_tool_use_id: 'task1' },
      { ...assistant('sa1', [{ type: 'text', text: 'Reading docs' }]), parent_tool_use_id: 'task1' },
    ];
    w.sessions.set('s1', { info: info('s1'), chain, subagents: { ag1: sub } });
    const r = await svc.importSessions({ session_ids: ['s1'] });
    const host = (await threads.messages(r.imported[0]?.thread_id as string))[1];
    const cc = host?.provenance.claude_code as {
      subagent: { call_id: string; description: string; messages: { role: string }[] }[];
      uuids: string[];
    };
    expect(cc.uuids).toEqual(['a1', 'r1']);
    expect(cc.subagent).toHaveLength(1);
    expect(cc.subagent[0]).toMatchObject({ call_id: 'task1', description: 'Find the docs' });
    expect(cc.subagent[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Synced again: nothing changes.
    expect((await svc.importSessions({ session_ids: ['s1'] })).imported[0]?.added).toBe(0);
  });
});

describe('syncing', () => {
  it('adds what was said in the terminal after the import', async () => {
    const chain = basicChain();
    w.sessions.set('s1', { info: info('s1'), chain });
    const r = await svc.importSessions({ session_ids: ['s1'] });
    const id = r.imported[0]?.thread_id as string;
    chain.push(user('u2', 'Now add a test'), assistant('a4', [{ type: 'text', text: 'Added.' }]));
    const s = await svc.syncThread(id);
    expect(s).toMatchObject({ added: 2, gone: false });
    const msgs = await threads.messages(id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[2]?.parent_id).toBe(msgs[1]?.id);
    expect((await threads.getThread(id))?.active_head_id).toBe(msgs[3]?.id);
  });

  it('carries on an assistant turn that was still going at the last sync', async () => {
    const chain = [
      user('u1', 'go'),
      assistant('a1', [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }]),
    ];
    w.sessions.set('s1', { info: info('s1'), chain });
    const id = (await svc.importSessions({ session_ids: ['s1'] })).imported[0]?.thread_id as string;
    chain.push(toolResult('r1', 'c', 'ok'), assistant('a2', [{ type: 'text', text: 'Done' }]));
    await svc.syncThread(id);
    const msgs = await threads.messages(id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.parts.map((p) => p.type)).toEqual(['tool_call', 'tool_result', 'text']);
  });

  it('turns a rewind in Claude Code into a branch', async () => {
    const base = basicChain();
    w.sessions.set('s1', {
      info: info('s1'),
      chain: [...base, user('u2', 'First idea'), assistant('a4', [{ type: 'text', text: 'One' }])],
    });
    const id = (await svc.importSessions({ session_ids: ['s1'] })).imported[0]?.thread_id as string;
    // The person rewound to before u2 and asked something else.
    w.sessions.set('s1', {
      info: info('s1'),
      chain: [...base, user('u3', 'Second idea'), assistant('a5', [{ type: 'text', text: 'Two' }])],
    });
    await svc.syncThread(id);
    const msgs = await threads.messages(id);
    const parents = new Set(msgs.map((m) => m.parent_id));
    const leaves = msgs.filter((m) => !parents.has(m.id));
    expect(leaves).toHaveLength(2);
    const u2 = msgs.find((m) => textOf(m.parts) === 'First idea');
    const u3 = msgs.find((m) => textOf(m.parts) === 'Second idea');
    expect(u2?.parent_id).toBe(u3?.parent_id);
    expect((await threads.getThread(id))?.active_head_id).toBe(
      msgs.find((m) => textOf(m.parts) === 'Two')?.id,
    );
  });

  it('keeps the thread when the session file is deleted', async () => {
    w.sessions.set('s1', { info: info('s1'), chain: basicChain() });
    const id = (await svc.importSessions({ session_ids: ['s1'] })).imported[0]?.thread_id as string;
    w.sessions.delete('s1');
    expect(await svc.syncThread(id)).toMatchObject({ gone: true, added: 0 });
    expect(await threads.getThread(id)).toBeDefined();
  });

  it('refuses a thread that did not come from Claude Code', async () => {
    const t = await threads.createThread({ id: 'thr_x', workspace_id: WS });
    await expect(svc.syncThread(t.id)).rejects.toMatchObject({ code: 'claude_code.not_bound' });
  });
});

describe('names', () => {
  it('prefers the custom title, then the summary, then the first prompt', async () => {
    w.sessions.set('a', {
      info: info('a', { customTitle: 'nvx_folio', summary: 'S', firstPrompt: 'P' }),
      chain: chainOf('a'),
    });
    w.sessions.set('b', { info: info('b', { summary: 'A summary', firstPrompt: 'P' }), chain: chainOf('b') });
    w.sessions.set('c', {
      info: info('c', { summary: '', firstPrompt: 'The first prompt\nmore' }),
      chain: chainOf('c'),
    });
    const r = await svc.importSessions({ session_ids: ['a', 'b', 'c'] });
    const titles = await Promise.all(
      r.imported.map(async (i) => (await threads.getThread(i.thread_id))?.title),
    );
    expect(titles).toEqual(['nvx_folio', 'A summary', 'The first prompt']);
  });

  it('follows a rename in Claude Code, unless the thread was renamed in Ancile', async () => {
    const s = { info: info('s1', { customTitle: 'old name' }), chain: basicChain() };
    w.sessions.set('s1', s);
    const id = (await svc.importSessions({ session_ids: ['s1'] })).imported[0]?.thread_id as string;
    s.info = { ...s.info, customTitle: 'new name', lastModified: s.info.lastModified + 1 };
    await svc.syncThread(id);
    expect((await threads.getThread(id))?.title).toBe('new name');
    await threads.patchThread(id, { title: 'My own title', title_source: 'user' });
    s.info = { ...s.info, customTitle: 'newer name', lastModified: s.info.lastModified + 1 };
    await svc.syncThread(id);
    expect((await threads.getThread(id))?.title).toBe('My own title');
  });
});

describe('folder notebooks', () => {
  it('names notebooks after the folder, adopting an unbound one and telling same-named folders apart', async () => {
    const existing = await notebooks.create({ id: 'nbk_existing', workspace_id: WS, title: 'nvx_ancile' });
    w.sessions.set('a', {
      info: info('a', { cwd: 'C:\\Users\\p\\GitHub\\nvx_ancile' }),
      chain: chainOf('a'),
    });
    w.sessions.set('b', {
      info: info('b', { cwd: 'C:\\Users\\p\\Desktop\\nvx_ancile' }),
      chain: chainOf('b'),
    });
    w.sessions.set('c', { info: info('c', { cwd: 'c:/users/p/github/NVX_ANCILE' }), chain: chainOf('c') });
    const r = await svc.importSessions({ session_ids: ['a', 'b', 'c'] });
    const [a, b, c] = r.imported;
    expect(a?.notebook_id).toBe(existing.id);
    expect((await notebooks.get(b?.notebook_id as string))?.title).toBe('nvx_ancile (Desktop)');
    expect(c?.notebook_id).toBe(existing.id);
    expect(notebookNames('/home/p/work/app')).toEqual(
      expect.arrayContaining(['app', 'app (work)', 'app (p/work)', 'app 2']),
    );
  });
});

describe('auto-import', () => {
  it('brings new sessions in when the projects folder changes, with progress events', async () => {
    await mkdir(join(dir, 'proj'), { recursive: true });
    svc.startAuto();
    await new Promise((r) => setTimeout(r, 100));
    await svc.idle();
    expect((await threads.listThreads(WS)).length).toBe(0);
    w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\app' }), chain: basicChain() });
    await writeFile(join(dir, 'proj', 's1.jsonl'), '{}\n');
    const until = Date.now() + 5000;
    while ((await threads.listThreads(WS)).length === 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 50));
    await svc.idle();
    const list = await threads.listThreads(WS);
    expect(list).toHaveLength(1);
    const details = bus.events
      .filter((e) => e.type === 'claude_code.changed' && e.what === 'sessions')
      .map((e) => (e as { detail?: string }).detail);
    expect(details).toContain('importing:0/1');
    expect(details).toContain('imported:1');
  });

  it('syncs a bound thread when its transcript changes, and does nothing when Auto-import is off', async () => {
    const s = { info: info('s1'), chain: basicChain() };
    w.sessions.set('s1', s);
    const id = (await svc.importSessions({ session_ids: ['s1'] })).imported[0]?.thread_id as string;
    s.chain.push(user('u9', 'more'));
    s.info = { ...s.info, lastModified: s.info.lastModified + 5 };
    await settings.set(SETTING.claudeCode, { auto_import: false });
    svc.kick();
    await svc.idle();
    expect(await threads.messages(id)).toHaveLength(2);
    await svc.patchSettings({ auto_import: true });
    await svc.idle();
    expect(await threads.messages(id)).toHaveLength(3);
  });
});

describe('routes', () => {
  it('answers status, sessions and import over HTTP', async () => {
    w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\app' }), chain: basicChain() });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', claudeCodeRoutes({ service: () => svc }));
    const status = (await (await app.request('/claude-code/status')).json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      installed: true,
      version: '2.1.286',
      signed_in: true,
      settings: { auto_import: true },
    });
    expect(status.verification).toBeDefined();
    const list = (await (await app.request('/claude-code/sessions?q=session')).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);
    const res = await app.request('/claude-code/sessions/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_ids: ['s1'] }),
    });
    expect(res.status).toBe(200);
    const bad = await app.request('/claude-code/sessions/import', {
      method: 'POST',
      body: JSON.stringify({ session_ids: [] }),
    });
    expect(bad.status).toBe(400);
    const patched = await (
      await app.request('/claude-code/settings', {
        method: 'PATCH',
        body: JSON.stringify({ claude_telemetry: false }),
      })
    ).json();
    expect(patched).toEqual({
      auto_install: true,
      auto_import: true,
      exclude_folders: ['~/.claude-mem', '<temp>'],
      claude_telemetry: false,
    });
    expect(await svc.cliEnv()).toEqual({ DISABLE_TELEMETRY: '1' });
  });
});

describe('the bridge connection', () => {
  it('starts the bridge once, on first use', async () => {
    expect(w.launches).toBe(0);
    await svc.listSessions();
    await svc.listSessions({ q: 'x' });
    await bridge.sessionMessages('none');
    expect(w.launches).toBe(1);
    expect(w.requests[0]).toBe('hello');
  });

  it('restarts after the bridge stops', async () => {
    await bridge.listSessions();
    bridge.stop();
    await bridge.listSessions();
    expect(w.launches).toBe(2);
  });
});

const HOME = 'C:\\Users\\p';
const OBSERVER = 'C:\\Users\\p\\.claude-mem\\observer-sessions';

describe('excluded folders', () => {
  it('matches "~", case and slash direction on Windows, and whole folder names only', () => {
    expect(expandHome('~/.claude-mem', HOME)).toBe('C:\\Users\\p/.claude-mem');
    expect(cwdWithin(OBSERVER, expandHome('~/.claude-mem', HOME), 'win32')).toBe(true);
    // "<temp>": throwaway sessions in the system temp folder.
    expect(expandHome('<temp>', HOME, 'C:\\Temp')).toBe('C:\\Temp');
    expect(cwdWithin('C:\\Temp\\ancile-x', expandHome('<temp>', HOME, 'C:\\Temp'), 'win32')).toBe(true);
    expect(cwdWithin('c:/users/P/.CLAUDE-MEM', 'C:\\Users\\p\\.claude-mem\\', 'win32')).toBe(true);
    expect(cwdWithin('C:\\Users\\p\\.claude-mem-other', 'C:\\Users\\p\\.claude-mem', 'win32')).toBe(false);
    expect(cwdWithin('/home/p/.claude-mem/x', '/home/p/.claude-mem', 'linux')).toBe(true);
    expect(cwdWithin('/home/p/.Claude-mem/x', '/home/p/.claude-mem', 'linux')).toBe(false);
  });

  it('are never listed, auto-imported or brought in by hand', async () => {
    svc = make({ home: HOME });
    w.sessions.set('obs', { info: info('obs', { cwd: OBSERVER }), chain: basicChain() });
    w.sessions.set('mine', { info: info('mine', { cwd: 'C:\\Code\\app' }), chain: basicChain() });
    expect((await svc.listSessions()).items.map((s) => s.session_id)).toEqual(['mine']);
    svc.kick();
    await svc.idle();
    const list = await threads.listThreads(WS);
    expect(list).toHaveLength(1);
    expect(list[0]?.settings.claude_code?.session_id).toBe('mine');
    const r = await svc.importSessions({ session_ids: ['obs'] });
    expect(r.failed).toEqual([
      { session_id: 'obs', title: 'Sessions from that folder are not brought in', hint: expect.any(String) },
    ]);
  });

  it('puts away what was already brought in: archives, never deletes, and keeps what was written in Ancile', async () => {
    const store = new MemoryClaudeCodeStore(threads, 'win32');
    svc = make({ home: HOME, store });
    await svc.patchSettings({ exclude_folders: [] });
    const other = 'C:\\Users\\p\\.claude-mem\\other';
    w.sessions.set('o1', { info: info('o1', { cwd: OBSERVER }), chain: chainOf('o1') });
    w.sessions.set('o2', { info: info('o2', { cwd: OBSERVER }), chain: chainOf('o2') });
    w.sessions.set('k1', { info: info('k1', { cwd: other }), chain: chainOf('k1') });
    w.sessions.set('mine', { info: info('mine', { cwd: 'C:\\Code\\app' }), chain: chainOf('mine') });
    const r = await svc.importSessions({ session_ids: ['o1', 'o2', 'k1', 'mine'] });
    const [o1, o2, k1, mine] = r.imported;
    // Something written in Ancile in k1's thread.
    await threads.insertMessage({
      id: 'msg_mine',
      thread_id: k1?.thread_id as string,
      parent_id: (await threads.getThread(k1?.thread_id as string))?.active_head_id ?? null,
      role: 'user',
      parts: [{ type: 'text', text: 'my own note' }],
      status: 'complete',
      trace_id: '0'.repeat(32),
    });
    bus.events = [];

    await svc.patchSettings({ exclude_folders: ['~/.claude-mem'] });

    for (const id of [o1?.thread_id, o2?.thread_id]) {
      const t = await threads.getThread(id as string);
      expect(t?.archived_at).toBeTruthy();
      expect(await threads.messages(id as string)).toHaveLength(2);
    }
    expect((await threads.getThread(k1?.thread_id as string))?.archived_at).toBeNull();
    expect((await threads.getThread(mine?.thread_id as string))?.archived_at).toBeNull();
    const bound = (await store.sessions(WS)).map((b) => b.session_id).sort();
    expect(bound).toEqual(['k1', 'mine']);
    // The observer notebook (made for the folder, now empty) is archived and unbound; k1's stays.
    expect((await notebooks.get(o1?.notebook_id as string))?.archived_at).toBeTruthy();
    expect((await notebooks.get(k1?.notebook_id as string))?.archived_at).toBeNull();
    expect((await svc.projects()).map((p) => p.cwd).sort()).toEqual(['C:\\Code\\app', other]);
    expect(bus.events).toContainEqual({ type: 'claude_code.changed', what: 'sessions' });
    // Nothing comes back on the next pass.
    svc.kick();
    await svc.idle();
    expect((await store.sessions(WS)).map((b) => b.session_id).sort()).toEqual(['k1', 'mine']);
  });

  it('runs at start, and "Don\'t bring in this folder" adds the folder and tidies up', async () => {
    svc = make({ home: HOME });
    await svc.patchSettings({ exclude_folders: [] });
    w.sessions.set('a', { info: info('a', { cwd: 'C:\\Code\\scratch' }), chain: basicChain() });
    const id = (await svc.importSessions({ session_ids: ['a'] })).imported[0]?.thread_id as string;
    await settings.set(SETTING.claudeCode, { exclude_folders: ['C:\\Code\\scratch'] });
    const fresh = make({
      home: HOME,
      store: (svc as unknown as { deps: { store: MemoryClaudeCodeStore } }).deps.store,
    });
    expect(await fresh.cleanupExcluded()).toEqual({ threads: 1, notebooks: 1 });
    expect((await threads.getThread(id))?.archived_at).toBeTruthy();

    await settings.set(SETTING.claudeCode, {});
    w.sessions.set('b', { info: info('b', { cwd: 'C:\\Code\\toy' }), chain: basicChain() });
    const id2 = (await svc.importSessions({ session_ids: ['b'] })).imported[0]?.thread_id as string;
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', claudeCodeRoutes({ service: () => svc }));
    const res = await app.request('/claude-code/projects/exclude', {
      method: 'POST',
      body: JSON.stringify({ cwd: 'c:/code/TOY' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { exclude_folders: string[] }).exclude_folders).toEqual([
      '~/.claude-mem',
      '<temp>',
      'c:/code/TOY',
    ]);
    expect((await threads.getThread(id2))?.archived_at).toBeTruthy();
    const again = await app.request('/claude-code/projects/exclude', {
      method: 'POST',
      body: JSON.stringify({ cwd: 'C:\\Code\\toy\\' }),
    });
    expect(((await again.json()) as { exclude_folders: string[] }).exclude_folders).toHaveLength(3);
    expect((await app.request('/claude-code/projects/exclude', { method: 'POST', body: '{}' })).status).toBe(
      400,
    );
  });
});

describe('folder notebook colours', () => {
  it('gives each new folder notebook the first hue no live notebook uses', async () => {
    await notebooks.create({ id: 'nbk_u', workspace_id: WS, title: 'Mine', color: 'azure' });
    const gone = await notebooks.create({ id: 'nbk_g', workspace_id: WS, title: 'Old', color: 'coral' });
    await notebooks.patch(gone.id, { archived: true });
    for (const [id, cwd] of [
      ['a', 'C:\\Code\\one'],
      ['b', 'C:\\Code\\two'],
      ['c', 'C:\\Code\\three'],
    ] as const)
      w.sessions.set(id, { info: info(id, { cwd }), chain: chainOf(id) });
    const r = await svc.importSessions({ session_ids: ['a', 'b', 'c'] });
    const books = await Promise.all(r.imported.map((i) => notebooks.get(i.notebook_id as string)));
    expect(books.map((b) => b?.color)).toEqual(['coral', 'jade', 'amber']);
    expect(books.map((b) => b?.icon)).toEqual(['terminal', 'terminal', 'terminal']);
  });

  it('uses the least used hue when all are taken, the same one for the same folder', () => {
    const all = [...NOTEBOOK_HUES];
    const pick = pickHue('c:\\code\\x', all);
    expect(NOTEBOOK_HUES).toContain(pick);
    expect(pickHue('c:\\code\\x', all)).toBe(pick);
    expect(
      pickHue('c:\\code\\x', [...all, 'azure', 'coral', 'jade', 'amber', 'cyan', null, 'not-a-hue']),
    ).toBe('magenta');
  });

  it('colours folder notebooks made before colours, on the next pass', async () => {
    const store = new MemoryClaudeCodeStore(threads, 'win32');
    svc = make({ store });
    const made = await notebooks.create({ id: 'nbk_m', workspace_id: WS, title: 'app' });
    const chosen = await notebooks.create({ id: 'nbk_c', workspace_id: WS, title: 'Chosen' });
    await store.putProject(WS, 'C:\\Code\\app', made.id, true);
    await store.putProject(WS, 'C:\\Code\\other', chosen.id, false);
    svc.kick();
    await svc.idle();
    expect((await notebooks.get(made.id))?.color).toBe('azure');
    expect((await notebooks.get(made.id))?.icon).toBe('terminal');
    expect((await notebooks.get(chosen.id))?.color).toBeNull();
    expect((await notebooks.get(chosen.id))?.icon).toBeNull();
  });

  it('gives a coloured folder notebook without an icon the terminal icon, keeping its colour', async () => {
    const store = new MemoryClaudeCodeStore(threads, 'win32');
    svc = make({ store });
    const made = await notebooks.create({ id: 'nbk_m2', workspace_id: WS, title: 'app', color: 'jade' });
    await store.putProject(WS, 'C:\\Code\\app2', made.id, true);
    svc.kick();
    await svc.idle();
    const nb = await notebooks.get(made.id);
    expect(nb?.color).toBe('jade');
    expect(nb?.icon).toBe('terminal');
  });
});

describe('remapping older imports', () => {
  const COMMAND =
    '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>';

  async function importOld(store: MemoryClaudeCodeStore, chain: ReturnType<typeof basicChain>) {
    w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\app' }), chain });
    const r = await svc.importSessions({ session_ids: ['s1'] });
    const id = r.imported[0]?.thread_id as string;
    // As the first mapping left it: the command shown as the person's words.
    const cmd = (await threads.messages(id)).find((m) => textOf(m.parts) === '/model opus');
    await threads.updateMessage(cmd?.id as string, {
      parts: [{ type: 'text', text: COMMAND }],
      provenance: { claude_code: { session_id: 's1', uuid: 'c1', uuids: ['c1'] } },
    });
    const b = (await store.sessions(WS))[0];
    await store.putSession(WS, { ...(b as NonNullable<typeof b>), mapper_version: 1 });
    return { id, nb: r.imported[0]?.notebook_id };
  }

  it('rebuilds a thread that holds only Claude Code messages, keeping its id, title, notebook and head', async () => {
    const store = new MemoryClaudeCodeStore(threads, 'win32');
    svc = make({ store });
    const chain = [user('c1', COMMAND), ...basicChain()];
    const { id, nb } = await importOld(store, chain);
    await threads.patchThread(id, { title: 'Renamed here', title_source: 'user' });
    const before = await threads.messages(id);
    expect(textOf(before[0]?.parts ?? [])).toBe(COMMAND);

    svc.kick();
    await svc.idle();

    const after = await threads.messages(id);
    const t = await threads.getThread(id);
    expect(after).toHaveLength(3);
    expect(after[0]).toMatchObject({
      role: 'user',
      parent_id: null,
      parts: [{ type: 'text', text: '/model opus' }],
      provenance: {
        claude_code: { kind: 'command', command: { name: '/model', args: 'opus', output: null } },
      },
    });
    expect(after.map((m) => m.id)).not.toContain(before[0]?.id);
    expect(t).toMatchObject({ id, notebook_id: nb, title: 'Renamed here' });
    expect(t?.active_head_id).toBe(after[2]?.id);
    expect((await store.sessions(WS))[0]?.mapper_version).toBe(MAPPER_VERSION);
    // Once rebuilt, a pass leaves it alone.
    svc.kick();
    await svc.idle();
    expect((await threads.messages(id)).map((m) => m.id)).toEqual(after.map((m) => m.id));
  });

  it('leaves a thread with messages written in Ancile as it is', async () => {
    const store = new MemoryClaudeCodeStore(threads, 'win32');
    svc = make({ store });
    const { id } = await importOld(store, [user('c1', COMMAND), ...basicChain()]);
    const head = (await threads.getThread(id))?.active_head_id ?? null;
    await threads.insertMessage({
      id: 'msg_here',
      thread_id: id,
      parent_id: head,
      role: 'user',
      parts: [{ type: 'text', text: 'asked in Ancile' }],
      status: 'complete',
      trace_id: '0'.repeat(32),
    });
    const before = (await threads.messages(id)).map((m) => m.id);
    svc.kick();
    await svc.idle();
    expect((await threads.messages(id)).map((m) => m.id)).toEqual(before);
    expect(textOf((await threads.messages(id))[0]?.parts ?? [])).toBe(COMMAND);
    expect((await store.sessions(WS))[0]?.mapper_version).toBe(MAPPER_VERSION);
  });
});

describe('terminal forks', () => {
  it('brings a session forked in a terminal (/branch) in as a branch of the thread it came from', async () => {
    w.sessions.set('s1', { info: info('s1'), chain: basicChain() });
    const origin = (await svc.importSessions({ session_ids: ['s1'] })).imported[0];
    const tid = origin?.thread_id as string;
    const before = await threads.messages(tid);
    const answer = before.find((m) => m.role === 'assistant');

    // Claude Code's /branch copies the entries it forks from, uuids and all, into a new session.
    const fork = [
      ...basicChain(),
      user('f-u2', 'Now try it another way'),
      assistant('f-a2', [{ type: 'text', text: 'Another way.' }]),
    ];
    w.sessions.set('f1', { info: info('f1', { lastModified: NOW + 1_000 }), chain: fork });
    const r = await svc.importSessions({ session_ids: ['f1'] });
    expect(r.imported[0]).toMatchObject({ session_id: 'f1', thread_id: tid });

    const after = await threads.messages(tid);
    const prompt = after.find((m) => textOf(m.parts) === 'Now try it another way');
    expect(prompt?.parent_id).toBe(answer?.id); // hangs off where the fork was made
    expect((prompt?.provenance?.claude_code as { session_id?: string } | undefined)?.session_id).toBe('f1');
    expect(after).toHaveLength(before.length + 2); // nothing it shares came in twice
    const t = await threads.getThread(tid);
    expect(t?.settings.claude_code?.session_id).toBe('s1'); // the thread's own session is unchanged
    // Bound to that thread from now on: bringing it in again adds nothing.
    const again = await svc.importSessions({ session_ids: ['f1'] });
    expect(again.imported[0]).toMatchObject({ thread_id: tid, added: 0 });

    // A session sharing nothing still gets a thread of its own.
    w.sessions.set('x1', { info: info('x1'), chain: chainOf('x1') });
    const other = (await svc.importSessions({ session_ids: ['x1'] })).imported[0];
    expect(other?.thread_id).not.toBe(tid);
  });
});

describe('first-run import order and pacing', () => {
  it('orders families newest first, keeps each folder oldest first, and puts updates before new sessions', () => {
    const t = (h: number) => Date.UTC(2026, 9, 1, h);
    const todo = [
      info('old-a', { cwd: 'C:\\Code\\old', createdAt: t(1), lastModified: t(2) }),
      info('new-a', { cwd: 'C:\\Code\\new', createdAt: t(3), lastModified: t(9) }),
      // A terminal fork of new-a: made later, written earlier than new-a's last write.
      info('new-fork', { cwd: 'c:/code/NEW', createdAt: t(5), lastModified: t(6) }),
      info('mid-a', { cwd: 'C:\\Code\\mid', createdAt: t(4), lastModified: t(7) }),
      info('bound', { cwd: 'C:\\Code\\old', createdAt: t(0), lastModified: t(8) }),
      info('nowhere', { lastModified: t(1) }),
    ];
    const order = importOrder(todo, (i) => i.sessionId === 'bound', 'win32').map((i) => i.sessionId);
    expect(order).toEqual(['bound', 'new-a', 'new-fork', 'mid-a', 'old-a', 'nowhere']);
  });

  it('puts a /branch fork after its origin when both report the same createdAt (copied entries keep their timestamps)', () => {
    const t = (h: number) => Date.UTC(2026, 9, 1, h);
    // The fork is listed first and shares its origin's first timestamp; only its last write is later.
    const todo = [
      info('fork', { cwd: 'C:\\Code\\app', createdAt: t(1), lastModified: t(6) }),
      info('origin', { cwd: 'C:\\Code\\app', createdAt: t(1), lastModified: t(5) }),
    ];
    expect(importOrder(todo, () => false, 'win32').map((i) => i.sessionId)).toEqual(['origin', 'fork']);
    const loose = [
      info('fork', { createdAt: t(1), lastModified: t(6) }),
      info('origin', { createdAt: t(1), lastModified: t(5) }),
    ];
    expect(importOrder(loose, () => false, 'win32').map((i) => i.sessionId)).toEqual(['origin', 'fork']);
  });

  it('orders a thousand sessions newest folder first, oldest first within each folder', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const all = Array.from({ length: 1000 }, (_, i) =>
      info(`s${i}`, {
        cwd: `C:\\Code\\p${i % 10}`,
        createdAt: t0 + i * 60_000,
        lastModified: t0 + i * 60_000 + 1,
      }),
    );
    const order = importOrder(all, () => false, 'win32');
    // p9 holds the newest session (s999): its family comes first, oldest first within it.
    expect(order[0]?.sessionId).toBe('s9');
    expect(order[1]?.sessionId).toBe('s19');
    expect(order[99]?.sessionId).toBe('s999');
    expect(order[100]?.sessionId).toBe('s8');
    expect(order.at(-1)?.sessionId).toBe('s990');
    expect(new Set(order.map((i) => i.sessionId)).size).toBe(1000);
  });

  it('brings a terminal fork in after the session it came from, even when its folder is newest', async () => {
    svc = make();
    const fork = [
      ...chainOf('p'),
      user('f-u2', 'Now try it another way'),
      assistant('f-a2', [{ type: 'text', text: 'Another way.' }]),
    ];
    w.sessions.set('older', {
      info: info('older', { cwd: 'C:\\Code\\old', createdAt: NOW - 9e6, lastModified: NOW - 9e6 }),
      chain: chainOf('o'),
    });
    w.sessions.set('parent', {
      info: info('parent', { cwd: 'C:\\Code\\app', createdAt: NOW - 5e6, lastModified: NOW - 1_000 }),
      chain: chainOf('p'),
    });
    w.sessions.set('fork', {
      info: info('fork', { cwd: 'C:\\Code\\app', createdAt: NOW - 3e6, lastModified: NOW - 2e6 }),
      chain: fork,
    });
    svc.kick();
    await svc.idle();
    const list = await threads.listThreads(WS);
    expect(list).toHaveLength(2); // the fork joined its parent's thread
    // …and the thread is the parent's: it came in first, so the fork is the branch.
    const sessions = list.map((t) => t.settings.claude_code?.session_id).sort();
    expect(sessions).toEqual(['older', 'parent']);
  });

  it('waits while the person types, says so, and carries on after', async () => {
    let typing = true;
    svc = make({ auto: { startDelayMs: 0, debounceMs: 50, pauseMs: 0, typingPollMs: 10 } });
    svc.setTypingProbe(() => typing);
    w.sessions.set('s1', { info: info('s1', { cwd: 'C:\\Code\\app' }), chain: basicChain() });
    w.sessions.set('s2', { info: info('s2', { cwd: 'C:\\Code\\app' }), chain: chainOf('s2') });
    svc.kick();
    const until = Date.now() + 3000;
    while (!svc.importProgress()?.paused && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(svc.importProgress()).toMatchObject({ done: 0, total: 2, project: 'app', paused: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(await threads.listThreads(WS)).toHaveLength(0); // nothing written while typing
    typing = false;
    await svc.idle();
    expect(await threads.listThreads(WS)).toHaveLength(2);
    expect(svc.importProgress()).toBeNull();
    const progress = bus.events.flatMap((e) =>
      e.type === 'claude_code.changed' && e.what === 'sessions' && 'progress' in e ? [e.progress] : [],
    );
    expect(progress).toContainEqual(expect.objectContaining({ paused: true, project: 'app' }));
    expect(progress).toContainEqual(expect.objectContaining({ paused: false }));
    expect(progress.at(-1)).toBeNull(); // the line clears at the end
  });
});

void ({} as GlobalEvent);
