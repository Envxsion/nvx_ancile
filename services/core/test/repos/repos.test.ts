/**
 * Repositories (DESIGN §17): a real git in temporary folders, with a
 * local bare repository as the remote. No network, and never the
 * person's own repositories.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalEvent, PullRequestInfo } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import type { EventBus, GlobalEventInput } from '../../src/events/bus';
import { errorHandler } from '../../src/obs/errors';
import { parseGitHub, parseStatus, redactUrl, safePath, safeRef } from '../../src/repos/git';
import { GhCliClient, GitHubAccessor, type GitHubClient, type Runner } from '../../src/repos/github';
import { repoRoutes, suggestMessage } from '../../src/repos/routes';
import { RepoService } from '../../src/repos/service';
import { repoTools } from '../../src/repos/tools';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

class Bus implements EventBus {
  events: GlobalEventInput[] = [];
  async publish(e: GlobalEventInput) {
    this.events.push(e);
  }
  subscribe() {
    return () => undefined;
  }
}

let dir: string;
let work: string;
let remote: string;
let bus: Bus;
let repos: RepoService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-repos-'));
  remote = join(dir, 'remote.git');
  work = join(dir, 'work');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  sh(work, 'config', 'user.name', 'Test');
  sh(work, 'config', 'user.email', 'test@example.com');
  sh(work, 'config', 'core.autocrlf', 'false');
  await writeFile(join(work, 'README.md'), '# Hello\n');
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'feat: first');
  sh(work, 'remote', 'add', 'origin', remote);
  bus = new Bus();
  repos = new RepoService({ settings: new MemorySettings(), bus, pollMs: 0 });
});

afterEach(async () => {
  repos.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('git status parsing', () => {
  it('reads branch, upstream, ahead and behind, and every kind of change', () => {
    const raw = [
      '# branch.oid abc123',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/app.ts',
      '1 A. N... 000000 100644 100644 000 ccc new file.ts',
      '2 R. N... 100644 100644 100644 ddd eee R100 lib/b.ts',
      'lib/a.ts',
      '? notes.txt',
      '',
    ].join('\0');
    const s = parseStatus(raw);
    expect(s).toMatchObject({
      branch: 'feature/x',
      upstream: 'origin/feature/x',
      ahead: 2,
      behind: 1,
      head: 'abc123',
    });
    expect(s.files).toEqual([
      { path: 'src/app.ts', staged: '.', unstaged: 'M' },
      { path: 'new file.ts', staged: 'A', unstaged: '.' },
      { path: 'lib/b.ts', staged: 'R', unstaged: '.', from: 'lib/a.ts' },
      { path: 'notes.txt', staged: '?', unstaged: '?' },
    ]);
  });

  it('knows GitHub remotes in every form, and hides credentials in URLs', () => {
    expect(parseGitHub('https://github.com/Envxsion/nvx_ancile.git')).toEqual({
      owner: 'Envxsion',
      repo: 'nvx_ancile',
    });
    expect(parseGitHub('git@github.com:a/b.git')).toEqual({ owner: 'a', repo: 'b' });
    expect(parseGitHub('ssh://git@github.com/a/b')).toEqual({ owner: 'a', repo: 'b' });
    expect(parseGitHub('https://gitlab.com/a/b.git')).toBeNull();
    expect(redactUrl('https://user:ghp_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git');
  });

  it('refuses refs and paths that git could read as options or that leave the repository', () => {
    for (const bad of ['-f', '--force', 'a..b', 'x y', 'main~1', 'a:b', '', 'x.lock'])
      expect(() => safeRef(bad)).toThrow(/not a branch name/);
    expect(safeRef('feature/login-fix')).toBe('feature/login-fix');
    for (const bad of ['../x', '/etc/passwd', 'C:/x', '-rf', 'a/../../b'])
      expect(() => safePath(bad)).toThrow();
    expect(safePath('src\\app.ts')).toBe('src/app.ts');
  });
});

describe('repositories', { timeout: 30_000 }, () => {
  it('adds a repository by any folder inside it, once, and refuses a folder that is not one', async () => {
    await writeFile(join(work, 'x.txt'), '');
    const a = await repos.add(work);
    expect(a.name).toBe('work');
    expect(a.status?.branch).toBe('main');
    expect((await repos.add(join(work))).id).toBe(a.id);
    await expect(repos.add(dir)).rejects.toMatchObject({ code: 'repo.not_a_repo' });
  });

  it('stages, commits, pushes with an upstream, and sees ahead and behind', async () => {
    const { id } = await repos.add(work);
    await writeFile(join(work, 'a.ts'), 'export const a = 1;\n');
    let s = await repos.status(id);
    expect(s.files).toEqual([{ path: 'a.ts', staged: '?', unstaged: '?' }]);
    const d = await repos.diff(id, { path: 'a.ts' });
    expect(d.diff).toContain('+export const a = 1;');

    await repos.act(id, { op: 'stage', paths: ['a.ts'] });
    expect((await repos.stagedSummary(id)).files).toEqual(['a.ts']);
    await repos.act(id, { op: 'commit', message: 'feat: add a\n\nWith a body; quotes " and $(not a shell)' });
    expect((await repos.log(id, 1))[0]?.subject).toBe('feat: add a');

    await repos.act(id, { op: 'push' });
    s = await repos.status(id);
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(0);

    // Someone else pushes; we fetch and are behind; pull fast-forwards.
    const other = join(dir, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    sh(other, 'config', 'user.name', 'O');
    sh(other, 'config', 'user.email', 'o@example.com');
    await writeFile(join(other, 'b.ts'), 'b\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'feat: b');
    sh(other, 'push', '-q');
    await repos.act(id, { op: 'fetch' });
    expect((await repos.status(id)).behind).toBe(1);
    await repos.act(id, { op: 'pull' });
    expect((await repos.status(id)).behind).toBe(0);
  });

  it("a pull that cannot fast-forward fails with git's words and a fix, never a merge commit", async () => {
    const { id } = await repos.add(work);
    await repos.act(id, { op: 'push' });
    const other = join(dir, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    sh(other, 'config', 'user.name', 'O');
    sh(other, 'config', 'user.email', 'o@example.com');
    await writeFile(join(other, 'b.ts'), 'b\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'theirs');
    sh(other, 'push', '-q');
    await writeFile(join(work, 'c.ts'), 'c\n');
    await repos.act(id, { op: 'commit', message: 'mine', all: true });
    await expect(repos.act(id, { op: 'pull' })).rejects.toMatchObject({ code: 'repo.git_failed' });
    await expect(repos.act(id, { op: 'push' })).rejects.toMatchObject({
      code: 'repo.git_failed',
      hint: expect.stringMatching(/Pull first/),
    });
  });

  it('notices a branch switched outside NVX Ancile and says so', async () => {
    const { id } = await repos.add(work);
    await repos.refresh(id);
    sh(work, 'switch', '-q', '-c', 'feature/y');
    await repos.pollAll();
    const changed = bus.events.find((e) => e.type === 'repo.changed') as Extract<
      GlobalEvent,
      { type: 'repo.changed' }
    >;
    expect(changed).toMatchObject({ repo_id: id, branch: 'feature/y', previous_branch: 'main' });
    const note = bus.events.find((e) => e.type === 'notification') as Extract<
      GlobalEvent,
      { type: 'notification' }
    >;
    expect(note.title).toBe('work is on feature/y now');
  });

  it('links a thread or notebook to a repository; the thread link wins', async () => {
    const a = await repos.add(work);
    const second = join(dir, 'second');
    execFileSync('git', ['init', '-q', '-b', 'main', second]);
    const b = await repos.add(second);
    await repos.link('notebook', 'nbk_1', a.id);
    expect(repos.linkedId({ notebookId: 'nbk_1' })).toBe(a.id);
    await repos.link('thread', 'thr_1', b.id);
    expect(repos.linkedId({ threadId: 'thr_1', notebookId: 'nbk_1' })).toBe(b.id);
    await expect(repos.resolve(undefined, {})).rejects.toMatchObject({ code: 'repo.not_linked' });
    await repos.remove(b.id);
    expect(repos.linkedId({ threadId: 'thr_1', notebookId: 'nbk_1' })).toBe(a.id);
  });

  it('an @repo on the message beats the thread and notebook links, and an unknown one is ignored', async () => {
    const a = await repos.add(work);
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    const b = await repos.add(other);
    await repos.link('thread', 'thr_2', a.id);
    expect(repos.linkedId({ threadId: 'thr_2', repoId: b.id })).toBe(b.id);
    expect((await repos.resolve(undefined, { threadId: 'thr_2', repoId: b.id })).id).toBe(b.id);
    expect(repos.resourceName(undefined, { threadId: 'thr_2', repoId: b.id })).toBe(b.name);
    expect(repos.linkedId({ threadId: 'thr_2', repoId: 'rep_gone' })).toBe(a.id);
  });
});

describe('tools', { timeout: 30_000 }, () => {
  const noGitHub: GitHubClient = new GitHubAccessor(
    { access: async () => ({ via: 'none', login: null, detail: null }) } as unknown as GitHubClient,
    {
      access: async () => ({ via: 'none', login: null, detail: 'No token saved.' }),
    } as unknown as GitHubClient,
  );

  it('reads freely, asks before local changes, and always asks before anything outward', async () => {
    const tools = new Map(repoTools(repos, noGitHub).map((t) => [t.name, t]));
    expect(tools.get('git_status')?.tier).toBe('auto');
    expect(tools.get('git_commit')?.tier).toBe('gated');
    expect(tools.get('git_push')?.tier).toBe('critical');
    expect(tools.get('gh_pr_merge')?.tier).toBe('critical');
    expect(tools.get('git_push_force_with_lease')).toMatchObject({ tier: 'critical', destructive: true });
    // No tool takes a force flag or arbitrary git arguments.
    for (const t of tools.values()) {
      const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props)).not.toContain('force');
      expect(Object.keys(props)).not.toContain('args');
    }
  });

  it('names the linked repository in the permission resource, and previews a commit from the repository itself', async () => {
    const { id } = await repos.add(work);
    await repos.link('thread', 'thr_9', id);
    const tools = new Map(repoTools(repos, noGitHub).map((t) => [t.name, t]));
    const scope = { threadId: 'thr_9', notebookId: null };
    expect(tools.get('git_commit')?.resource({ message: 'x' }, scope)).toBe('repo:work');
    expect(tools.get('git_push')?.resource({}, scope)).toBe('repo:work/push');
    expect(tools.get('git_switch')?.resource({ branch: 'dev' }, scope)).toBe('repo:work/branch/dev');

    await writeFile(join(work, 'z.ts'), 'z\n');
    const preview = await tools.get('git_commit')?.preview?.({ message: 'feat: z', all: true }, scope);
    expect(preview).toMatchObject({
      repository: 'work',
      branch: 'main',
      message: 'feat: z',
      files: ['z.ts'],
    });

    const ctl = new AbortController();
    const out = await tools
      .get('git_commit')
      ?.execute({ message: 'feat: z', all: true }, { idempotencyKey: 'k', signal: ctl.signal, scope });
    expect(out).toMatchObject({ ok: true });
    const st = (await tools
      .get('git_status')
      ?.execute({}, { idempotencyKey: 'k2', signal: ctl.signal, scope })) as { files: unknown[] };
    expect(st.files).toEqual([]);
  });

  it('says how to connect GitHub when neither gh nor a token is there', async () => {
    const { id } = await repos.add(work);
    sh(work, 'remote', 'set-url', 'origin', 'https://github.com/a/b.git');
    await repos.refresh(id);
    const list = repoTools(repos, noGitHub).find((t) => t.name === 'gh_pr_list');
    await expect(
      list?.execute({ repo: 'work' }, { idempotencyKey: 'k', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'repo.github_unavailable' });
  });
});

describe('the gh CLI', () => {
  it("lists pull requests with checks, reusing gh's own sign-in", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'auth') return { code: 0, stdout: '', stderr: 'Logged in', truncated: false };
      if (args[0] === 'api') return { code: 0, stdout: 'octo\n', stderr: '', truncated: false };
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            title: 'Fix',
            state: 'OPEN',
            isDraft: false,
            headRefName: 'fix',
            baseRefName: 'main',
            author: { login: 'octo' },
            url: 'u',
            updatedAt: 't',
            statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
          },
        ]),
        stderr: '',
        truncated: false,
      };
    };
    const gh = new GhCliClient(run);
    expect(await gh.access()).toEqual({ via: 'gh', login: 'octo', detail: null });
    const prs: PullRequestInfo[] = await gh.prs({ owner: 'a', repo: 'b' });
    expect(prs[0]).toMatchObject({ number: 7, state: 'open', checks: 'failing', author: 'octo' });
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['pr', 'list', '-R', 'a/b']);
  });
});

describe('routes', { timeout: 30_000 }, () => {
  const app = () => {
    const a = new Hono<AppEnv>();
    a.onError(errorHandler);
    const fakeRun: Runner = async () => ({ code: 127, stdout: '', stderr: '', truncated: false });
    a.route(
      '/',
      repoRoutes({
        repos,
        github: new GhCliClient(fakeRun),
        secrets: new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64'))),
        settings: new MemorySettings(),
        run: fakeRun,
        mcp: {
          connect: async () => ({
            server: 'github',
            transport: 'stdio',
            enabled: true,
            connected: true,
            tools: 3,
            lastError: null,
            connectedAt: null,
          }),
        },
      }),
    );
    return a;
  };
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  it('adds, links, reads and acts through the API', async () => {
    const a = app();
    const added = await a.request('/repos', json('POST', { path: work }));
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: string };
    expect(
      (await a.request('/repos/link', json('POST', { scope: 'thread', scope_ref: 'thr_1', repo_id: id })))
        .status,
    ).toBe(200);
    const linked = (await (await a.request('/repos/linked?thread_id=thr_1')).json()) as {
      repo: { id: string };
    };
    expect(linked.repo.id).toBe(id);
    await writeFile(join(work, 'n.md'), 'n\n');
    const act = await a.request(`/repos/${id}/actions`, json('POST', { op: 'stage', paths: ['n.md'] }));
    expect(act.status).toBe(200);
    const msg = (await (await a.request(`/repos/${id}/suggest-message`)).json()) as { message: string };
    expect(msg.message).toBe('docs: update n.md');
    const bad = await a.request(`/repos/${id}/actions`, json('POST', { op: 'switch', branch: '--orphan' }));
    expect(bad.status).toBe(400);
  });

  it('the GitHub MCP preset says what to install when nothing can run the server', async () => {
    const res = await app().request(
      '/mcp/presets/github',
      json('POST', { token: 'github_pat_xxxxxxxxxxxxxxxx' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('mcp.github_runner_missing');
  });
});

describe('commit message drafts', () => {
  it('follows the house style', () => {
    expect(suggestMessage(['src/a.ts'], ['Add things', 'Fix stuff'])).toBe('Update src/a.ts');
    expect(suggestMessage(['src/repos/a.ts', 'src/repos/b.ts'], ['feat: x', 'fix(y): z'])).toBe(
      'chore(repos): update src/repos (2 files)',
    );
    expect(suggestMessage(['docs/a.md', 'README.md'], ['docs: x'])).toMatch(/^docs: /);
    expect(suggestMessage([], [])).toBe('');
  });
});
