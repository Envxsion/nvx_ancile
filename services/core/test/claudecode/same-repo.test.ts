/**
 * One repository in two folders (track G), with real temporary git
 * repositories: a worktree, a clone with the same history and remote, a
 * link to the same folder, WSL and Windows spellings of one path, and an
 * unrelated repository. Notebooks are never merged by themselves: the
 * person shows them together or keeps them apart, and that is remembered.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SameRepoList } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeCodeRoutes } from '../../src/claudecode/routes';
import {
  folderIdentity,
  MemoryRepoPairStore,
  pathKey,
  remoteKey,
  SameRepoFinder,
  sameRepo,
} from '../../src/claudecode/same-repo';
import type { ClaudeCodeService } from '../../src/claudecode/service';
import type { ProjectBinding } from '../../src/claudecode/store';
import { errorHandler } from '../../src/obs/errors';

let dir: string;
let main: string;
let worktree: string;
let cloneA: string;
let cloneB: string;
let other: string;
let link: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
    windowsHide: true,
  }).toString();

async function repo(path: string, file: string) {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q');
  await writeFile(join(path, file), 'hello\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'first');
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-same-repo-'));
  main = join(dir, 'app');
  await repo(main, 'a.txt');
  worktree = join(dir, 'app-feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  // Two clones of one origin: the same first commit and the same remote, separate .git folders.
  cloneA = join(dir, 'clone-a');
  cloneB = join(dir, 'clone-b');
  git(dir, 'clone', '-q', main, cloneA);
  git(dir, 'clone', '-q', main, cloneB);
  git(cloneA, 'remote', 'set-url', 'origin', 'git@github.com:nvx/app.git');
  git(cloneB, 'remote', 'set-url', 'origin', 'https://github.com/nvx/app');
  other = join(dir, 'other');
  await repo(other, 'b.txt');
  link = join(dir, 'app-link');
  await symlink(main, link, process.platform === 'win32' ? 'junction' : 'dir');
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a folder path as one key', () => {
  it('joins WSL and Windows spellings, and ignores case only for Windows paths', () => {
    expect(pathKey('\\\\wsl$\\Ubuntu\\home\\x\\repo')).toBe(pathKey('/home/x/repo'));
    expect(pathKey('\\\\wsl.localhost\\Debian\\home\\x\\repo\\')).toBe(pathKey('/home/x/repo'));
    expect(pathKey('/mnt/c/Users/X/Repo')).toBe(pathKey('C:\\Users\\x\\repo'));
    expect(pathKey('c:/users/x/repo/')).toBe(pathKey('C:\\Users\\X\\Repo'));
    expect(pathKey('/home/x/Repo')).not.toBe(pathKey('/home/x/repo'));
  });

  it('joins the ways a remote is written', () => {
    expect(remoteKey('git@github.com:nvx/app.git')).toBe(remoteKey('https://github.com/nvx/app'));
    expect(remoteKey('ssh://git@GitHub.com/nvx/app.git')).toBe(remoteKey('https://user@github.com/nvx/app/'));
    expect(remoteKey('https://github.com/nvx/app')).not.toBe(remoteKey('https://github.com/nvx/other'));
  });
});

describe('which folders are one repository', () => {
  it('a git worktree, a clone with the same history and remote, a link; never an unrelated repository', async () => {
    const [a, w, ca, cb, o, l] = await Promise.all(
      [main, worktree, cloneA, cloneB, other, link].map((p) => folderIdentity(p)),
    );
    expect(sameRepo(a as never, w as never)).toBe('worktree');
    expect(sameRepo(ca as never, cb as never)).toBe('same_history');
    expect(sameRepo(a as never, l as never)).toBe('same_folder');
    expect(sameRepo(a as never, o as never)).toBeNull();
    // A clone of a repository with no remote of its own is not "the same" as it.
    expect(sameRepo(a as never, ca as never)).toBeNull();
  }, 30_000);

  it('another casing of a Windows path is the same folder', async () => {
    if (process.platform !== 'win32') return;
    const upper = await folderIdentity(main.toUpperCase());
    expect(sameRepo(upper, await folderIdentity(main))).toBe('same_folder');
  });

  it('a folder that is not there only has its path compared', async () => {
    const gone = await folderIdentity(join(dir, 'gone'));
    expect(gone).toMatchObject({ gitCommon: null, firstCommit: null, remote: null });
  });
});

describe('suggestions and choices', () => {
  const setup = () => {
    const projects: ProjectBinding[] = [
      { cwd: main, cwd_key: main, notebook_id: 'nbk_app', created_notebook: true },
      { cwd: worktree, cwd_key: worktree, notebook_id: 'nbk_feature', created_notebook: true },
      { cwd: other, cwd_key: other, notebook_id: 'nbk_other', created_notebook: true },
      { cwd: link, cwd_key: link, notebook_id: 'nbk_link', created_notebook: true },
    ];
    const titles: Record<string, string> = {
      nbk_app: 'app',
      nbk_feature: 'app-feature',
      nbk_other: 'other',
      nbk_link: 'app-link',
    };
    const pairs = new MemoryRepoPairStore();
    const finder = new SameRepoFinder({
      projects: async () => projects,
      notebook: async (id) => (titles[id] ? { title: titles[id] as string } : null),
      pairs,
    });
    return { finder, pairs, titles };
  };

  it('suggests, never merges; Keep apart is remembered; Show together groups them', async () => {
    const { finder } = setup();
    const first = await finder.matchesFor('nbk_feature');
    expect(first.can_merge).toBe(false);
    expect(first.items).toEqual([
      expect.objectContaining({ notebook_id: 'nbk_app', title: 'app', reason: 'worktree', together: false }),
      expect.objectContaining({ notebook_id: 'nbk_link', reason: 'worktree' }),
    ]);
    expect((await finder.matchesFor('nbk_app')).items.find((m) => m.notebook_id === 'nbk_link')?.reason).toBe(
      'same_folder',
    );
    expect((await finder.matchesFor('nbk_other')).items).toEqual([]);

    const apart = await finder.choose('nbk_feature', 'nbk_link', 'keep_apart');
    expect(apart.items.map((m) => m.notebook_id)).toEqual(['nbk_app']);
    // Remembered from the other side too.
    expect((await finder.matchesFor('nbk_link')).items.map((m) => m.notebook_id)).toEqual(['nbk_app']);

    const together = await finder.choose('nbk_app', 'nbk_feature', 'show_together');
    expect(together.items.find((m) => m.notebook_id === 'nbk_feature')?.together).toBe(true);
    await finder.choose('nbk_app', 'nbk_link', 'show_together');
    expect(await finder.links()).toEqual({ groups: [['nbk_app', 'nbk_feature', 'nbk_link']] });
  }, 30_000);

  it('refuses a choice for notebooks that are not one repository', async () => {
    const { finder } = setup();
    await expect(finder.choose('nbk_app', 'nbk_other', 'show_together')).rejects.toMatchObject({
      code: 'request.not_found',
    });
  }, 30_000);

  it('answers the routes', async () => {
    const { finder } = setup();
    const app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/',
      claudeCodeRoutes({
        service: () => ({}) as ClaudeCodeService,
        sameRepo: () => finder,
      }) as unknown as Hono,
    );
    const got = (await (
      await app.request('/claude-code/notebooks/nbk_feature/same-repo')
    ).json()) as SameRepoList;
    expect(got.items.map((m) => m.notebook_id)).toEqual(['nbk_app', 'nbk_link']);
    const res = await app.request('/claude-code/notebooks/nbk_feature/same-repo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ other_notebook_id: 'nbk_app', choice: 'keep_apart' }),
    });
    expect(((await res.json()) as SameRepoList).items.map((m) => m.notebook_id)).toEqual(['nbk_link']);
    const bad = await app.request('/claude-code/notebooks/nbk_feature/same-repo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ other_notebook_id: 'nbk_app', choice: 'merge' }),
    });
    expect(bad.status).toBe(400);
    expect(await (await app.request('/claude-code/notebook-links')).json()).toEqual({ groups: [] });
  }, 30_000);
});
