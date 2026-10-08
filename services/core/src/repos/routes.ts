/**
 * ------------------------------------------------------------------
 *  Title    |  Repository routes
 *  Ref      |  DESIGN.md §17 · docs/repos.md · docs/api.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Repo panel's API: add and link folders, read status,
 *           |  diffs, history and branches, run the operation a person
 *           |  chose, and see pull requests and Actions runs.
 *  How      |  A button pressed in the panel is the person acting, so
 *           |  it runs directly; models act only through the tools in
 *           |  tools.ts, which pass the permission gate.
 *  Note     |  The GitHub MCP preset adds the official server over
 *           |  stdio with the token from the secret store (or gh's).
 * ------------------------------------------------------------------
 */

import {
  AddRepoRequest,
  AncileError,
  CreatePullRequest,
  GitHubMcpPresetRequest,
  LinkRepoRequest,
  RepoActionRequest,
  SaveGitHubTokenRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { McpManager } from '../mcp/manager';
import type { SecretStore } from '../secrets';
import type { SettingsStore } from '../settings';
import {
  GITHUB_TOKEN_SECRET,
  type GitHubAccessor,
  type GitHubClient,
  ghToken,
  type Runner,
  runProcess,
} from './github';
import type { RepoService } from './service';

export const MCP_ADDED_SETTING = 'mcp.added';
export const GITHUB_MCP_SECRET = 'GITHUB_PERSONAL_ACCESS_TOKEN';

export interface RepoRouteDeps {
  repos: RepoService;
  github: GitHubClient & Partial<Pick<GitHubAccessor, 'forget'>>;
  secrets: SecretStore;
  settings: SettingsStore;
  mcp?: Pick<McpManager, 'connect'>;
  /** For the MCP preset: is docker or the server binary on PATH? Injected in tests. */
  run?: Runner;
}

export function repoRoutes(deps: RepoRouteDeps) {
  const { repos, github } = deps;
  const r = new Hono<AppEnv>();

  r.get('/repos', async (c) => c.json({ items: await repos.list(), next_cursor: null }));

  r.post('/repos', async (c) => {
    const req = await body(c, AddRepoRequest);
    return c.json(await repos.add(req.path, req.name), 201);
  });

  r.delete('/repos/:id', async (c) => {
    await repos.remove(c.req.param('id'));
    return c.body(null, 204);
  });

  /** The repository a thread (or notebook) works in. */
  r.get('/repos/linked', async (c) => {
    const repo = await repos.linkedFor({
      threadId: c.req.query('thread_id') ?? null,
      notebookId: c.req.query('notebook_id') ?? null,
    });
    return c.json({ repo });
  });

  r.post('/repos/link', async (c) => {
    const req = await body(c, LinkRepoRequest);
    await repos.link(req.scope, req.scope_ref, req.repo_id);
    return c.json({ ok: true });
  });

  r.get('/repos/:id/status', async (c) =>
    c.json(await repos.status((await repos.get(c.req.param('id'))).id)),
  );

  r.get('/repos/:id/diff', async (c) => {
    const path = c.req.query('path');
    return c.json(
      await repos.diff((await repos.get(c.req.param('id'))).id, {
        ...(path && { path }),
        staged: c.req.query('staged') === 'true',
      }),
    );
  });

  r.get('/repos/:id/log', async (c) => {
    const limit = Number(c.req.query('limit') ?? 30);
    return c.json({ items: await repos.log(c.req.param('id'), Number.isFinite(limit) ? limit : 30) });
  });

  r.get('/repos/:id/branches', async (c) => c.json({ items: await repos.branches(c.req.param('id')) }));

  r.post('/repos/:id/actions', async (c) => {
    const req = await body(c, RepoActionRequest);
    return c.json(await repos.act((await repos.get(c.req.param('id'))).id, req, c.req.raw.signal));
  });

  /**
   * A commit message drafted from what is staged: the subject from the
   * files touched, in the repository's own style (conventional prefixes
   * when its recent commits use them). No model call, so it is instant
   * and free; the person edits it before committing.
   */
  r.get('/repos/:id/suggest-message', async (c) => {
    const id = (await repos.get(c.req.param('id'))).id;
    const [{ files, stat }, recent] = await Promise.all([repos.stagedSummary(id), repos.log(id, 15)]);
    return c.json({
      message: suggestMessage(
        files,
        recent.map((x) => x.subject),
      ),
      stat,
    });
  });

  /* ---- GitHub ---------------------------------------------------------- */

  r.get('/github/access', async (c) => c.json(await github.access()));

  r.put('/github/token', async (c) => {
    const req = await body(c, SaveGitHubTokenRequest);
    if (req.token) await deps.secrets.set(GITHUB_TOKEN_SECRET, req.token.trim());
    else await deps.secrets.delete(GITHUB_TOKEN_SECRET);
    github.forget?.();
    return c.json(await github.access());
  });

  const slug = async (id: string) => {
    const s = await repos.status((await repos.get(id)).id);
    if (!s.github)
      throw new AncileError({
        code: 'repo.not_github',
        title: 'This repository is not on GitHub',
        hint: 'Its origin remote is not a github.com address.',
        status: 409,
        errorClass: 'permanent',
      });
    return s.github;
  };

  r.get('/repos/:id/pulls', async (c) => {
    const state = (c.req.query('state') ?? 'open') as 'open' | 'closed' | 'all';
    return c.json({ items: await github.prs(await slug(c.req.param('id')), { state }) });
  });

  r.post('/repos/:id/pulls', async (c) => {
    const req = await body(c, CreatePullRequest);
    const id = (await repos.get(c.req.param('id'))).id;
    const s = await repos.status(id);
    if (!s.branch)
      throw new AncileError({
        code: 'repo.detached',
        title: 'There is no branch to open a pull request from',
        hint: 'Switch to a branch first.',
        status: 409,
        errorClass: 'permanent',
      });
    return c.json(
      await github.createPr(
        await slug(id),
        {
          title: req.title,
          ...(req.body && { body: req.body }),
          ...(req.base && { base: req.base }),
          head: s.branch,
          ...(req.draft && { draft: true }),
        },
        await repos.root(id),
      ),
      201,
    );
  });

  r.get('/repos/:id/runs', async (c) => {
    const branch = c.req.query('branch');
    return c.json({ items: await github.runs(await slug(c.req.param('id')), { ...(branch && { branch }) }) });
  });

  r.get('/repos/:id/runs/:run/log', async (c) =>
    c.json(await github.runLog(await slug(c.req.param('id')), Number(c.req.param('run')))),
  );

  r.post('/repos/:id/runs/:run/rerun', async (c) => {
    await github.rerun(
      await slug(c.req.param('id')),
      Number(c.req.param('run')),
      c.req.query('failed') !== 'false',
    );
    return c.json({ ok: true });
  });

  /* ---- The GitHub MCP server preset -------------------------------------- */

  r.post('/mcp/presets/github', async (c) => {
    const req = await body(c, GitHubMcpPresetRequest);
    if (!deps.mcp)
      throw new AncileError({
        code: 'mcp.unavailable',
        title: 'MCP servers are not available here',
        hint: 'Restart NVX Ancile and try again.',
        status: 503,
        errorClass: 'transient',
      });
    const token =
      req.token?.trim() ||
      (await deps.secrets.get(GITHUB_TOKEN_SECRET)) ||
      (await ghToken(deps.run ?? runProcess));
    if (!token)
      throw new AncileError({
        code: 'repo.github_unavailable',
        title: 'The GitHub MCP server needs a GitHub token',
        hint: 'Paste a fine-grained token, or sign in with `gh auth login` and press Add again.',
        status: 400,
        errorClass: 'permanent',
      });
    const runner = await mcpRunner(deps.run ?? runProcess, req.read_only === true);
    if (!runner)
      throw new AncileError({
        code: 'mcp.github_runner_missing',
        title: 'Nothing can run the GitHub MCP server here',
        hint: 'Install Docker, or download github-mcp-server from github.com/github/github-mcp-server and put it on your PATH.',
        status: 409,
        errorClass: 'permanent',
      });
    await deps.secrets.set(GITHUB_MCP_SECRET, token);
    const spec = {
      name: 'github',
      transport: 'stdio' as const,
      command: runner.command,
      args: runner.args,
      env_secrets: [GITHUB_MCP_SECRET],
      enabled: true,
      tools: {},
    };
    const saved = ((await deps.settings.get<(typeof spec)[]>(MCP_ADDED_SETTING)) ?? []).filter(
      (s) => s.name !== 'github',
    );
    await deps.settings.set(MCP_ADDED_SETTING, [...saved, spec]);
    const health = await deps.mcp.connect(spec);
    return c.json({ server: 'github', runner: runner.label, health }, 201);
  });

  return r;
}

/** Docker if it is there, else the server binary; read-only adds the server's own switch. */
async function mcpRunner(
  run: Runner,
  readOnly: boolean,
): Promise<{ command: string; args: string[]; label: string } | null> {
  const bin = await run('github-mcp-server', ['--version'], { timeoutMs: 10_000 });
  if (bin.code === 0)
    return {
      command: 'github-mcp-server',
      args: ['stdio', ...(readOnly ? ['--read-only'] : [])],
      label: 'github-mcp-server',
    };
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
  if (docker.code === 0)
    return {
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        '-e',
        GITHUB_MCP_SECRET,
        ...(readOnly ? ['-e', 'GITHUB_READ_ONLY=1'] : []),
        'ghcr.io/github/github-mcp-server',
      ],
      label: 'docker',
    };
  return null;
}

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?:/;

/** A first draft of a commit message from file names and the house style. */
export function suggestMessage(files: string[], recentSubjects: string[]): string {
  if (files.length === 0) return '';
  const conventional =
    recentSubjects.filter((s) => CONVENTIONAL.test(s)).length >= Math.ceil(recentSubjects.length / 2) &&
    recentSubjects.length > 0;
  const tops = [
    ...new Set(
      files.map((f) =>
        f
          .split('/')
          .slice(0, f.includes('/') ? 2 : 1)
          .join('/'),
      ),
    ),
  ];
  const dirs = [...new Set(files.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')))];
  const allDocs = files.every((f) => /\.(md|mdx|txt|rst)$/i.test(f) || f.startsWith('docs/'));
  const allTests = files.every((f) => /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/i.test(f));
  const what =
    files.length === 1
      ? `update ${files[0]}`
      : tops.length === 1
        ? `update ${tops[0]} (${files.length} files)`
        : `update ${files.length} files in ${tops.slice(0, 3).join(', ')}${tops.length > 3 ? '…' : ''}`;
  if (!conventional) return what.charAt(0).toUpperCase() + what.slice(1);
  const type = allDocs ? 'docs' : allTests ? 'test' : 'chore';
  // A scope only when every file sits in one folder: its name, as conventional commits use.
  const scope = dirs.length === 1 && dirs[0] ? (dirs[0].split('/').pop() ?? '') : '';
  return `${type}${scope ? `(${scope})` : ''}: ${what}`;
}
