/**
 * ------------------------------------------------------------------
 *  Title    |  MemoryProvider
 *  Ref      |  DESIGN.md §6, §12
 *  ID       |  plugin-sdk
 * ------------------------------------------------------------------
 *  Purpose  |  The interface every memory backend implements. The
 *           |  built-in one is a git repository of markdown files;
 *           |  a plugin can put memory in an Obsidian vault, a Notion
 *           |  page, anything that can list, read, write and remember
 *           |  its own history.
 *  Note     |  Writes carry baseVersion for optimistic concurrency. A
 *           |  provider that cannot merge must throw MemoryConflict.
 * ------------------------------------------------------------------
 */

export interface MemoryFileInfo {
  path: string;
  /** Opaque version: a commit sha for git, an etag elsewhere. */
  version: string;
  updatedAt: string;
  bytes: number;
}

export interface MemoryWrite {
  path: string;
  content: string;
  baseVersion: string | null;
  message: string;
  author: { name: string; email: string };
}

export interface MemoryHistoryEntry {
  version: string;
  at: string;
  author: string;
  message: string;
}

export interface MemorySearchHit {
  path: string;
  entryKey: string | null;
  text: string;
  score: number;
}

export interface MemoryProvider {
  readonly id: string;
  list(prefix?: string): Promise<MemoryFileInfo[]>;
  read(path: string, version?: string): Promise<{ content: string; version: string }>;
  write(change: MemoryWrite): Promise<{ version: string }>;
  search(query: string, opts?: { limit?: number; prefix?: string }): Promise<MemorySearchHit[]>;
  history(path: string, limit?: number): Promise<MemoryHistoryEntry[]>;
  /** Integrity check for the self-diagnostic panel. */
  check?(): Promise<{ ok: boolean; problems: string[] }>;
}

export class MemoryConflict extends Error {
  constructor(
    readonly path: string,
    readonly baseVersion: string | null,
    readonly currentVersion: string,
  ) {
    super(`Memory file ${path} changed since ${baseVersion ?? 'creation'} (now ${currentVersion})`);
    this.name = 'MemoryConflict';
  }
}
