/**
 * ------------------------------------------------------------------
 *  Title    |  Repositories
 *  Ref      |  DESIGN.md §17 · docs/repos.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The git folders NVX Ancile works with: which exist,
 *           |  which notebook or thread each belongs to, what state
 *           |  each is in, and the operations a person (or a tool,
 *           |  after the permission gate) may run on them.
 *  How      |  The list and links live in the settings store (one
 *           |  record, single user). A poll every few seconds reads
 *           |  each repository's status and publishes repo.changed
 *           |  when the branch, ahead/behind or changed count moves;
 *           |  a branch switch made outside NVX Ancile also raises a
 *           |  notification, the way an editor notices `git switch`.
 *  Note     |  Links are kept in memory too, so a tool's permission
 *           |  resource (a synchronous function) can name the repo a
 *           |  thread uses without a database round trip.
 * ------------------------------------------------------------------
 */

import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  AncileError,
  type BranchInfo,
  type CommitInfo,
  type RepoActionRequest,
  type RepoInfo,
  type RepoStatus,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { SettingsStore } from '../settings';
import { git, readBranches, readLog, readStatus, repoRootOf, runGit, safePath, safeRef } from './git';

const log = logFor('repos');
export const REPOS_SETTING = 'repos.registry';

export interface RepoRecord {
  id: string;
  name: string;
  root: string;
  created_at: string;
}

interface Registry {
  repos: RepoRecord[];
  links: { notebook: Record<string, string>; thread: Record<string, string> };
}

const EMPTY: Registry = { repos: [], links: { notebook: {}, thread: {} } };

export interface RepoScope {
  threadId?: string | null;
  notebookId?: string | null;
}

const MAX_DIFF = 400 * 1024;

export class RepoService {
  private reg: Registry = structuredClone(EMPTY);
  private loaded = false;
  private readonly statuses = new Map<string, { status: RepoStatus | null; error: string | null }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      bus?: EventBus;
      /** How often to look at each repository; 0 turns the watcher off (tests). */
      pollMs?: number;
    },
  ) {}

  async load(): Promise<void> {
    const saved = await this.deps.settings.get<Registry>(REPOS_SETTING);
    this.reg = {
      repos: saved?.repos ?? [],
      links: { notebook: saved?.links?.notebook ?? {}, thread: saved?.links?.thread ?? {} },
    };
    this.loaded = true;
  }

  private async ensure() {
    if (!this.loaded) await this.load();
  }

  private async save() {
    await this.deps.settings.set(REPOS_SETTING, this.reg);
  }

  start(): void {
    const ms = this.deps.pollMs ?? 5_000;
    if (ms <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.pollAll(), ms);
    this.timer.unref?.();
    void this.pollAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read every repository once; publish what moved. */
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.ensure();
      for (const r of this.reg.repos) await this.refresh(r.id).catch(() => undefined);
    } finally {
      this.polling = false;
    }
  }

  async list(): Promise<RepoInfo[]> {
    await this.ensure();
    return this.reg.repos.map((r) => this.info(r));
  }

  private info(r: RepoRecord): RepoInfo {
    const s = this.statuses.get(r.id);
    return { ...r, status: s?.status ?? null, error: s?.error ?? null };
  }

  /** A repository by id or by name (models are told names). */
  async get(idOrName: string): Promise<RepoRecord> {
    await this.ensure();
    const want = idOrName.trim().toLowerCase();
    const r =
      this.reg.repos.find((x) => x.id === idOrName) ??
      this.reg.repos.find((x) => x.name.toLowerCase() === want);
    if (!r)
      throw new AncileError({
        code: 'repo.not_found',
        title: `There is no repository called ${idOrName.slice(0, 80)}`,
        hint: 'Add the folder in the Repo panel first, or check the name.',
        status: 404,
        errorClass: 'permanent',
      });
    return r;
  }

  async add(path: string, name?: string): Promise<RepoInfo> {
    await this.ensure();
    const root = await repoRootOf(path.trim());
    if (!root)
      throw new AncileError({
        code: 'repo.not_a_repo',
        title: 'That folder is not a git repository',
        hint: 'Choose the folder you cloned (the one with a .git folder), or run `git init` in it first.',
        status: 400,
        errorClass: 'permanent',
        detail: path.slice(0, 300),
      });
    const real = await realpath(root).catch(() => root);
    const existing = this.reg.repos.find((r) => samePath(r.root, real));
    if (existing) return this.info(existing);
    const base = (name?.trim() || basename(real)).slice(0, 80);
    let unique = base;
    for (let i = 2; this.reg.repos.some((r) => r.name.toLowerCase() === unique.toLowerCase()); i++)
      unique = `${base}-${i}`;
    const rec: RepoRecord = {
      id: `repo_${ulid()}`,
      name: unique,
      root: real,
      created_at: new Date().toISOString(),
    };
    this.reg.repos.push(rec);
    await this.save();
    await this.refresh(rec.id, { quiet: true }).catch(() => undefined);
    return this.info(rec);
  }

  async remove(id: string): Promise<void> {
    await this.ensure();
    const r = await this.get(id);
    this.reg.repos = this.reg.repos.filter((x) => x.id !== r.id);
    for (const scope of ['notebook', 'thread'] as const)
      for (const [k, v] of Object.entries(this.reg.links[scope]))
        if (v === r.id) delete this.reg.links[scope][k];
    this.statuses.delete(r.id);
    await this.save();
  }

  async link(scope: 'notebook' | 'thread', ref: string, repoId: string | null): Promise<void> {
    await this.ensure();
    if (repoId === null) delete this.reg.links[scope][ref];
    else this.reg.links[scope][ref] = (await this.get(repoId)).id;
    await this.save();
  }

  /** The repository a thread works in: its own link, else its notebook's. Synchronous for permission resources. */
  linkedId(scope: RepoScope | undefined): string | null {
    if (!scope) return null;
    const t = scope.threadId ? this.reg.links.thread[scope.threadId] : undefined;
    const n = scope.notebookId ? this.reg.links.notebook[scope.notebookId] : undefined;
    const id = t ?? n ?? null;
    return id && this.reg.repos.some((r) => r.id === id) ? id : null;
  }

  async linkedFor(scope: RepoScope): Promise<RepoInfo | null> {
    await this.ensure();
    const id = this.linkedId(scope);
    const r = id ? this.reg.repos.find((x) => x.id === id) : undefined;
    return r ? this.info(r) : null;
  }

  /** Synchronous name lookup for permission resources. */
  nameOf(id: string): string | null {
    return this.reg.repos.find((r) => r.id === id)?.name ?? null;
  }

  /** The repository a tool call means: the one it names, else the thread's linked one. */
  async resolve(named: unknown, scope?: RepoScope): Promise<RepoRecord> {
    if (typeof named === 'string' && named.trim()) return this.get(named);
    await this.ensure();
    const id = this.linkedId(scope);
    if (id) return this.get(id);
    if (this.reg.repos.length === 1) return this.reg.repos[0] as RepoRecord;
    throw new AncileError({
      code: 'repo.not_linked',
      title: 'Which repository?',
      hint:
        this.reg.repos.length === 0
          ? 'Add a repository first: open the Repo panel, or Link a repository in the palette.'
          : `Link this thread to one, or name it: ${this.reg.repos.map((r) => r.name).join(', ')}.`,
      status: 400,
      errorClass: 'permanent',
    });
  }

  /** Synchronous best guess of the repo name a call will act on, for its permission resource. */
  resourceName(named: unknown, scope?: RepoScope): string {
    if (typeof named === 'string' && named.trim()) {
      const want = named.trim().toLowerCase();
      const r = this.reg.repos.find((x) => x.id === named || x.name.toLowerCase() === want);
      return r?.name ?? named.trim();
    }
    const id = this.linkedId(scope);
    if (id) return this.nameOf(id) ?? id;
    if (this.reg.repos.length === 1) return (this.reg.repos[0] as RepoRecord).name;
    return 'unknown';
  }

  async status(id: string): Promise<RepoStatus> {
    const s = await this.refresh(id);
    if (!s) throw this.gone(id);
    return s;
  }

  private gone(id: string): AncileError {
    return new AncileError({
      code: 'repo.unavailable',
      title: 'That repository cannot be read now',
      hint: 'The folder may have moved or been deleted. Remove it and add it again.',
      status: 409,
      errorClass: 'permanent',
      detail: this.statuses.get(id)?.error ?? undefined,
    });
  }

  /** Read status now; publish repo.changed (and a notice on a branch switch) when it moved. */
  async refresh(id: string, opts: { quiet?: boolean } = {}): Promise<RepoStatus | null> {
    const r = await this.get(id);
    const prev = this.statuses.get(r.id)?.status ?? null;
    let next: RepoStatus | null = null;
    try {
      next = await readStatus(r.root);
      this.statuses.set(r.id, { status: next, error: null });
    } catch (err) {
      this.statuses.set(r.id, { status: null, error: (err as Error).message.slice(0, 300) });
      if (prev) log.warn({ repo: r.name, err }, 'repository could not be read');
      return null;
    }
    const moved =
      !prev ||
      prev.branch !== next.branch ||
      prev.ahead !== next.ahead ||
      prev.behind !== next.behind ||
      prev.files.length !== next.files.length ||
      prev.head !== next.head;
    if (moved && !opts.quiet) {
      await this.deps.bus
        ?.publish({
          type: 'repo.changed',
          repo_id: r.id,
          branch: next.branch,
          ...(prev && prev.branch !== next.branch && { previous_branch: prev.branch }),
          ahead: next.ahead,
          behind: next.behind,
          changed: next.files.length,
        })
        .catch(() => undefined);
      if (prev && prev.branch !== next.branch)
        await this.deps.bus
          ?.publish({
            type: 'notification',
            id: `ntf_${ulid()}`,
            level: 'info',
            title: next.branch ? `${r.name} is on ${next.branch} now` : `${r.name} is on a detached commit`,
            body: prev.branch ? `It was on ${prev.branch}.` : undefined,
          })
          .catch(() => undefined);
    }
    return next;
  }

  async log(id: string, limit?: number): Promise<CommitInfo[]> {
    const r = await this.get(id);
    return readLog(r.root, { ...(limit && { limit }) });
  }

  async branches(id: string): Promise<BranchInfo[]> {
    const r = await this.get(id);
    return readBranches(r.root);
  }

  /** The diff of the work tree (or of what is staged), for one file or all, capped. */
  async diff(
    id: string,
    opts: { path?: string; staged?: boolean } = {},
  ): Promise<{ diff: string; truncated: boolean }> {
    const r = await this.get(id);
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (opts.staged) args.push('--cached');
    args.push('--');
    if (opts.path) args.push(safePath(opts.path));
    const res = await runGit(r.root, args, { maxBytes: MAX_DIFF, timeoutMs: 20_000 });
    let text = res.stdout;
    // An untracked file has no diff against the index: show it as new.
    if (!text && opts.path && !opts.staged) {
      const s = await this.status(r.id);
      const f = s.files.find((x) => x.path === opts.path && x.staged === '?');
      if (f) {
        const nf = await runGit(
          r.root,
          ['diff', '--no-index', '--no-color', '--', nullDevice(), safePath(f.path)],
          {
            maxBytes: MAX_DIFF,
          },
        );
        text = nf.stdout;
      }
    }
    return { diff: text, truncated: res.truncated };
  }

  /** A short summary of what a commit would contain, for an approval or a suggested message. */
  async stagedSummary(id: string): Promise<{ files: string[]; stat: string }> {
    const r = await this.get(id);
    const stat = await git(r.root, ['diff', '--cached', '--stat', '--no-color'], { timeoutMs: 10_000 });
    const names = await git(r.root, ['diff', '--cached', '--name-only', '-z'], { timeoutMs: 10_000 });
    return { files: names.split('\0').filter(Boolean), stat: stat.trim() };
  }

  /** Run one operation a person chose in the Repo panel, or a tool after its approval. */
  async act(id: string, req: RepoActionRequest, signal?: AbortSignal): Promise<{ ok: true; output: string }> {
    const r = await this.get(id);
    const net = { timeoutMs: 120_000, ...(signal && { signal }) };
    let out = '';
    switch (req.op) {
      case 'stage':
        out = await git(r.root, ['add', '--', ...req.paths.map(safePath)]);
        break;
      case 'unstage':
        out = await git(r.root, ['restore', '--staged', '--', ...req.paths.map(safePath)]);
        break;
      case 'commit': {
        if (req.all) await git(r.root, ['add', '--all']);
        // The message goes in on stdin: no quoting, no shell, any text.
        out = await git(r.root, ['commit', '--file=-', '--cleanup=strip'], { input: req.message });
        break;
      }
      case 'switch':
        out = await git(
          r.root,
          req.create ? ['switch', '-c', safeRef(req.branch)] : ['switch', safeRef(req.branch)],
        );
        break;
      case 'pull':
        // Never a surprise merge commit: fast-forward only, and say so when it cannot.
        out = await git(r.root, ['pull', '--ff-only'], net);
        break;
      case 'fetch':
        out = await git(r.root, ['fetch', '--prune'], net);
        break;
      case 'push': {
        const s = await this.status(r.id);
        if (!s.branch)
          throw new AncileError({
            code: 'repo.detached',
            title: 'There is no branch to push',
            hint: 'Switch to a branch (or create one) first.',
            status: 409,
            errorClass: 'permanent',
          });
        const args =
          s.upstream && !req.set_upstream
            ? ['push']
            : ['push', '--set-upstream', 'origin', safeRef(s.branch)];
        out = await git(r.root, args, net);
        break;
      }
      case 'stash':
        out = await git(r.root, [
          'stash',
          'push',
          '--include-untracked',
          ...(req.message ? ['-m', req.message] : []),
        ]);
        break;
      case 'stash_pop':
        out = await git(r.root, ['stash', 'pop']);
        break;
    }
    await this.refresh(r.id).catch(() => undefined);
    return { ok: true, output: out.trim().slice(0, 4_000) };
  }

  /** Push with --force-with-lease: only through its own critical tool, never from a plain push. */
  async forcePushWithLease(id: string, signal?: AbortSignal): Promise<string> {
    const r = await this.get(id);
    const s = await this.status(r.id);
    if (!s.branch || !s.upstream)
      throw new AncileError({
        code: 'repo.detached',
        title: 'There is no tracked branch to push',
        hint: 'Push it normally first, so it has an upstream.',
        status: 409,
        errorClass: 'permanent',
      });
    const out = await git(r.root, ['push', '--force-with-lease'], {
      timeoutMs: 120_000,
      ...(signal && { signal }),
    });
    await this.refresh(r.id).catch(() => undefined);
    return out;
  }

  async root(id: string): Promise<string> {
    return (await this.get(id)).root;
  }
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? n(a).toLowerCase() === n(b).toLowerCase()
    : n(a) === n(b);
}

/** git treats this name as "no file" on every platform, Windows included. */
function nullDevice(): string {
  return '/dev/null';
}
