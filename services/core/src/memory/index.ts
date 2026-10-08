/**
 * ------------------------------------------------------------------
 *  Title    |  Memory index
 *  Ref      |  DESIGN.md §3.1 (memory_entries), §6.3, §6.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every entry in every memory file, addressable by key and
 *           |  searchable by meaning, without re-reading files on each
 *           |  model call. The files stay the truth: the index is
 *           |  derived and can be rebuilt from them at any time.
 *  How      |  Held in memory per file, refreshed whenever Core writes a
 *           |  file and rebuilt at start. A sink mirrors it into
 *           |  core.memory_entries so other parts (explain, admin) can
 *           |  join on it. Similarity is word overlap (cosine over
 *           |  normalised word sets, with light stemming): no embedder
 *           |  is needed, and it is good enough for picking the closest
 *           |  few of a few hundred short sentences.
 *  Note     |  TODO(phase-5): embeddings through the gateway when an
 *           |  embedding model is configured (the column exists).
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import { entries as entriesOf, parseMemory } from './format';

export interface IndexedEntry {
  path: string;
  key: string;
  text: string;
  section: string | null;
  superseded: boolean;
  confidence: number | null;
  src: string | null;
  at: string | null;
  supersededBy: string | null;
  commit: string;
}

export interface IndexedFile {
  path: string;
  title: string;
  commit: string;
  entries: IndexedEntry[];
}

export interface MemoryIndexSink {
  replace(file: IndexedFile): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Files that explain a folder rather than hold memory. */
export const isGuideFile = (path: string) => /(^|\/)(README|_template)\.md$/i.test(path);

const STOP = new Set(
  'a an the and or but of to in on at for with by from as is are was were be been it its this that these those i you he she we they me my your our their not no do does did so than then there here when what which who how all any can will would should could just also into over about'.split(
    ' ',
  ),
);

function stem(word: string): string {
  let w = word;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) return w.slice(0, -1);
  return w;
}

export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map(stem),
  );
}

/** Cosine similarity of two word sets, in [0, 1]. */
export function similarity(a: string | Set<string>, b: string | Set<string>): number {
  const A = typeof a === 'string' ? words(a) : a;
  const B = typeof b === 'string' ? words(b) : b;
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.sqrt(A.size * B.size);
}

export function indexFile(path: string, content: string, commit: string): IndexedFile {
  const doc = parseMemory(content);
  const h1 = doc.blocks.find((b) => b.kind === 'raw' && b.heading?.level === 1);
  // A template's heading is a placeholder ({{notebook_title}}): name it for what it is.
  const template = /(^|\/)_template\.md$/.test(path) ? 'Template for new notebooks' : '';
  const title =
    template ||
    (h1?.kind === 'raw' && h1.heading?.title) ||
    (typeof doc.frontMatter.title === 'string' ? doc.frontMatter.title : '') ||
    path.replace(/\.md$/, '');
  return {
    path,
    title,
    commit,
    entries: isGuideFile(path)
      ? []
      : entriesOf(doc, { includeSuperseded: true }).map((e) => ({
          path,
          key: e.key,
          text: e.text,
          section: e.section,
          superseded: e.superseded,
          confidence: typeof e.meta.conf === 'number' ? e.meta.conf : null,
          src: typeof e.meta.src === 'string' ? e.meta.src : null,
          at: typeof e.meta.at === 'string' ? e.meta.at : null,
          supersededBy: typeof e.meta.superseded_by === 'string' ? e.meta.superseded_by : null,
          commit,
        })),
  };
}

export interface IndexSource {
  list(): Promise<{ path: string; version: string }[]>;
  read(path: string): Promise<{ content: string; version: string }>;
}

export class MemoryIndex {
  private files = new Map<string, IndexedFile>();

  constructor(
    private readonly source: IndexSource,
    private readonly sink?: MemoryIndexSink,
  ) {}

  async rebuild(): Promise<void> {
    const listed = await this.source.list();
    const next = new Map<string, IndexedFile>();
    for (const f of listed) {
      const { content } = await this.source.read(f.path);
      next.set(f.path, indexFile(f.path, content, f.version));
    }
    for (const gone of this.files.keys()) if (!next.has(gone)) await this.sink?.remove(gone);
    this.files = next;
    for (const f of next.values()) await this.sink?.replace(f);
  }

  /** Re-read one file after Core wrote it. */
  async refresh(path: string): Promise<IndexedFile | undefined> {
    const read = await this.source.read(path).catch(() => null);
    if (!read) {
      this.files.delete(path);
      await this.sink?.remove(path);
      return undefined;
    }
    const f = indexFile(path, read.content, read.version);
    this.files.set(path, f);
    await this.sink?.replace(f);
    return f;
  }

  file(path: string): IndexedFile | undefined {
    return this.files.get(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Live (not superseded) entries, optionally under a path prefix. */
  live(prefix?: string): IndexedEntry[] {
    const out: IndexedEntry[] = [];
    for (const f of this.files.values())
      if (!prefix || f.path.startsWith(prefix)) out.push(...f.entries.filter((e) => !e.superseded));
    return out;
  }

  find(path: string, key: string): IndexedEntry | undefined {
    return this.files.get(path)?.entries.find((e) => e.key === key);
  }

  /** Closest live entries to `query`, best first. */
  search(
    query: string,
    opts: { prefix?: string; path?: string; limit?: number; min?: number } = {},
  ): (IndexedEntry & { score: number })[] {
    const q = words(query);
    const pool = opts.path
      ? (this.files.get(opts.path)?.entries.filter((e) => !e.superseded) ?? [])
      : this.live(opts.prefix);
    return pool
      .map((e) => ({ ...e, score: similarity(q, e.text) }))
      .filter((e) => e.score > (opts.min ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 10);
  }
}

/** Mirrors the index into core.memory_entries. */
export class PgMemoryIndexSink implements MemoryIndexSink {
  constructor(private readonly sql: Sql) {}

  async replace(file: IndexedFile): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`delete from core.memory_entries where path = ${file.path}`;
      const notebook = null;
      for (const e of file.entries) {
        await tx`
          insert into core.memory_entries
            (id, path, scope, notebook_id, entry_key, text, meta, commit_sha, valid_from, superseded_by)
          values (${`${file.path}#${e.key}`}, ${file.path}, ${scopeFor(file.path)}, ${notebook}, ${e.key}, ${e.text},
                  ${tx.json({ section: e.section, conf: e.confidence, src: e.src })}, ${file.commit},
                  ${e.at && /^\d{4}-\d{2}-\d{2}/.test(e.at) ? e.at : null}, ${e.supersededBy})
          on conflict (path, entry_key) do nothing`;
      }
    });
  }

  async remove(path: string): Promise<void> {
    await this.sql`delete from core.memory_entries where path = ${path}`;
  }
}

function scopeFor(path: string): string {
  if (path === 'AGENTS.md') return 'global';
  if (path === 'USER.md') return 'user';
  if (path.startsWith('PROJECTS/')) return 'notebook';
  if (path.startsWith('FAILURES/')) return 'retrieved';
  if (path.startsWith('MODELS/')) return 'model';
  return 'other';
}
