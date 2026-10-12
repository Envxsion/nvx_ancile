/**
 * ------------------------------------------------------------------
 *  Title    |  One repository in two folders
 *  Ref      |  docs/claude-code.md (One repository in two folders)
 *           |  · contracts claudecode.ts (SameRepo*) · migrations/0030
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Claude Code sessions come into a notebook per folder, so
 *           |  one repository opened from two folders (a git worktree,
 *           |  a WSL path and its Windows path, another casing, a link)
 *           |  gives two notebooks. Notice it, and let the person
 *           |  choose: show the two together, or keep them apart. Never
 *           |  merge by itself.
 *  How      |  Each bound folder gets an identity: its path as the OS
 *           |  compares it (realpath, case on Windows, a WSL UNC path
 *           |  \\wsl$\<distro>\home\x and /home/x as one, /mnt/c/x and
 *           |  C:\x as one), and, read-only from git, the repository's
 *           |  common directory (shared by every worktree), its first
 *           |  commit and its origin remote. Two notebooks match when a
 *           |  folder of each resolves to one path (same_folder), one
 *           |  git common directory (worktree), or the same first commit
 *           |  and remote (same_history). Identities are cached for a
 *           |  few minutes. The person's choice is kept per pair.
 *  Note     |  git runs with optional locks off, argv only, a hidden
 *           |  window and a short deadline; it never writes. A folder
 *           |  that is not there only has its path compared.
 *           |  TODO(phase-3): "Merge notebooks" once notebook merge
 *           |  exists (track C); until then, "Show together".
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { NotebookLinks, SameRepoList, SameRepoMatch, SameRepoReason } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { notFound } from '../obs/errors';
import { logFor } from '../obs/logger';
import type { ProjectBinding } from './store';

const log = logFor('claude-code-same-repo');

/** How long a folder's identity is trusted before it is read again. */
export const IDENTITY_TTL_MS = 5 * 60_000;
const GIT_DEADLINE_MS = 4_000;

/**
 * A folder path as one key across the ways it can be written: on Windows
 * and in WSL, a WSL UNC path and its Linux path are one, /mnt/<d>/x and
 * <d>:\x are one, and Windows paths ignore case and slash direction.
 */
export function pathKey(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  const unc = /^\/\/wsl(?:\$|\.localhost)\/[^/]+(\/.*)?$/i.exec(s);
  if (unc) s = unc[1] || '/';
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (mnt) s = `${mnt[1]}:${mnt[2] ?? '/'}`;
  const drive = /^([a-zA-Z]):(\/.*)?$/.exec(s);
  if (drive) {
    const rest = (drive[2] ?? '/').replace(/\/+/g, '/').replace(/\/$/, '') || '';
    return `win:${drive[1]?.toLowerCase()}:${rest.toLowerCase() || '/'}`;
  }
  s = s.replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return `posix:${s}`;
}

/** A remote URL as one key: scheme, user, ".git" and case of the host do not matter. */
export function remoteKey(url: string): string {
  let u = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  const [host = '', ...rest] = u.split('/');
  return `${host.toLowerCase().replace(/:\d+$/, '')}/${rest.join('/')}`
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '');
}

export interface FolderIdentity {
  cwd: string;
  /** Every way this folder's path is written, as keys (as recorded, and resolved). */
  paths: string[];
  /** The repository's common git directory, as a key; one for every worktree of it. */
  gitCommon: string | null;
  firstCommit: string | null;
  remote: string | null;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

/** git, read-only: argv only, optional locks off, a hidden window, a short deadline. Null on any failure. */
export const runGit: GitRunner = (cwd, args) =>
  new Promise((done) => {
    try {
      execFile(
        'git',
        ['-C', cwd, ...args],
        {
          timeout: GIT_DEADLINE_MS,
          windowsHide: true,
          maxBuffer: 256 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        },
        (err, stdout) => done(err ? null : String(stdout).trim()),
      );
    } catch {
      done(null);
    }
  });

const real = async (p: string): Promise<string | null> => realpath(p).catch(() => null);

/** What a folder is: its path keys and, from git, which repository it belongs to. */
export async function folderIdentity(cwd: string, git: GitRunner = runGit): Promise<FolderIdentity> {
  const paths = new Set([pathKey(cwd)]);
  const r = await real(cwd);
  if (r) paths.add(pathKey(r));
  const out: FolderIdentity = { cwd, paths: [...paths], gitCommon: null, firstCommit: null, remote: null };
  if (!r) return out;
  const common = await git(r, ['rev-parse', '--git-common-dir']);
  if (!common) return out;
  const abs = isAbsolute(common) ? common : resolve(r, common);
  out.gitCommon = pathKey((await real(abs)) ?? abs);
  const roots = await git(r, ['rev-list', '--max-parents=0', 'HEAD']);
  out.firstCommit =
    roots
      ?.split(/\s+/)
      .filter((x) => /^[0-9a-f]{40,64}$/.test(x))
      .sort()[0] ?? null;
  const remote = await git(r, ['config', '--get', 'remote.origin.url']);
  out.remote = remote ? remoteKey(remote) : null;
  return out;
}

/** Why two folders are one repository, or null when they are not. */
export function sameRepo(a: FolderIdentity, b: FolderIdentity): SameRepoReason | null {
  if (a.paths.some((p) => b.paths.includes(p))) return 'same_folder';
  if (a.gitCommon && a.gitCommon === b.gitCommon) return 'worktree';
  if (a.firstCommit && a.remote && a.firstCommit === b.firstCommit && a.remote === b.remote)
    return 'same_history';
  return null;
}

/* ---- the person's choices ------------------------------------------------- */

export type PairChoice = 'keep_apart' | 'show_together';

export interface RepoPairStore {
  all(): Promise<{ a: string; b: string; choice: PairChoice }[]>;
  set(a: string, b: string, choice: PairChoice): Promise<void>;
}

const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export class PgRepoPairStore implements RepoPairStore {
  constructor(private readonly sql: Sql) {}
  async all() {
    const rows = await this.sql<{ notebook_a: string; notebook_b: string; choice: PairChoice }[]>`
      select notebook_a, notebook_b, choice from core.claude_code_repo_pairs`;
    return rows.map((r) => ({ a: r.notebook_a, b: r.notebook_b, choice: r.choice }));
  }
  async set(x: string, y: string, choice: PairChoice) {
    const [a, b] = ordered(x, y);
    await this.sql`
      insert into core.claude_code_repo_pairs (notebook_a, notebook_b, choice)
      values (${a}, ${b}, ${choice})
      on conflict (notebook_a, notebook_b) do update set choice = excluded.choice, decided_at = now()`;
  }
}

export class MemoryRepoPairStore implements RepoPairStore {
  readonly rows = new Map<string, { a: string; b: string; choice: PairChoice }>();
  async all() {
    return [...this.rows.values()];
  }
  async set(x: string, y: string, choice: PairChoice) {
    const [a, b] = ordered(x, y);
    this.rows.set(`${a}|${b}`, { a, b, choice });
  }
}

/* ---- matches -------------------------------------------------------------- */

export interface SameRepoDeps {
  projects(): Promise<ProjectBinding[]>;
  /** A live notebook's title; null for one deleted or archived. */
  notebook(id: string): Promise<{ title: string } | null>;
  pairs: RepoPairStore;
  identity?: (cwd: string) => Promise<FolderIdentity>;
  now?: () => number;
  /** Notebooks can be merged here (notebooks/merge.ts): the Cockpit offers "Merge notebooks". */
  canMerge?: boolean;
}

export class SameRepoFinder {
  private readonly cache = new Map<string, { at: number; id: FolderIdentity }>();
  private readonly now: () => number;
  constructor(private readonly deps: SameRepoDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async identity(cwd: string): Promise<FolderIdentity> {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < IDENTITY_TTL_MS) return hit.id;
    const id = await (this.deps.identity ?? ((c: string) => folderIdentity(c)))(cwd).catch(
      (): FolderIdentity => ({
        cwd,
        paths: [pathKey(cwd)],
        gitCommon: null,
        firstCommit: null,
        remote: null,
      }),
    );
    this.cache.set(cwd, { at: this.now(), id });
    return id;
  }

  /** Every other notebook whose folder is the same repository as one of this notebook's. */
  private async raw(notebookId: string): Promise<Omit<SameRepoMatch, 'together'>[]> {
    const projects = await this.deps.projects();
    const mine = projects.filter((p) => p.notebook_id === notebookId);
    if (!mine.length) return [];
    const others = projects.filter((p) => p.notebook_id !== notebookId);
    const found = new Map<string, Omit<SameRepoMatch, 'together'>>();
    const rank: Record<SameRepoReason, number> = { same_folder: 0, worktree: 1, same_history: 2 };
    for (const m of mine) {
      const a = await this.identity(m.cwd);
      for (const o of others) {
        const reason = sameRepo(a, await this.identity(o.cwd));
        if (!reason) continue;
        const had = found.get(o.notebook_id);
        if (had && rank[had.reason] <= rank[reason]) continue;
        const nb = await this.deps.notebook(o.notebook_id);
        if (!nb) continue;
        found.set(o.notebook_id, {
          notebook_id: o.notebook_id,
          title: nb.title,
          reason,
          cwd: m.cwd,
          other_cwd: o.cwd,
        });
      }
    }
    return [...found.values()];
  }

  /** The matches to show on this notebook: those the person kept apart are left out. */
  async matchesFor(notebookId: string): Promise<SameRepoList> {
    const [raw, pairs] = await Promise.all([this.raw(notebookId), this.deps.pairs.all()]);
    const choice = (other: string) => {
      const [a, b] = ordered(notebookId, other);
      return pairs.find((p) => p.a === a && p.b === b)?.choice ?? null;
    };
    const items = raw
      .filter((m) => choice(m.notebook_id) !== 'keep_apart')
      .map((m) => ({ ...m, together: choice(m.notebook_id) === 'show_together' }));
    if (items.length)
      log.info({ notebook_id: notebookId, matches: items.length }, 'notebooks that are one repository');
    // Track C: merging is offered where the merge API is wired (GET /notebooks/:id/merge-preview).
    return { items, can_merge: this.deps.canMerge ?? false };
  }

  /** "Keep apart" or "Show together", remembered for the pair; only for a pair that matches. */
  async choose(notebookId: string, other: string, choice: PairChoice): Promise<SameRepoList> {
    const raw = await this.raw(notebookId);
    if (!raw.some((m) => m.notebook_id === other)) throw notFound('That notebook in the same repository');
    await this.deps.pairs.set(notebookId, other, choice);
    return this.matchesFor(notebookId);
  }

  /** Notebooks shown together, joined into groups (a shown with b, b with c: one group). */
  async links(): Promise<NotebookLinks> {
    const pairs = (await this.deps.pairs.all()).filter((p) => p.choice === 'show_together');
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p === x) return x;
      const r = find(p);
      parent.set(x, r);
      return r;
    };
    for (const { a, b } of pairs) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    }
    const groups = new Map<string, string[]>();
    for (const id of new Set(pairs.flatMap((p) => [p.a, p.b]))) {
      const live = await this.deps.notebook(id);
      if (!live) continue;
      const g = groups.get(find(id)) ?? [];
      g.push(id);
      groups.set(find(id), g);
    }
    return { groups: [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort()) };
  }
}
