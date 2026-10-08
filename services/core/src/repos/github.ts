/**
 * ------------------------------------------------------------------
 *  Title    |  GitHub access
 *  Ref      |  DESIGN.md §17 · docs/repos.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Pull requests and Actions runs for a repository whose
 *           |  remote is on GitHub: list, read, open, merge, re-run,
 *           |  dispatch.
 *  How      |  The gh CLI first, reusing its own sign-in (like Claude
 *           |  Code does): NVX Ancile never sees that token. When gh is
 *           |  missing or signed out, a fine-grained token you saved in
 *           |  the Repo panel is used against the REST API,
 *           |  through the resilience policy. Neither: a clear error
 *           |  saying how to connect.
 *  Note     |  gh is run with an argv array and `-R owner/repo`, never
 *           |  a shell string, with a timeout and an output cap.
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { AncileError, type GitHubAccess, type PullRequestInfo, type WorkflowRunInfo } from '@nvx/contracts';
import { CircuitBreaker, ClassifiedError, classifyStatus, guarded } from '@nvx/resilience';
import type { SecretStore } from '../secrets';

export const GITHUB_TOKEN_SECRET = 'github.token';

export interface Slug {
  owner: string;
  repo: string;
}

export interface PrCreate {
  title: string;
  body?: string;
  base?: string;
  head: string;
  draft?: boolean;
}

export interface GitHubClient {
  access(): Promise<GitHubAccess>;
  prs(slug: Slug, opts?: { state?: 'open' | 'closed' | 'all'; limit?: number }): Promise<PullRequestInfo[]>;
  pr(slug: Slug, n: number): Promise<PullRequestInfo & { body: string }>;
  createPr(slug: Slug, pr: PrCreate, cwd: string): Promise<{ number: number | null; url: string }>;
  mergePr(slug: Slug, n: number, method: 'merge' | 'squash' | 'rebase'): Promise<{ merged: boolean }>;
  runs(slug: Slug, opts?: { branch?: string; limit?: number }): Promise<WorkflowRunInfo[]>;
  runLog(slug: Slug, id: number): Promise<{ log: string; truncated: boolean }>;
  rerun(slug: Slug, id: number, failedOnly: boolean): Promise<void>;
  dispatch(slug: Slug, workflow: string, ref: string, inputs: Record<string, string>): Promise<void>;
}

const unavailable = () =>
  new AncileError({
    code: 'repo.github_unavailable',
    title: 'NVX Ancile is not connected to GitHub',
    hint: 'Sign in with the GitHub CLI (`gh auth login`) and NVX Ancile uses that, or save a fine-grained token in the Repo panel (GitHub).',
    status: 401,
    errorClass: 'permanent',
  });

/* ---- the gh CLI -------------------------------------------------------- */

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBytes?: number },
) => Promise<ProcResult>;

export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 1024 * 1024;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
          GH_PAGER: 'cat',
        },
      });
    } catch (e) {
      resolve({ code: 127, stdout: '', stderr: String(e), truncated: false });
      return;
    }
    let out = '';
    let err = '';
    let truncated = false;
    child.stdout?.on('data', (b: Buffer) => {
      if (out.length < max) out += b.toString('utf8');
      else truncated = true;
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 64 * 1024) err += b.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 30_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: String(e), truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out.slice(0, max), stderr: err, truncated });
    });
  });

function ghFailed(r: ProcResult, what: string): AncileError {
  const said = (r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n');
  return new AncileError({
    code: 'repo.github_failed',
    title: `GitHub refused to ${what}`,
    hint: /auth|login|401|403/i.test(said)
      ? 'Your GitHub sign-in cannot do this. Run `gh auth refresh -s repo,workflow`, or use a token with those permissions.'
      : 'Read what GitHub said, fix that, and try again.',
    status: 502,
    errorClass: 'permanent',
    detail: said.slice(0, 800),
  });
}

const checksOf = (rollup: unknown): PullRequestInfo['checks'] => {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const states = rollup.map((c) =>
    String(
      (c as { conclusion?: string; state?: string }).conclusion || (c as { state?: string }).state || '',
    ).toUpperCase(),
  );
  if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s)))
    return 'failing';
  if (states.some((s) => ['', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(s))) return 'pending';
  return 'passing';
};

export class GhCliClient implements GitHubClient {
  constructor(private readonly run: Runner = runProcess) {}

  private async gh(
    args: string[],
    what: string,
    opts?: { timeoutMs?: number; maxBytes?: number },
  ): Promise<string> {
    const r = await this.run('gh', args, opts);
    if (r.code === 127) throw unavailable();
    if (r.code !== 0) throw ghFailed(r, what);
    return r.stdout;
  }

  async access(): Promise<GitHubAccess> {
    const st = await this.run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 });
    if (st.code === 127) return { via: 'none', login: null, detail: 'The GitHub CLI (gh) is not installed.' };
    if (st.code !== 0) return { via: 'none', login: null, detail: 'The GitHub CLI is not signed in.' };
    const who = await this.run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 });
    return { via: 'gh', login: who.code === 0 ? who.stdout.trim() || null : null, detail: null };
  }

  async prs(slug: Slug, opts: { state?: 'open' | 'closed' | 'all'; limit?: number } = {}) {
    const raw = await this.gh(
      [
        'pr',
        'list',
        '-R',
        `${slug.owner}/${slug.repo}`,
        '--state',
        opts.state ?? 'open',
        '--limit',
        String(Math.min(opts.limit ?? 20, 100)),
        '--json',
        'number,title,state,isDraft,headRefName,baseRefName,author,url,updatedAt,statusCheckRollup',
      ],
      'list pull requests',
    );
    return (JSON.parse(raw || '[]') as Record<string, unknown>[]).map(prFromGh);
  }

  async pr(slug: Slug, n: number) {
    const raw = await this.gh(
      [
        'pr',
        'view',
        String(n),
        '-R',
        `${slug.owner}/${slug.repo}`,
        '--json',
        'number,title,state,isDraft,headRefName,baseRefName,author,url,updatedAt,statusCheckRollup,body',
      ],
      'show that pull request',
    );
    const j = JSON.parse(raw) as Record<string, unknown>;
    return { ...prFromGh(j), body: String(j.body ?? '') };
  }

  async createPr(slug: Slug, pr: PrCreate, cwd: string) {
    void cwd;
    const args = [
      'pr',
      'create',
      '-R',
      `${slug.owner}/${slug.repo}`,
      '--title',
      pr.title,
      '--body',
      pr.body ?? '',
      '--head',
      pr.head,
    ];
    if (pr.base) args.push('--base', pr.base);
    if (pr.draft) args.push('--draft');
    const out = (await this.gh(args, 'open the pull request', { timeoutMs: 60_000 })).trim();
    const url = out.split('\n').pop() ?? out;
    const m = /\/pull\/(\d+)/.exec(url);
    return { number: m ? Number(m[1]) : null, url };
  }

  async mergePr(slug: Slug, n: number, method: 'merge' | 'squash' | 'rebase') {
    await this.gh(
      ['pr', 'merge', String(n), '-R', `${slug.owner}/${slug.repo}`, `--${method}`],
      'merge the pull request',
      {
        timeoutMs: 60_000,
      },
    );
    return { merged: true };
  }

  async runs(slug: Slug, opts: { branch?: string; limit?: number } = {}) {
    const args = [
      'run',
      'list',
      '-R',
      `${slug.owner}/${slug.repo}`,
      '--limit',
      String(Math.min(opts.limit ?? 15, 100)),
      '--json',
      'databaseId,name,workflowName,headBranch,event,status,conclusion,url,createdAt',
    ];
    if (opts.branch) args.push('--branch', opts.branch);
    const raw = await this.gh(args, 'list Actions runs');
    return (JSON.parse(raw || '[]') as Record<string, unknown>[]).map((r) => ({
      id: Number(r.databaseId),
      name: String(r.workflowName || r.name || 'Workflow'),
      branch: String(r.headBranch ?? ''),
      event: String(r.event ?? ''),
      status: String(r.status ?? '').toLowerCase(),
      conclusion: r.conclusion ? String(r.conclusion).toLowerCase() : null,
      url: String(r.url ?? ''),
      created_at: String(r.createdAt ?? ''),
    }));
  }

  async runLog(slug: Slug, id: number) {
    const r = await this.run(
      'gh',
      ['run', 'view', String(id), '-R', `${slug.owner}/${slug.repo}`, '--log-failed'],
      {
        timeoutMs: 60_000,
        maxBytes: 256 * 1024,
      },
    );
    if (r.code === 127) throw unavailable();
    if (r.code !== 0) throw ghFailed(r, 'show the run log');
    // The end of a log is where the failure is.
    const lines = r.stdout.split('\n');
    return { log: lines.slice(-400).join('\n'), truncated: r.truncated || lines.length > 400 };
  }

  async rerun(slug: Slug, id: number, failedOnly: boolean) {
    await this.gh(
      ['run', 'rerun', String(id), '-R', `${slug.owner}/${slug.repo}`, ...(failedOnly ? ['--failed'] : [])],
      're-run the workflow',
    );
  }

  async dispatch(slug: Slug, workflow: string, ref: string, inputs: Record<string, string>) {
    const args = ['workflow', 'run', workflow, '-R', `${slug.owner}/${slug.repo}`, '--ref', ref];
    for (const [k, v] of Object.entries(inputs)) args.push('-f', `${k}=${v}`);
    await this.gh(args, 'start the workflow');
  }
}

function prFromGh(j: Record<string, unknown>): PullRequestInfo {
  return {
    number: Number(j.number),
    title: String(j.title ?? ''),
    state: String(j.state ?? '').toLowerCase(),
    draft: Boolean(j.isDraft),
    head: String(j.headRefName ?? ''),
    base: String(j.baseRefName ?? ''),
    author: String((j.author as { login?: string } | undefined)?.login ?? ''),
    url: String(j.url ?? ''),
    updated_at: String(j.updatedAt ?? ''),
    checks: checksOf(j.statusCheckRollup),
  };
}

/* ---- the REST API with a saved token ------------------------------------ */

const API = 'https://api.github.com';
const breaker = new CircuitBreaker();

export class GitHubRestClient implements GitHubClient {
  constructor(
    private readonly token: () => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token();
    if (!token) throw unavailable();
    return guarded(
      { key: 'github', breaker, timeoutMs: 20_000, retry: { maxAttempts: method === 'GET' ? 3 : 1 } },
      async (signal) => {
        const res = await this.fetchImpl(`${API}${path}`, {
          method,
          signal,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            ...(body !== undefined && { 'content-type': 'application/json' }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 600);
          if (res.status >= 500 || res.status === 429)
            throw new ClassifiedError(classifyStatus(res.status), `GitHub ${res.status}`, {
              status: res.status,
            });
          throw ghFailed(
            { code: res.status, stdout: '', stderr: `${res.status} ${text}`, truncated: false },
            'do that',
          );
        }
        return (res.status === 204 ? undefined : await res.json()) as T;
      },
    );
  }

  async access(): Promise<GitHubAccess> {
    if (!(await this.token())) return { via: 'none', login: null, detail: 'No token saved.' };
    try {
      const u = await this.call<{ login: string }>('GET', '/user');
      return { via: 'token', login: u.login, detail: null };
    } catch (err) {
      return { via: 'none', login: null, detail: (err as Error).message.slice(0, 200) };
    }
  }

  async prs(slug: Slug, opts: { state?: 'open' | 'closed' | 'all'; limit?: number } = {}) {
    const list = await this.call<Record<string, unknown>[]>(
      'GET',
      `/repos/${enc(slug)}/pulls?state=${opts.state ?? 'open'}&per_page=${Math.min(opts.limit ?? 20, 100)}`,
    );
    return list.map(prFromRest);
  }

  async pr(slug: Slug, n: number) {
    const j = await this.call<Record<string, unknown>>('GET', `/repos/${enc(slug)}/pulls/${n}`);
    return { ...prFromRest(j), body: String(j.body ?? '') };
  }

  async createPr(slug: Slug, pr: PrCreate) {
    let base = pr.base;
    if (!base)
      base = (await this.call<{ default_branch: string }>('GET', `/repos/${enc(slug)}`)).default_branch;
    const j = await this.call<{ number: number; html_url: string }>('POST', `/repos/${enc(slug)}/pulls`, {
      title: pr.title,
      body: pr.body ?? '',
      head: pr.head,
      base,
      draft: pr.draft ?? false,
    });
    return { number: j.number, url: j.html_url };
  }

  async mergePr(slug: Slug, n: number, method: 'merge' | 'squash' | 'rebase') {
    const j = await this.call<{ merged: boolean }>('PUT', `/repos/${enc(slug)}/pulls/${n}/merge`, {
      merge_method: method,
    });
    return { merged: j.merged };
  }

  async runs(slug: Slug, opts: { branch?: string; limit?: number } = {}) {
    const q = new URLSearchParams({ per_page: String(Math.min(opts.limit ?? 15, 100)) });
    if (opts.branch) q.set('branch', opts.branch);
    const j = await this.call<{ workflow_runs: Record<string, unknown>[] }>(
      'GET',
      `/repos/${enc(slug)}/actions/runs?${q}`,
    );
    return j.workflow_runs.map((r) => ({
      id: Number(r.id),
      name: String(r.name ?? 'Workflow'),
      branch: String(r.head_branch ?? ''),
      event: String(r.event ?? ''),
      status: String(r.status ?? ''),
      conclusion: r.conclusion ? String(r.conclusion) : null,
      url: String(r.html_url ?? ''),
      created_at: String(r.created_at ?? ''),
    }));
  }

  async runLog(slug: Slug, id: number) {
    // The REST log download is a zip; the failed steps by name are what a person needs first.
    const j = await this.call<{
      jobs: {
        name: string;
        conclusion: string | null;
        steps?: { name: string; conclusion: string | null }[];
      }[];
    }>('GET', `/repos/${enc(slug)}/actions/runs/${id}/jobs`);
    const lines: string[] = [];
    for (const job of j.jobs) {
      lines.push(`${job.name}: ${job.conclusion ?? 'running'}`);
      for (const s of job.steps ?? [])
        if (s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped')
          lines.push(`  ${s.name}: ${s.conclusion}`);
    }
    lines.push(
      '',
      'Full logs: sign in with the GitHub CLI (gh) to read them here, or open the run on GitHub.',
    );
    return { log: lines.join('\n'), truncated: false };
  }

  async rerun(slug: Slug, id: number, failedOnly: boolean) {
    await this.call(
      'POST',
      `/repos/${enc(slug)}/actions/runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`,
      {},
    );
  }

  async dispatch(slug: Slug, workflow: string, ref: string, inputs: Record<string, string>) {
    await this.call(
      'POST',
      `/repos/${enc(slug)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        ref,
        inputs,
      },
    );
  }
}

const enc = (s: Slug) => `${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;

function prFromRest(j: Record<string, unknown>): PullRequestInfo {
  const head = j.head as { ref?: string } | undefined;
  const base = j.base as { ref?: string } | undefined;
  return {
    number: Number(j.number),
    title: String(j.title ?? ''),
    state: j.merged_at ? 'merged' : String(j.state ?? ''),
    draft: Boolean(j.draft),
    head: String(head?.ref ?? ''),
    base: String(base?.ref ?? ''),
    author: String((j.user as { login?: string } | undefined)?.login ?? ''),
    url: String(j.html_url ?? ''),
    updated_at: String(j.updated_at ?? ''),
  };
}

/* ---- the one the app uses ---------------------------------------------- */

/**
 * gh when it is signed in, else the saved token, else nothing. The choice
 * is remembered for a minute so a panel full of PRs does not run
 * `gh auth status` for each.
 */
export class GitHubAccessor implements GitHubClient {
  private cached: { at: number; client: GitHubClient | null; access: GitHubAccess } | null = null;

  constructor(
    private readonly gh: GitHubClient,
    private readonly rest: GitHubClient,
    private readonly now: () => number = Date.now,
  ) {}

  forget(): void {
    this.cached = null;
  }

  private async pick(): Promise<{ client: GitHubClient | null; access: GitHubAccess }> {
    if (this.cached && this.now() - this.cached.at < 60_000) return this.cached;
    let access = await this.gh.access().catch(() => ({ via: 'none' as const, login: null, detail: null }));
    let client: GitHubClient | null = access.via === 'gh' ? this.gh : null;
    if (!client) {
      const viaToken = await this.rest.access();
      if (viaToken.via === 'token') {
        access = viaToken;
        client = this.rest;
      } else if (viaToken.detail && viaToken.detail !== 'No token saved.') access = viaToken;
    }
    this.cached = { at: this.now(), client, access };
    return this.cached;
  }

  async access() {
    return (await this.pick()).access;
  }

  private async c(): Promise<GitHubClient> {
    const { client } = await this.pick();
    if (!client) throw unavailable();
    return client;
  }

  async prs(slug: Slug, opts?: { state?: 'open' | 'closed' | 'all'; limit?: number }) {
    return (await this.c()).prs(slug, opts);
  }
  async pr(slug: Slug, n: number) {
    return (await this.c()).pr(slug, n);
  }
  async createPr(slug: Slug, pr: PrCreate, cwd: string) {
    return (await this.c()).createPr(slug, pr, cwd);
  }
  async mergePr(slug: Slug, n: number, method: 'merge' | 'squash' | 'rebase') {
    return (await this.c()).mergePr(slug, n, method);
  }
  async runs(slug: Slug, opts?: { branch?: string; limit?: number }) {
    return (await this.c()).runs(slug, opts);
  }
  async runLog(slug: Slug, id: number) {
    return (await this.c()).runLog(slug, id);
  }
  async rerun(slug: Slug, id: number, failedOnly: boolean) {
    return (await this.c()).rerun(slug, id, failedOnly);
  }
  async dispatch(slug: Slug, workflow: string, ref: string, inputs: Record<string, string>) {
    return (await this.c()).dispatch(slug, workflow, ref, inputs);
  }
}

export function savedToken(secrets: SecretStore): () => Promise<string | undefined> {
  return () => secrets.get(GITHUB_TOKEN_SECRET);
}

/** The gh CLI's own token, for the GitHub MCP preset when the person chose "use my gh sign-in". */
export async function ghToken(run: Runner = runProcess): Promise<string | null> {
  const r = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 15_000 });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
