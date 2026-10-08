/**
 * ------------------------------------------------------------------
 *  Title    |  Memory repository (git)
 *  Ref      |  DESIGN.md §6.1, §6.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The built-in MemoryProvider: markdown files in their own
 *           |  git repository under ANCILE_DATA_DIR/memory. Every change
 *           |  is a commit with a meaningful message; history, diff and
 *           |  revert come from git itself.
 *  How      |  simple-git, one write at a time (a promise queue: git's
 *           |  index is not safe to share). write() checks baseVersion
 *           |  (the file's last commit) and, if a change landed in
 *           |  between, tries a three-way merge with `git merge-file`
 *           |  before giving up with MemoryConflict, which carries both
 *           |  sides with conflict markers for the editor.
 *  Note     |  The repository keeps bytes as written (autocrlf off), so a
 *           |  hand-edited CRLF file stays CRLF. Paths are checked
 *           |  before they touch the disk: relative, inside the root,
 *           |  markdown only, never .git.
 *           |  TODO(phase-5): push to ANCILE_MEMORY_REMOTE on schedule.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { AncileError } from '@nvx/contracts';
import {
  MemoryConflict,
  type MemoryFileInfo,
  type MemoryHistoryEntry,
  type MemoryProvider,
  type MemorySearchHit,
  type MemoryWrite,
} from '@nvx/plugin-sdk';
import { type SimpleGit, simpleGit } from 'simple-git';
import { parseMemory } from './format';

const run = promisify(execFile);

export interface CommitMessage {
  scope: string; // user | agents | project:<slug> | failures | model:<id>
  summary: string;
  body: string[];
  trailers: Record<string, string>;
}

/** memory(user): prefer British spelling\n\nFrom thread …\n\nAncile-Proposal: mpr_… */
export function formatCommitMessage(m: CommitMessage): string {
  const trailers = Object.entries(m.trailers).map(([k, v]) => `${k}: ${v}`);
  return [`memory(${m.scope}): ${m.summary}`, '', ...m.body, ...(trailers.length ? ['', ...trailers] : [])]
    .join('\n')
    .trimEnd();
}

/** Scope for a commit subject, from the file it touches. */
export function scopeOf(path: string): string {
  if (path === 'USER.md') return 'user';
  if (path === 'AGENTS.md') return 'agents';
  const [dir, file = ''] = path.split('/');
  const name = file.replace(/\.md$/, '');
  if (dir === 'PROJECTS') return `project:${name}`;
  if (dir === 'FAILURES') return 'failures';
  if (dir === 'MODELS') return `model:${name}`;
  return 'memory';
}

const SAFE = /^[A-Za-z0-9_\-. ]+(\/[A-Za-z0-9_\-. ]+)*\.md$/;
/** Names Windows keeps for devices, with any extension: CON.md is the console. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A memory path as stored: forward slashes, relative, markdown, never .git. */
export function safeMemoryPath(p: string): string {
  const path = p.replace(/\\/g, '/').replace(/^\/+/, '');
  const bad =
    !SAFE.test(path) ||
    path
      .split('/')
      .some(
        (seg) =>
          seg === '..' ||
          seg === '.' ||
          seg.startsWith('.') ||
          seg.endsWith('.') ||
          seg.trim() !== seg ||
          DEVICE.test(seg),
      );
  if (bad) throw badPath(p);
  return path;
}

function badPath(p: string): AncileError {
  return new AncileError({
    code: 'memory.bad_path',
    title: 'That is not a memory file',
    hint: 'Memory files are markdown files inside the memory folder, like USER.md or PROJECTS/grant.md.',
    status: 400,
    errorClass: 'permanent',
    detail: p.slice(0, 200),
  });
}

const SHA = /^[0-9a-f]{7,40}$/;

function badVersion(v: string): AncileError {
  return new AncileError({
    code: 'memory.unknown_version',
    title: 'That version of memory does not exist',
    hint: 'Pick a version from the file history.',
    status: 404,
    errorClass: 'permanent',
    detail: v.slice(0, 60),
  });
}

/** Thrown with both sides when a merge is not clean. */
export class MemoryMergeConflict extends MemoryConflict {
  constructor(
    path: string,
    base: string | null,
    current: string,
    readonly currentContent: string,
    readonly mergedWithMarkers: string,
  ) {
    super(path, base, current);
  }
}

export interface GitMemoryOptions {
  root: string;
  /** Author for automatic changes (DESIGN.md §6.4). */
  author: { name: string; email: string };
  /** Seed for a new repository (memory-template/). */
  template?: string;
}

export class GitMemoryProvider implements MemoryProvider {
  readonly id = 'git';
  readonly root: string;
  readonly author: { name: string; email: string };
  private readonly template: string | undefined;
  private git: SimpleGit;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;

  constructor(opts: GitMemoryOptions) {
    this.root = resolve(opts.root);
    this.author = opts.author;
    this.template = opts.template;
    this.git = simpleGit();
  }

  /** One mutation at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private abs(path: string): string {
    const full = resolve(this.root, safeMemoryPath(path));
    if (!full.startsWith(this.root + sep)) throw badPath(path);
    return full;
  }

  /** Create the repository from the template, once. Safe to call repeatedly. */
  ensure(): Promise<void> {
    this.ready ??= this.serial(async () => {
      await mkdir(this.root, { recursive: true });
      this.git = simpleGit(this.root);
      const isRepo = await stat(join(this.root, '.git'))
        .then(() => true)
        .catch(() => false);
      if (!isRepo) {
        await this.git.init();
        await this.git.addConfig('core.autocrlf', 'false');
        await this.git.addConfig('core.safecrlf', 'false');
        await this.git.addConfig('user.name', this.author.name);
        await this.git.addConfig('user.email', this.author.email);
        await this.git.addConfig('commit.gpgsign', 'false');
        if (this.template) {
          await cp(this.template, this.root, { recursive: true, errorOnExist: false, force: false });
        }
        await writeFile(join(this.root, '.gitattributes'), '* -text\n');
        await this.git.add('.');
        await this.git.commit('memory: start from the template', undefined, {
          '--allow-empty': null,
          '--author': `${this.author.name} <${this.author.email}>`,
        });
      }
    }).catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async head(): Promise<string> {
    await this.ensure();
    return (await this.git.revparse(['HEAD'])).trim();
  }

  /** Last commit that touched each memory file, in one git call. */
  private async lastCommits(): Promise<Map<string, { sha: string; at: string }>> {
    const out = await this.git.raw(['log', '--format=@%H %cI', '--name-only', '--no-renames', '--', '*.md']);
    const map = new Map<string, { sha: string; at: string }>();
    let cur: { sha: string; at: string } | null = null;
    for (const line of out.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith('@')) {
        const [sha = '', at = ''] = l.slice(1).split(' ');
        cur = { sha, at };
      } else if (cur && !map.has(l)) map.set(l, cur);
    }
    return map;
  }

  private async lastCommitOf(path: string): Promise<string | null> {
    const out = (await this.git.raw(['log', '-1', '--format=%H', '--', path])).trim();
    return out || null;
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...(await this.walk(full)));
      else if (ent.name.endsWith('.md')) out.push(relative(this.root, full).split(sep).join('/'));
    }
    return out;
  }

  async list(prefix?: string): Promise<MemoryFileInfo[]> {
    await this.ensure();
    const commits = await this.lastCommits();
    const files = (await this.walk(this.root)).filter((p) => !prefix || p.startsWith(prefix)).sort();
    const out: MemoryFileInfo[] = [];
    for (const path of files) {
      const s = await stat(join(this.root, path));
      const c = commits.get(path);
      out.push({
        path,
        // A file edited by hand on disk and not yet committed still lists.
        version: c?.sha ?? 'uncommitted',
        updatedAt: c?.at ?? s.mtime.toISOString(),
        bytes: s.size,
      });
    }
    return out;
  }

  async exists(path: string): Promise<boolean> {
    await this.ensure();
    return stat(this.abs(path))
      .then((s) => s.isFile())
      .catch(() => false);
  }

  async read(path: string, version?: string): Promise<{ content: string; version: string }> {
    await this.ensure();
    const p = safeMemoryPath(path);
    if (version) {
      if (!SHA.test(version)) throw badVersion(version);
      const content = await this.git.show([`${version}:${p}`]).catch(() => {
        throw badVersion(version);
      });
      return { content, version };
    }
    const content = await readFile(this.abs(p), 'utf8').catch(() => {
      throw new AncileError({
        code: 'memory.not_found',
        title: 'That memory file does not exist',
        hint: 'Open Memory to see the files there are, or create it.',
        status: 404,
        errorClass: 'permanent',
        detail: p,
      });
    });
    return { content, version: (await this.lastCommitOf(p)) ?? 'uncommitted' };
  }

  write(change: MemoryWrite): Promise<{ version: string }> {
    return this.writeDetailed(change).then((r) => ({ version: r.version }));
  }

  /** write(), also saying whether a merge happened and whether anything changed. */
  async writeDetailed(change: MemoryWrite): Promise<{ version: string; merged: boolean; changed: boolean }> {
    await this.ensure();
    const path = safeMemoryPath(change.path);
    return this.serial(async () => {
      const file = this.abs(path);
      const current = await this.lastCommitOf(path);
      const onDisk = await readFile(file, 'utf8').catch(() => null);
      let content = change.content;
      let merged = false;

      if ((change.baseVersion ?? null) !== current && onDisk !== null) {
        // Someone (usually Ancile) changed the file since the edit began.
        const base =
          change.baseVersion && SHA.test(change.baseVersion)
            ? await this.git.show([`${change.baseVersion}:${path}`]).catch(() => '')
            : '';
        const result = await mergeFile(onDisk, base, content);
        if (!result.clean) {
          throw new MemoryMergeConflict(
            path,
            change.baseVersion,
            current ?? 'uncommitted',
            onDisk,
            result.text,
          );
        }
        content = result.text;
        merged = true;
      }

      if (onDisk === content) return { version: current ?? (await this.head()), merged, changed: false };
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      await this.git.add([path]);
      await this.git.commit(change.message, [path], {
        '--author': `${change.author.name} <${change.author.email}>`,
      });
      return { version: (await this.lastCommitOf(path)) as string, merged, changed: true };
    });
  }

  /** Remove a file in its own commit (history keeps it, so a revert brings it back). */
  remove(
    path: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<{ version: string }> {
    const p = safeMemoryPath(path);
    return this.serial(async () => {
      await this.ensure();
      // History still names a deleted file, so ask the disk.
      if ((await readFile(this.abs(p), 'utf8').catch(() => null)) === null)
        throw new AncileError({
          code: 'memory.not_found',
          title: `There is no memory file called ${p}`,
          hint: 'Refresh the list of files; it may already be gone.',
          status: 404,
          errorClass: 'permanent',
        });
      await this.git.rm([p]);
      await this.git.commit(message, [p], { '--author': `${author.name} <${author.email}>` });
      return { version: await this.head() };
    });
  }

  async search(_query: string): Promise<MemorySearchHit[]> {
    // Search runs over the derived index (memory/index.ts), not the files.
    return [];
  }

  async history(path: string, limit = 50): Promise<MemoryHistoryEntry[]> {
    await this.ensure();
    const p = safeMemoryPath(path);
    return this.log(['--', p], limit);
  }

  /** Commits across the whole repository (newest first). */
  async log(args: string[] = [], limit = 50): Promise<(MemoryHistoryEntry & { body: string })[]> {
    await this.ensure();
    const SEP = '\x1e';
    const out = await this.git.raw([
      'log',
      `-n${Math.max(1, Math.min(limit, 500))}`,
      `--format=%H%x1f%cI%x1f%an%x1f%s%x1f%b${SEP}`,
      ...args,
    ]);
    return out
      .split(SEP)
      .map((r) => r.replace(/^\n+/, ''))
      .filter((r) => r.trim())
      .map((r) => {
        const [version = '', at = '', author = '', message = '', body = ''] = r.split('\x1f');
        return { version, at, author, message, body: body.trim() };
      });
  }

  async diff(a: string, b: string, path?: string): Promise<string> {
    await this.ensure();
    for (const v of [a, b]) if (!SHA.test(v)) throw badVersion(v);
    const args = ['diff', '--no-color', a, b];
    if (path) args.push('--', safeMemoryPath(path));
    return this.git.raw(args).catch(() => {
      throw badVersion(`${a}..${b}`);
    });
  }

  /** The parent of a commit (for "what did this commit change"). */
  async parentOf(sha: string): Promise<string | null> {
    if (!SHA.test(sha)) throw badVersion(sha);
    const out = await this.git.raw(['rev-list', '--parents', '-n1', sha]).catch(() => '');
    return out.trim().split(' ')[1] ?? null;
  }

  /** Files a commit touched. */
  async filesOf(sha: string): Promise<string[]> {
    if (!SHA.test(sha)) throw badVersion(sha);
    const out = await this.git.raw(['show', '--name-only', '--format=', sha]).catch(() => {
      throw badVersion(sha);
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** A revert commit; refuses (and leaves the tree clean) if it would conflict. */
  revert(
    sha: string,
    author: { name: string; email: string },
    message?: string,
  ): Promise<{ version: string }> {
    if (!SHA.test(sha)) return Promise.reject(badVersion(sha));
    return this.serial(async () => {
      await this.ensure();
      try {
        await this.git.raw(['revert', '--no-commit', sha]);
      } catch (err) {
        await this.git.raw(['revert', '--abort']).catch(() => undefined);
        await this.git.raw(['reset', '--hard', 'HEAD']).catch(() => undefined);
        throw new AncileError({
          code: 'memory.revert_conflict',
          title: 'That change cannot be undone automatically',
          hint: 'Later edits touched the same lines. Open the file and change it by hand.',
          status: 409,
          errorClass: 'permanent',
          cause: err,
        });
      }
      const subject = (await this.git.raw(['log', '-1', '--format=%s', sha])).trim();
      await this.git.commit(message ?? `Revert "${subject}"\n\nThis reverts commit ${sha}.`, undefined, {
        '--author': `${author.name} <${author.email}>`,
        '--allow-empty': null,
      });
      return { version: await this.head() };
    });
  }

  /** Integrity for diagnostics: git's own check, and every file's front matter parses. */
  async check(): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    try {
      await this.ensure();
      await this.git.raw(['fsck', '--no-progress']);
    } catch (err) {
      problems.push(`git fsck failed: ${(err as Error).message.split('\n')[0]}`);
      return { ok: false, problems };
    }
    for (const path of await this.walk(this.root)) {
      const content = await readFile(join(this.root, path), 'utf8');
      if (content.startsWith('---')) {
        const doc = parseMemory(content);
        if (!doc.frontMatterRaw) problems.push(`${path}: the front matter is not closed with ---`);
        else if (Object.keys(doc.frontMatter).length === 0 && doc.frontMatterRaw.split('\n').length > 3)
          problems.push(`${path}: the front matter is not valid YAML`);
      }
    }
    return { ok: problems.length === 0, problems };
  }
}

/** Three-way merge with `git merge-file -p`: ours = on disk, theirs = the edit. */
export async function mergeFile(
  ours: string,
  base: string,
  theirs: string,
): Promise<{ clean: boolean; text: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ancile-merge-'));
  try {
    const [o, b, t] = ['current', 'base', 'yours'].map((n) => join(dir, n));
    await writeFile(o as string, ours);
    await writeFile(b as string, base);
    await writeFile(t as string, theirs);
    try {
      const { stdout } = await run(
        'git',
        [
          'merge-file',
          '-p',
          '-L',
          'saved meanwhile',
          '-L',
          'base',
          '-L',
          'your edit',
          o as string,
          b as string,
          t as string,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      return { clean: true, text: stdout };
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      // Exit code = number of conflicts; stdout holds the marked-up result.
      if (typeof e.code === 'number' && e.code > 0 && typeof e.stdout === 'string')
        return { clean: false, text: e.stdout };
      throw err;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
