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
import { claudeCodeRoutes } from '../../src/claudecode/routes';
import { ClaudeCodeService, notebookNames } from '../../src/claudecode/service';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
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
    const marker = msgs.find(
      (m) => (m.provenance.claude_code as { kind?: string })?.kind === 'compact_boundary',
    );
    expect(marker).toMatchObject({
      role: 'system',
      parts: [{ type: 'text', text: 'Summary of the work so far' }],
    });
    expect(msgs.at(-1)?.parent_id).toBe(marker?.id);
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
      chain: basicChain(),
    });
    w.sessions.set('b', { info: info('b', { summary: 'A summary', firstPrompt: 'P' }), chain: basicChain() });
    w.sessions.set('c', {
      info: info('c', { summary: '', firstPrompt: 'The first prompt\nmore' }),
      chain: basicChain(),
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
      chain: basicChain(),
    });
    w.sessions.set('b', {
      info: info('b', { cwd: 'C:\\Users\\p\\Desktop\\nvx_ancile' }),
      chain: basicChain(),
    });
    w.sessions.set('c', { info: info('c', { cwd: 'c:/users/p/github/NVX_ANCILE' }), chain: basicChain() });
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
    expect(patched).toEqual({ auto_install: true, auto_import: true, claude_telemetry: false });
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

void ({} as GlobalEvent);
