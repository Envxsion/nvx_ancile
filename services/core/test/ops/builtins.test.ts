/**
 * A1 and A2: every built-in automation reads its switch and its settings.
 * The settings Admin offers are exactly the ones read (and automations.yaml
 * lists no others); event-driven jobs can be switched and set; the features
 * they serve obey them; the knowledge service is sent its own; memory
 * capture's switch is its mode; memory backup is off until it has a
 * remote, its Test push changes nothing, and no push prompts or leaks a
 * remote's credentials.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutomationView, PathBudget } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  builtinConfigProblem,
  builtinOptions,
  memoryCaptureLink,
  redactRemote,
  scheduledJobs,
  testMemoryPush,
} from '../../src/automations/jobs';
import { AutomationRunner, CATALOGUE, MemoryAutomationStore } from '../../src/automations/runner';
import {
  BuiltinSettings,
  type JobSwitches,
  KnowledgeSync,
  knowledgeAutomations,
} from '../../src/automations/settings';
import { MemoryObsStore } from '../../src/obs/store';
import { MemorySettings } from '../../src/settings';
import { contextWatch, pathBudget, prepareTurnContext } from '../../src/threads/compact';
import { asTree, type MessageRecord } from '../../src/threads/repo';
import { branchSuggester, topicDrift } from '../../src/threads/suggest';
import { type Harness, harness } from '../support/harness';

// These tests run real git processes, which are slow on Windows when many files run at once.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const RETENTION = { logsDays: 14, spansDays: 30, runEventsDays: 7 };
const YAML = join(import.meta.dirname, '../../../../config/automations.yaml');

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

type Err = { error: { code: string; title: string; hint: string } };

/** Switches for a test: on unless said, settings as given. */
const switches = (
  off: string[] = [],
  settings: Record<string, Record<string, unknown>> = {},
): JobSwitches => ({
  on: (id) => !off.includes(id),
  option: (id, key) => settings[id]?.[key],
});

describe('the settings Admin offers', () => {
  it('are exactly the ones automations.yaml sets, for jobs it has', async () => {
    const file = parse(await readFile(YAML, 'utf8')) as {
      jobs: Record<string, { config?: Record<string, unknown> }>;
    };
    const options = builtinOptions(RETENTION);
    for (const [id, job] of Object.entries(file.jobs)) {
      expect(CATALOGUE[id], `${id} has words for Admin`).toBeDefined();
      const keys = (options[id] ?? []).map((o) => o.key);
      // A key in the file that nothing offers would be a setting that does nothing.
      for (const k of Object.keys(job.config ?? {})) expect(keys, `${id}.${k}`).toContain(k);
    }
    for (const id of Object.keys(options)) expect(file.jobs[id], `${id} is a job`).toBeDefined();
  });

  it('drops the jobs that never did anything', async () => {
    const file = parse(await readFile(YAML, 'utf8')) as { jobs: Record<string, unknown> };
    for (const gone of ['tldr', 'model_suggestions', 'model_stats_rollup']) {
      expect(file.jobs[gone]).toBeUndefined();
      expect(CATALOGUE[gone]).toBeUndefined();
    }
  });

  it('refuses a warning that comes after compacting', () => {
    expect(
      builtinConfigProblem('context_overflow_warn', { warn_at_percent: 80, compact_at_percent: 95 }),
    ).toBeNull();
    expect(
      builtinConfigProblem('context_overflow_warn', { warn_at_percent: 95, compact_at_percent: 90 }),
    ).toMatch(/before compacting/);
    expect(builtinConfigProblem('cleanup', { logs_days: 1 })).toBeNull();
  });
});

describe('BuiltinSettings', () => {
  const jobs = {
    auto_title: { enabled: true, config: {} },
    duplicate_sources: { enabled: true, config: { near_duplicate_percent: 90 } },
  };

  it('reads Admin’s change over the file, and a job nobody configured is on', async () => {
    const store = new MemoryAutomationStore();
    await store.ensure([
      { id: 'auto_title', cron: null, config: {}, enabled: true },
      { id: 'duplicate_sources', cron: null, config: { near_duplicate_percent: 90 }, enabled: true },
    ]);
    const s = new BuiltinSettings(jobs, store);
    expect(s.on('auto_title')).toBe(true);
    expect(s.on('never_heard_of')).toBe(true);
    expect(s.option('duplicate_sources', 'near_duplicate_percent')).toBe(90);
    await store.patch('auto_title', { enabled: false });
    await store.patch('duplicate_sources', { config: { near_duplicate_percent: 75 } });
    // Nothing changes until it reads again: reads never wait on the database.
    expect(s.on('auto_title')).toBe(true);
    const seen: string[][] = [];
    s.subscribe((ids) => seen.push(ids));
    await s.refresh();
    expect(s.on('auto_title')).toBe(false);
    expect(s.option('duplicate_sources', 'near_duplicate_percent')).toBe(75);
    expect(seen).toEqual([['auto_title', 'duplicate_sources'].sort()].map((x) => x));
    await s.refresh();
    expect(seen).toHaveLength(1);
  });

  it('falls back to the file, then to nothing, for a setting', () => {
    const s = new BuiltinSettings(jobs);
    expect(s.option('duplicate_sources', 'near_duplicate_percent')).toBe(90);
    expect(s.option('duplicate_sources', 'other')).toBeUndefined();
    expect(s.option('auto_title', 'x')).toBeUndefined();
  });
});

describe('the knowledge service’s jobs', () => {
  it('are sent as the contract has them, defaults where nothing is set', () => {
    expect(knowledgeAutomations(switches())).toEqual({
      auto_tag_sources: { enabled: true, max_tags: 5 },
      duplicate_sources: { enabled: true, near_duplicate_percent: 90 },
      stale_sources: { enabled: true, url_stale_after_days: 7 },
    });
    const s = switches(['auto_tag_sources'], {
      duplicate_sources: { near_duplicate_percent: 70 },
      stale_sources: { url_stale_after_days: 400 }, // out of range: the default
    });
    expect(knowledgeAutomations(s)).toMatchObject({
      auto_tag_sources: { enabled: false },
      duplicate_sources: { near_duplicate_percent: 70 },
      stale_sources: { url_stale_after_days: 7 },
    });
  });

  it('are sent at start, after a change to one of them, and again until taken', async () => {
    const store = new MemoryAutomationStore();
    await store.ensure([
      { id: 'auto_tag_sources', cron: null, config: { max_tags: 5 }, enabled: true },
      { id: 'auto_title', cron: null, config: {}, enabled: true },
    ]);
    const s = new BuiltinSettings({}, store);
    await s.refresh();
    let fail = true;
    const put = vi.fn(async (_path: string, _body: unknown) => {
      if (fail) throw new Error('knowledge is starting');
      return {};
    });
    const sync = new KnowledgeSync(s, { put }, 60_000);
    sync.start();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sync.owed).toBe(true));
    fail = false;
    expect(await sync.send()).toBe(true);
    expect(sync.owed).toBe(false);
    expect(put.mock.calls[1]?.[0]).toBe('/maintenance/automations');
    // A change to a job that is not the knowledge service's sends nothing.
    await store.patch('auto_title', { enabled: false });
    await s.refresh();
    expect(put).toHaveBeenCalledTimes(2);
    await store.patch('auto_tag_sources', { config: { max_tags: 2 } });
    await s.refresh();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
    const sent = put.mock.calls[2]?.[1] as { auto_tag_sources: { max_tags: number } } | undefined;
    expect(sent?.auto_tag_sources.max_tags).toBe(2);
    sync.stop();
  });
});

describe('Admin → Automations', () => {
  const JOBS = {
    cleanup: { enabled: true, cron: '0 3 * * *', config: {} },
    memory_backup: { enabled: true, cron: '0 * * * *', config: {} },
    auto_title: { enabled: true, config: {} },
    context_overflow_warn: { enabled: true, config: { warn_at_percent: 80, compact_at_percent: 95 } },
    memory_capture: { enabled: true, config: {} },
  };

  async function ops(extra: { onChange?: (id: string) => void; remote?: boolean } = {}) {
    const settings = new MemorySettings();
    let mode: 'auto_confident' | 'propose_all' | 'off' = 'auto_confident';
    const memory = {
      captureMode: async () => mode,
      setCaptureMode: async (m: typeof mode) => {
        mode = m;
      },
    };
    const tested: Record<string, unknown>[] = [];
    h = await harness({
      ops: true,
      automations: {
        jobs: JOBS,
        handlers: { cleanup: async () => ({ status: 'succeeded' }) },
        extras: {
          options: builtinOptions(RETENTION),
          setup: {
            memory_backup: () =>
              extra.remote ? null : { title: 'Not set up', hint: 'Set its git remote in Edit.' },
          },
          linked: { memory_capture: memoryCaptureLink({ memory, settings }) },
          ...(extra.onChange && { onChange: extra.onChange }),
        },
      },
    });
    await h.automations.start(60_000);
    h.automations.stop();
    return { mode: () => mode, tested };
  }

  it('switches an event-driven job and changes its settings, but gives it no schedule', async () => {
    const changed: string[] = [];
    await ops({ onChange: (id) => void changed.push(id) });
    const hh = h as Harness;
    const off = await hh.call<AutomationView>('PATCH', '/automations/auto_title', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    const set = await hh.call<AutomationView>('PATCH', '/automations/context_overflow_warn', {
      config: { warn_at_percent: 70 },
    });
    expect(set.body).toMatchObject({
      customised: true,
      config: { warn_at_percent: 70, compact_at_percent: 95 },
    });
    const crossed = await hh.call<Err>('PATCH', '/automations/context_overflow_warn', {
      config: { warn_at_percent: 96 },
    });
    expect(crossed.status).toBe(400);
    const cron = await hh.call<Err>('PATCH', '/automations/auto_title', { cron: '0 9 * * *' });
    expect(cron.body.error.code).toBe('automation.event_driven');
    const reset = await hh.call<AutomationView>('POST', '/automations/context_overflow_warn/reset');
    expect(reset.body).toMatchObject({ customised: false, config: { warn_at_percent: 80 } });
    // Every change is passed on, so the features see it at once.
    expect(changed).toEqual(['auto_title', 'context_overflow_warn', 'context_overflow_warn']);
  });

  it('memory backup is off until it has a remote, and cannot be switched on before', async () => {
    await ops();
    const hh = h as Harness;
    const v = (await hh.automations.view('memory_backup')) as AutomationView;
    expect(v).toMatchObject({ enabled: false, setup: { title: 'Not set up' } });
    const on = await hh.call<Err>('PATCH', '/automations/memory_backup', { enabled: true });
    expect(on.status).toBe(422);
    expect(on.body.error.code).toBe('automation.not_set_up');
  });

  it('memory backup reads as on once it has a remote', async () => {
    await ops({ remote: true });
    const view = (await h?.automations.view('memory_backup')) as AutomationView | undefined;
    expect(view?.enabled).toBe(true);
  });

  it('a job with no test says so', async () => {
    await ops();
    const r = await (h as Harness).call<Err>('POST', '/automations/cleanup/test', {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('automation.no_test');
  });

  it('Learn from corrections is memory capture’s mode: one switch, one setting', async () => {
    const m = await ops();
    const hh = h as Harness;
    let v = (await hh.automations.view('memory_capture')) as AutomationView;
    expect(v).toMatchObject({ enabled: true, config: { mode: 'auto_confident' } });
    const ask = await hh.call<AutomationView>('PATCH', '/automations/memory_capture', {
      config: { mode: 'propose_all' },
    });
    expect(ask.body.config.mode).toBe('propose_all');
    expect(m.mode()).toBe('propose_all');
    await hh.call('PATCH', '/automations/memory_capture', { enabled: false });
    expect(m.mode()).toBe('off');
    v = (await hh.automations.view('memory_capture')) as AutomationView;
    expect(v).toMatchObject({ enabled: false, config: { mode: 'propose_all' } });
    // On again: the mode it had comes back.
    await hh.call('PATCH', '/automations/memory_capture', { enabled: true });
    expect(m.mode()).toBe('propose_all');
    const bad = await hh.call<Err>('PATCH', '/automations/memory_capture', { config: { mode: 'off' } });
    expect(bad.status).toBe(400);
  });
});

describe('the features read their switches', () => {
  it('Name new threads off leaves a new thread as New thread', async () => {
    h = await harness({ switches: switches(['auto_title']) });
    const t = await h.newThread();
    const r = await h.send(t, 'How do I seal a centrifugal pump shaft?');
    await h.settle(r.run_id);
    const thread = await h.call<{ title: string }>('GET', `/threads/${t}`);
    expect(thread.body.title).toBe('New thread');
  });

  it('Name new threads on names it from the first message', async () => {
    h = await harness({ switches: switches() });
    const t = await h.newThread();
    const r = await h.send(t, 'How do I seal a centrifugal pump shaft?');
    await h.settle(r.run_id);
    const thread = await h.call<{ title: string }>('GET', `/threads/${t}`);
    expect(thread.body.title).not.toBe('New thread');
  });

  it('Suggest a branch off reads nothing at all', async () => {
    const messages = vi.fn(async () => []);
    const suggest = branchSuggester({
      repo: { messages } as never,
      gateway: {} as never,
      registry: {} as never,
      promptsDir: '/nowhere',
      switches: switches(['branch_suggestions']),
    });
    await suggest({ id: 't' } as never, 'm1');
    expect(messages).not.toHaveBeenCalled();
  });

  it('Suggest a branch fires below the share of words it is set to', () => {
    const recent = [
      'pump impeller cavitation noise readings',
      'pump impeller replacement costs quoted',
      'pump seal leaking under pressure tests',
    ];
    const next = 'pump impeller birthday invitation grandmother saturday party';
    // Two of seven words are shared (29%).
    expect(topicDrift(recent, next).fired).toBe(false);
    expect(topicDrift(recent, next, 0.3).fired).toBe(true);
    expect(topicDrift(recent, next, 0.25).fired).toBe(false);
  });

  const msg = (id: string, parent: string | null, role: 'user' | 'assistant'): MessageRecord => ({
    id,
    thread_id: 't',
    parent_id: parent,
    role,
    parts: [{ type: 'text', text: `${role} says thing number ${id} `.repeat(20) }],
    model_id: null,
    requested_model_id: null,
    status: 'complete',
    edit_of_id: null,
    provenance: {},
    usage: null,
    run_id: null,
    trace_id: 'x',
    created_at: '2026-10-07T00:00:00Z',
  });
  const chain = Array.from({ length: 7 }, (_, i) =>
    msg(`m${i + 1}`, i === 0 ? null : `m${i}`, i % 2 ? 'assistant' : 'user'),
  );
  const path = asTree(chain);
  const model = { id: 'm', context_window: 1_000, max_output: 100 } as never;

  it('Watch the context window: its own lines, and off means no warning at all', () => {
    const at = (watch: ReturnType<typeof contextWatch>, system: number) =>
      pathBudget({ headId: 'm7', path, summaries: [], model, system, watch });
    const loose = contextWatch(
      switches([], { context_overflow_warn: { warn_at_percent: 50, compact_at_percent: 60 } }),
    );
    expect(loose).toMatchObject({ on: true, warnAt: 0.5, compactAt: 0.6 });
    const b = at(loose, 400);
    expect(b.warn_at).toBe(0.5);
    expect(b.compacts_at).toBe(0.6);
    expect(b.level).toBe(b.ratio >= 0.6 ? 'critical' : b.ratio >= 0.5 ? 'warn' : 'ok');
    const off = contextWatch(switches(['context_overflow_warn']));
    expect(at(off, 900).level).toBe('ok');
    // Crossed settings (saved before the check) fall back to the defaults.
    expect(
      contextWatch(switches([], { context_overflow_warn: { warn_at_percent: 97, compact_at_percent: 90 } })),
    ).toMatchObject({ warnAt: 0.8, compactAt: 0.95 });
  });

  it('Watch the context window off never compacts by itself', async () => {
    const stream = vi.fn();
    const r = await prepareTurnContext(
      {
        gateway: { stream } as never,
        registry: {} as never,
        promptsDir: '/nowhere',
        branches: { summaries: async () => [] } as never,
      },
      {
        threadId: 't',
        messages: chain,
        userMessageId: 'm7',
        model,
        system: 900,
        retrieval: 0,
        watch: contextWatch(switches(['context_overflow_warn'])),
      },
    );
    expect(stream).not.toHaveBeenCalled();
    expect(r.skipThrough).toBeNull();
  });

  it('the context meter’s lines come from the same setting', async () => {
    h = await harness({
      switches: switches([], { context_overflow_warn: { warn_at_percent: 60, compact_at_percent: 70 } }),
    });
    const t = await h.newThread();
    const r = await h.send(t, 'Hello');
    await h.settle(r.run_id);
    const b = await h.call<PathBudget>('GET', `/threads/${t}/context-budget`);
    expect(b.body).toMatchObject({ warn_at: 0.6, compacts_at: 0.7 });
  });
});

describe('memory backup', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

  async function memoryRepo() {
    const root = await mkdtemp(join(tmpdir(), 'ancile-backup-'));
    dirs.push(root);
    const memory = join(root, 'memory');
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['init', '-q', memory]);
    await writeFile(join(memory, 'USER.md'), '# You\n');
    git(memory, 'add', '.');
    git(memory, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    return { root, memory, remote };
  }

  it('Test push tries the remote and changes nothing there', async () => {
    const { memory, remote } = await memoryRepo();
    expect(await testMemoryPush(memory, remote)).toMatchObject({ ok: true });
    // A dry run: the remote has no branch yet.
    expect(execFileSync('git', ['--git-dir', remote, 'branch'], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('Test push says what went wrong, never with the remote’s credentials', async () => {
    const { memory, root } = await memoryRepo();
    const missing = await testMemoryPush(memory, join(root, 'nowhere.git'));
    expect(missing.ok).toBe(false);
    expect(missing.detail.length).toBeGreaterThan(0);
    const secret = await testMemoryPush(memory, 'https://me:s3cr3t-token@127.0.0.1:9/memory.git', 15_000);
    expect(secret.ok).toBe(false);
    expect(secret.detail).not.toContain('s3cr3t-token');
  });

  it('Test push with no history says so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ancile-backup-'));
    dirs.push(root);
    expect(await testMemoryPush(root, 'git@example.com:me/memory.git')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/no history yet/),
    });
  });

  it('a failed backup never shows the remote’s credentials', async () => {
    const { memory } = await memoryRepo();
    const jobs = scheduledJobs({
      obs: new MemoryObsStore(),
      memoryDir: memory,
      memoryRemote: 'https://me:s3cr3t-token@127.0.0.1:9/memory.git',
      retention: RETENTION,
    });
    const err = await (jobs.memory_backup as NonNullable<(typeof jobs)['memory_backup']>)(
      {},
      new AbortController().signal,
      { id: 'memory_backup', title: 'Back up memory' },
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('s3cr3t-token');
  });

  it('the runner keeps credentials out of Admin whatever failed', async () => {
    const store = new MemoryAutomationStore();
    const runner = new AutomationRunner(
      { memory_backup: { enabled: true, cron: '0 * * * *', config: {} } },
      {
        memory_backup: async () => {
          throw new Error("fatal: unable to access 'https://me:tok3n@github.com/me/m.git/': 403");
        },
      },
      store,
    );
    await runner.start(60_000);
    runner.stop();
    expect(await runner.runNow('memory_backup')).toBe('failed');
    const v = await runner.view('memory_backup');
    expect(v?.last_error).toContain('https://•••@github.com');
    expect(v?.last_error).not.toContain('tok3n');
  });

  it('redacts user and token from any address', () => {
    expect(redactRemote('push to https://u:p@host/x.git and ssh://git@h/y')).toBe(
      'push to https://•••@host/x.git and ssh://•••@h/y',
    );
    expect(redactRemote('git@github.com:me/x.git')).toBe('git@github.com:me/x.git');
  });
});
