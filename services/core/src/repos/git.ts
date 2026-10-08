/**
 * ------------------------------------------------------------------
 *  Title    |  Git runner
 *  Ref      |  DESIGN.md §17 · docs/repos.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Run git for a registered repository and read what it
 *           |  says: status with branch and upstream, logs, branches,
 *           |  remotes, diffs.
 *  How      |  spawn with an argv array, never a shell string, in the
 *           |  repository root only. No prompts (GIT_TERMINAL_PROMPT=0),
 *           |  no editor, a timeout and an output cap on every call.
 *           |  Status is `--porcelain=v2 --branch -z`, which is stable
 *           |  across versions and safe for any file name.
 *  Note     |  Credentials are git's own (credential helper, SSH agent,
 *           |  gh's helper): NVX Ancile never sees or stores them.
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BranchInfo, CommitInfo, RepoStatus } from '@nvx/contracts';
import { AncileError } from '@nvx/contracts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface GitOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Text written to git's stdin (a commit message with -F -). */
  input?: string;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX = 2 * 1024 * 1024;

/** The environment git runs with: the person's own, minus anything that could prompt or open an editor. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
  };
}

export function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const max = opts.maxBytes ?? DEFAULT_MAX;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      // -c settings that keep git non-interactive and its output stable.
      child = spawn('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], {
        cwd,
        env: gitEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(gitMissing(err));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const take = (chunks: Buffer[]) => (b: Buffer) => {
      if (size >= max) {
        truncated = true;
        return;
      }
      const room = max - size;
      chunks.push(room < b.length ? b.subarray(0, room) : b);
      if (room < b.length) truncated = true;
      size += Math.min(room, b.length);
    };
    child.stdout?.on('data', take(out));
    child.stderr?.on('data', take(err));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(gitMissing(e));
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (sig && code === null) {
        reject(
          new AncileError({
            code: 'repo.git_timeout',
            title: 'Git took too long',
            hint: 'A pull or push may be waiting on the network or a password. Try it in a terminal to see why.',
            status: 504,
            errorClass: 'transient',
          }),
        );
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
      });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function gitMissing(cause: unknown): AncileError {
  return new AncileError({
    code: 'repo.git_missing',
    title: 'Git is not installed',
    hint: 'Install git from git-scm.com, then try again.',
    status: 503,
    errorClass: 'permanent',
    detail: String((cause as Error)?.message ?? cause).slice(0, 200),
  });
}

/** Run git and throw an AncileError with git's own words when it fails. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const r = await runGit(cwd, args, opts);
  if (r.code !== 0) throw gitFailed(args, r);
  return r.stdout;
}

export function gitFailed(args: string[], r: Pick<GitResult, 'stderr' | 'stdout'>): AncileError {
  const said = (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n');
  const op = args.find((a) => !a.startsWith('-')) ?? 'git';
  const hint = /could not read Username|Authentication failed|Permission denied \(publickey\)/i.test(said)
    ? 'Git could not sign in to the remote. Sign in once in a terminal (or run `gh auth login`), then try again.'
    : /non-fast-forward|fetch first|rejected/i.test(said)
      ? 'The remote has commits you do not have. Pull first, then push.'
      : /CONFLICT|unmerged|fix conflicts/i.test(said)
        ? 'Some files conflict. Resolve them, stage them, then commit.'
        : /would be overwritten|commit your changes or stash/i.test(said)
          ? 'You have changes that would be lost. Commit or stash them first.'
          : /nothing to commit/i.test(said)
            ? 'Stage some changes first.'
            : 'Read what git said, fix that, and try again.';
  return new AncileError({
    code: 'repo.git_failed',
    title: `git ${op} failed`,
    hint,
    status: 409,
    errorClass: 'permanent',
    detail: said.slice(0, 1_000),
  });
}

/** The repository root containing `dir`, or null when it is not inside one. */
export async function repoRootOf(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const r = await runGit(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** owner/repo from a GitHub remote URL (https, ssh or git@ forms). */
export function parseGitHub(url: string): { owner: string; repo: string } | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(
  raw: string,
): Pick<RepoStatus, 'branch' | 'head' | 'upstream' | 'ahead' | 'behind' | 'files'> {
  const out: Pick<RepoStatus, 'branch' | 'head' | 'upstream' | 'ahead' | 'behind' | 'files'> = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const entries = raw.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as string;
    if (!e) continue;
    if (e.startsWith('# branch.oid ')) {
      const oid = e.slice(13);
      out.head = oid === '(initial)' ? null : oid;
    } else if (e.startsWith('# branch.head ')) {
      const b = e.slice(14);
      out.branch = b === '(detached)' ? null : b;
    } else if (e.startsWith('# branch.upstream ')) out.upstream = e.slice(18);
    else if (e.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(e);
      out.ahead = Number(m?.[1] ?? 0);
      out.behind = Number(m?.[2] ?? 0);
    } else if (e.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const parts = e.split(' ');
      const xy = parts[1] ?? '..';
      out.files.push({ path: parts.slice(8).join(' '), staged: xy[0] ?? '.', unstaged: xy[1] ?? '.' });
    } else if (e.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next entry
      const parts = e.split(' ');
      const xy = parts[1] ?? '..';
      const from = entries[i + 1] ?? '';
      i++;
      out.files.push({ path: parts.slice(9).join(' '), staged: xy[0] ?? '.', unstaged: xy[1] ?? '.', from });
    } else if (e.startsWith('u ')) {
      const parts = e.split(' ');
      out.files.push({ path: parts.slice(10).join(' '), staged: 'U', unstaged: 'U' });
    } else if (e.startsWith('? ')) out.files.push({ path: e.slice(2), staged: '?', unstaged: '?' });
  }
  return out;
}

/** Which multi-step operation is half done, from the files git leaves in .git. */
export async function operationOf(root: string): Promise<RepoStatus['operation']> {
  const r = await runGit(root, ['rev-parse', '--absolute-git-dir'], { timeoutMs: 5_000 });
  if (r.code !== 0) return null;
  const dir = r.stdout.trim();
  if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert';
  return null;
}

export async function readStatus(root: string, signal?: AbortSignal): Promise<RepoStatus> {
  const [status, remotesRaw, operation] = await Promise.all([
    // --no-optional-locks: a status check must never block the person's own git.
    git(
      root,
      ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'],
      {
        timeoutMs: 15_000,
        ...(signal && { signal }),
      },
    ),
    git(root, ['remote', '-v'], { timeoutMs: 5_000 }),
    operationOf(root),
  ]);
  const remotes = new Map<string, string>();
  for (const line of remotesRaw.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m?.[1] && m[2]) remotes.set(m[1], m[2]);
  }
  const list = [...remotes].map(([name, url]) => ({ name, url: redactUrl(url) }));
  const primary = remotes.get('origin') ?? [...remotes.values()][0];
  return {
    ...parseStatus(status),
    operation,
    remotes: list,
    github: primary ? parseGitHub(primary) : null,
    checked_at: new Date().toISOString(),
  };
}

/** A remote URL without any password or token in it. */
export function redactUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
}

const LOG_FORMAT = '%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e';

export async function readLog(
  root: string,
  opts: { limit?: number; ref?: string } = {},
): Promise<CommitInfo[]> {
  const args = [
    'log',
    `--max-count=${Math.min(Math.max(opts.limit ?? 20, 1), 200)}`,
    `--format=${LOG_FORMAT}`,
  ];
  if (opts.ref) args.push(safeRef(opts.ref), '--');
  const r = await runGit(root, args, { timeoutMs: 15_000 });
  // A repository with no commits yet has no log.
  if (r.code !== 0) return [];
  return r.stdout
    .split('\x1e')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [sha = '', short = '', subject = '', author = '', at = ''] = x.split('\x1f');
      return { sha, short, subject, author, at };
    });
}

export async function readBranches(root: string): Promise<BranchInfo[]> {
  const raw = await git(
    root,
    ['for-each-ref', '--format=%(refname)%1f%(HEAD)%1f%(upstream:short)', 'refs/heads', 'refs/remotes'],
    { timeoutMs: 10_000 },
  );
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref = '', head = '', upstream = ''] = l.split('\x1f');
      const remote = ref.startsWith('refs/remotes/');
      return {
        name: ref.replace(/^refs\/(heads|remotes)\//, ''),
        current: head === '*',
        upstream: upstream || null,
        remote,
      };
    })
    .filter((b) => !b.name.endsWith('/HEAD'));
}

/**
 * A branch or ref name we are willing to hand to git: nothing that git
 * could read as an option, and nothing `git check-ref-format` refuses.
 */
export function safeRef(name: string): string {
  const n = name.trim();
  if (
    !n ||
    n.startsWith('-') ||
    n.length > 200 ||
    /[\s~^:?*[\\\0]|\.\.|@\{|\/\/|\.lock$|^\/|\/$|\.$/.test(n) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we refuse
    /[\x00-\x1f\x7f]/.test(n)
  )
    throw new AncileError({
      code: 'repo.bad_ref',
      title: `"${n.slice(0, 60)}" is not a branch name git accepts`,
      hint: 'Use letters, numbers, dashes, dots and slashes, like feature/login-fix.',
      status: 400,
      errorClass: 'permanent',
    });
  return n;
}

/** A path inside the repository as git wants it; nothing that escapes the root or reads as an option. */
export function safePath(p: string): string {
  const n = p.replace(/\\/g, '/').trim();
  if (!n || n.startsWith('-') || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').includes('..'))
    throw new AncileError({
      code: 'repo.bad_path',
      title: 'That path is not inside the repository',
      hint: 'Give a path relative to the repository root, like src/app.ts.',
      status: 400,
      errorClass: 'permanent',
      detail: n.slice(0, 200),
    });
  return n;
}
