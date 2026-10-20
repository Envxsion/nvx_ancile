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
 *           |  index is not safe to share). Anything that reads a file
 *           |  to change it (update, writeMany) does so inside that queue,
 *           |  so two writers never build on the same old text, and a
 *           |  write that git refuses puts the files back as they were.
 *           |  write() is for an edit made elsewhere: it checks
 *           |  baseVersion (the file's last commit) and, if a change
 *           |  landed in between, tries a three-way merge with
 *           |  `git merge-file` before giving up with MemoryConflict,
 *           |  which carries both sides with conflict markers.
 *  Note     |  The repository keeps bytes as written (autocrlf off), so a
 *           |  hand-edited CRLF file stays CRLF. Paths are checked
 *           |  before they touch the disk: relative, inside the root,
 *           |  markdown only, never .git.
 *           |  The backup push is the memory_backup automation
 *           |  (automations/jobs.ts), not this module.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/** A git config value, quoted, with backslashes and quotes escaped and no line breaks. */
const configValue = (v: string) => `"${v.replace(/[\r\n]+/g, ' ').replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** What a memory repository sets for itself: byte-exact files, the author, no signing. */
export function gitConfig(author: { name: string; email: string }): string {
  return [
    '[core]',
    '\tautocrlf = false',
    '\tsafecrlf = false',
    '[user]',
    `\tname = ${configValue(author.name)}`,
    `\temail = ${configValue(author.email)}`,
    '[commit]',
    '\tgpgsign = false',
    '',
  ].join('\n');
}

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
        // The repository's own settings, written into .git/config directly
        // rather than with five `git config` processes: each process costs
        // 100 ms or more on Windows, and seconds when the machine is busy,
        // which made creating a repository (tests, first boot) time out.
        // A repeated [core] section is valid git config; the last value wins.
        await appendFile(join(this.root, '.git', 'config'), gitConfig(this.author));
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
    // The version first, then the text. A commit landing between the two gives newer text with
    // an older version, which a later save() merges cleanly (both sides hold that change); the
    // other order gives older text with a newer version, and a save() built on it would silently
    // undo the commit that landed in between.
    const committed = (await this.lastCommitOf(p)) ?? 'uncommitted';
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
    return { content, version: committed };
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
      await this.commitFiles([{ path, before: onDisk, after: content }], change.message, change.author);
      return { version: (await this.lastCommitOf(path)) as string, merged, changed: true };
    });
  }

  /**
   * Read a file, change it and commit it as one step inside the write queue: `change` is given
   * the file's text now (null: not there yet) and answers the new text, or null to leave it.
   * For a change that builds on what is already there (add an entry, update one), so that no
   * writer works from text another writer has since replaced. `change` must not call anything
   * that waits on this queue (write, update, writeMany, remove, revert); read() is fine.
   */
  async update(
    path: string,
    change: (current: {
      content: string | null;
      version: string | null;
    }) => Promise<string | null> | string | null,
    message: string,
    author: { name: string; email: string },
  ): Promise<{ version: string; changed: boolean }> {
    await this.ensure();
    const p = safeMemoryPath(path);
    return this.serial(async () => {
      const onDisk = await readFile(this.abs(p), 'utf8').catch(() => null);
      const version = onDisk === null ? null : await this.lastCommitOf(p);
      const next = await change({ content: onDisk, version });
      if (next === null || next === onDisk)
        return { version: version ?? (await this.head()), changed: false };
      await this.commitFiles([{ path: p, before: onDisk, after: next }], message, author);
      return { version: (await this.lastCommitOf(p)) as string, changed: true };
    });
  }

  /**
   * Write the files and commit them. If git refuses (a lock held by another program, a full disk),
   * the files go back to what they were and nothing stays staged, so the failed write leaves no
   * trace for the next writer to commit by accident. Call inside the write queue.
   */
  private async commitFiles(
    files: { path: string; before: string | null; after: string }[],
    message: string,
    author: { name: string; email: string },
  ): Promise<void> {
    const paths = files.map((f) => f.path);
    try {
      for (const f of files) {
        const file = this.abs(f.path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, f.after, 'utf8');
      }
      await this.git.add(paths);
      await this.git.commit(message, paths, { '--author': `${author.name} <${author.email}>` });
    } catch (err) {
      for (const f of files) {
        const file = this.abs(f.path);
        if (f.before === null) await rm(file, { force: true }).catch(() => undefined);
        else await writeFile(file, f.before, 'utf8').catch(() => undefined);
      }
      await this.git.raw(['reset', '--quiet', '--', ...paths]).catch(() => undefined);
      throw err;
    }
  }

  /** Remove a file in its own commit (history keeps it, so a revert brings it back). */
  async remove(
    path: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<{ version: string }> {
    const p = safeMemoryPath(path);
    // Before the queue, never inside it: ensure() queues too, and would wait for its own caller.
    await this.ensure();
    return this.serial(async () => {
      // History still names a deleted file, so ask the disk.
      const before = await readFile(this.abs(p), 'utf8').catch(() => null);
      if (before === null)
        throw new AncileError({
          code: 'memory.not_found',
          title: `There is no memory file called ${p}`,
          hint: 'Refresh the list of files; it may already be gone.',
          status: 404,
          errorClass: 'permanent',
        });
      try {
        await this.git.rm([p]);
        await this.git.commit(message, [p], { '--author': `${author.name} <${author.email}>` });
      } catch (err) {
        // Put the file back as it was, so the failed delete leaves nothing staged.
        await this.git.raw(['reset', '--quiet', '--', p]).catch(() => undefined);
        await writeFile(this.abs(p), before, 'utf8').catch(() => undefined);
        throw err;
      }
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
  async revert(
    sha: string,
    author: { name: string; email: string },
    message?: string,
  ): Promise<{ version: string }> {
    if (!SHA.test(sha)) throw badVersion(sha);
    // Before the queue, never inside it: ensure() queues too, and would wait for its own caller.
    await this.ensure();
    return this.serial(async () => {
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

  /**
   * Several files in one commit (an import accepted all at once). `change`
   * runs inside the write queue with each file's text now (null: not there
   * yet), so nothing written meanwhile is lost; it answers the new text by
   * path. Files whose text did not change are left out of the commit.
   */
  async writeMany(
    paths: string[],
    change: (current: Map<string, string | null>) => Promise<Map<string, string>> | Map<string, string>,
    message: string,
    author: { name: string; email: string },
  ): Promise<{ version: string; changed: string[] }> {
    await this.ensure();
    const safe = [...new Set(paths.map((p) => safeMemoryPath(p)))];
    return this.serial(async () => {
      const current = new Map<string, string | null>();
      for (const p of safe) current.set(p, await readFile(this.abs(p), 'utf8').catch(() => null));
      const next = await change(current);
      const files: { path: string; before: string | null; after: string }[] = [];
      for (const [p, content] of next) {
        if (!current.has(p)) throw badPath(p);
        if (current.get(p) === content) continue;
        files.push({ path: p, before: current.get(p) ?? null, after: content });
      }
      if (files.length) await this.commitFiles(files, message, author);
      return { version: (await this.git.revparse(['HEAD'])).trim(), changed: files.map((f) => f.path) };
    });
  }

  /** The files as committed now, as a zip (git archive); only `paths` when given. */
  async archiveZip(paths?: string[]): Promise<Buffer> {
    await this.ensure();
    const args = ['archive', '--format=zip', 'HEAD'];
    if (paths) args.push('--', ...paths.map((p) => safeMemoryPath(p)));
    const { stdout } = await run('git', args, {
      cwd: this.root,
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024,
    });
    return stdout;
  }

  /** The whole repository, history included, as one file (git bundle). */
  async bundle(): Promise<Buffer> {
    await this.ensure();
    const dir = await mkdtemp(join(tmpdir(), 'ancile-bundle-'));
    try {
      const file = join(dir, 'memory.bundle');
      await run('git', ['bundle', 'create', file, '--all'], { cwd: this.root });
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
