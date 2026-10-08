/**
 * ------------------------------------------------------------------
 *  Title    |  Obsidian vault memory provider (sketch)
 *  Ref      |  packages/plugin-sdk/src/memory.ts, docs/plugins.md
 *  ID       |  plugin:example-memory-provider
 * ------------------------------------------------------------------
 *  Purpose  |  Shows how memory can live somewhere other than the
 *           |  built-in git repo: here, a folder in an Obsidian vault,
 *           |  so memory is also browsable and linkable in Obsidian.
 *  How      |  Versions are content hashes (no git). Writes check the
 *           |  base version and throw MemoryConflict when the file has
 *           |  changed, which the Cockpit turns into a side-by-side
 *           |  conflict view. History is a sidecar JSONL log.
 *  Note     |  A sketch: search is a plain substring scan. Core still
 *           |  builds its embedding index over whatever list/read return.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  MemoryConflict,
  type MemoryFileInfo,
  type MemoryHistoryEntry,
  type MemoryProvider,
  type MemorySearchHit,
  type MemoryWrite,
} from '@nvx/plugin-sdk';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export class ObsidianMemoryProvider implements MemoryProvider {
  readonly id = 'obsidian';
  private readonly root: string;
  private readonly log: string;

  constructor(vault: string, folder = 'Ancile') {
    this.root = resolve(vault, folder);
    this.log = join(this.root, '.ancile-history.jsonl');
  }

  /** Never let a path escape the memory folder. */
  private abs(path: string): string {
    const p = resolve(this.root, path);
    if (p !== this.root && !p.startsWith(this.root + sep))
      throw new Error(`Path escapes memory folder: ${path}`);
    return p;
  }

  async list(prefix = ''): Promise<MemoryFileInfo[]> {
    const out: MemoryFileInfo[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const rel = relative(this.root, full).split(sep).join('/');
          if (!rel.startsWith(prefix)) continue;
          const [content, s] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
          out.push({ path: rel, version: hash(content), updatedAt: s.mtime.toISOString(), bytes: s.size });
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<{ content: string; version: string }> {
    // Content-hash versions cannot reconstruct the past; only the current
    // version is readable. TODO: keep snapshots if history reads matter.
    const content = await readFile(this.abs(path), 'utf8');
    return { content, version: hash(content) };
  }

  async write(change: MemoryWrite): Promise<{ version: string }> {
    const file = this.abs(change.path);
    const current = await readFile(file, 'utf8').catch(() => null);
    const currentVersion = current === null ? null : hash(current);
    if (currentVersion !== change.baseVersion) {
      throw new MemoryConflict(change.path, change.baseVersion, currentVersion ?? 'deleted');
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, change.content, 'utf8');
    const version = hash(change.content);
    const entry: MemoryHistoryEntry & { path: string } = {
      path: change.path,
      version,
      at: new Date().toISOString(),
      author: `${change.author.name} <${change.author.email}>`,
      message: change.message,
    };
    await appendFile(this.log, `${JSON.stringify(entry)}\n`);
    return { version };
  }

  async search(query: string, opts: { limit?: number; prefix?: string } = {}): Promise<MemorySearchHit[]> {
    const q = query.toLowerCase();
    const hits: MemorySearchHit[] = [];
    for (const f of await this.list(opts.prefix)) {
      const { content } = await this.read(f.path);
      for (const line of content.split('\n')) {
        if (line.startsWith('- ') && line.toLowerCase().includes(q)) {
          const key = line.match(/<!--\s*m:(\S+)/)?.[1] ?? null;
          hits.push({
            path: f.path,
            entryKey: key,
            text: line
              .slice(2)
              .replace(/<!--.*?-->/g, '')
              .trim(),
            score: 1,
          });
        }
      }
    }
    return hits.slice(0, opts.limit ?? 20);
  }

  async history(path: string, limit = 50): Promise<MemoryHistoryEntry[]> {
    const raw = await readFile(this.log, 'utf8').catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MemoryHistoryEntry & { path: string })
      .filter((e) => e.path === path)
      .reverse()
      .slice(0, limit)
      .map(({ path: _p, ...e }) => e);
  }

  async check(): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    try {
      await stat(this.root);
    } catch {
      problems.push(`Memory folder ${this.root} does not exist. Create it, or check OBSIDIAN_VAULT.`);
    }
    return { ok: problems.length === 0, problems };
  }
}

/** Entry point Core loads: a factory taking the plugin's settings. */
export default function create(settings: { vault?: string; folder?: string }): MemoryProvider {
  const vault = settings.vault ?? process.env.OBSIDIAN_VAULT;
  if (!vault) throw new Error('Set the vault path in the plugin settings or OBSIDIAN_VAULT.');
  return new ObsidianMemoryProvider(vault, settings.folder);
}
