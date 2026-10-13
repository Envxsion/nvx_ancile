/**
 * ------------------------------------------------------------------
 *  Title    |  Image store
 *  Ref      |  docs/images.md (Storage)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep every image a thread holds (attached, generated, or
 *           |  written by a model) once, by content, in the workspace
 *           |  data folder, with a row per use in core.images.
 *  How      |  put() checks the size and the real type (from the bytes,
 *           |  never a header), hashes with sha256 and writes
 *           |  <data>/images/<aa>/<sha256> only when it is not there
 *           |  yet. A thread's rows go with the thread (cascade);
 *           |  sweep() removes files no row names any more.
 *  Note     |  Rows are behind ImageRows so tests can run without
 *           |  Postgres; the bytes are always real files.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AncileError,
  IMAGE_ID,
  IMAGE_LIMITS,
  type ImageMime,
  type ImageProviderKind,
  type ImageRecord,
  type ImageSource,
  imageUrl,
  sniffImage,
} from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';

export type ImageRow = Omit<ImageRecord, 'url'>;

export interface ImageRows {
  insert(r: ImageRow): Promise<void>;
  get(id: string): Promise<ImageRow | null>;
  forThread(threadId: string): Promise<ImageRow[]>;
  /** A deleted thread's rows (threads are soft-deleted, so the cascade alone is not enough). */
  deleteForThread(threadId: string): Promise<number>;
  /** Every sha256 some row still names. */
  hashes(): Promise<Set<string>>;
  hosts(scopeKey: string): Promise<string[]>;
  allowHost(scopeKey: string, host: string): Promise<void>;
}

interface PgRow {
  id: string;
  thread_id: string | null;
  sha256: string;
  mime: ImageMime;
  bytes: number;
  width: number | null;
  height: number | null;
  source: ImageSource;
  alt: string;
  prompt: string | null;
  model: string | null;
  provider: string | null;
  provider_kind: ImageProviderKind | null;
  cost_usd: string | number | null;
  created_at: Date | string;
}

const fromPg = (r: PgRow): ImageRow => ({
  ...r,
  cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
  created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
});

export class PgImageRows implements ImageRows {
  constructor(private readonly sql: Sql) {}
  async insert(r: ImageRow) {
    await this.sql`
      insert into core.images (id, thread_id, sha256, mime, bytes, width, height, source, alt,
        prompt, model, provider, provider_kind, cost_usd, created_at)
      values (${r.id}, ${r.thread_id}, ${r.sha256}, ${r.mime}, ${r.bytes}, ${r.width}, ${r.height},
        ${r.source}, ${r.alt}, ${r.prompt}, ${r.model}, ${r.provider}, ${r.provider_kind},
        ${r.cost_usd}, ${r.created_at})`;
  }
  async get(id: string) {
    const rows = await this.sql<PgRow[]>`select * from core.images where id = ${id}`;
    return rows[0] ? fromPg(rows[0]) : null;
  }
  async forThread(threadId: string) {
    const rows = await this.sql<PgRow[]>`
      select * from core.images where thread_id = ${threadId} order by created_at`;
    return rows.map(fromPg);
  }
  async deleteForThread(threadId: string) {
    const rows = await this.sql`delete from core.images where thread_id = ${threadId} returning id`;
    return rows.length;
  }
  async hashes() {
    const rows = await this.sql<{ sha256: string }[]>`select distinct sha256 from core.images`;
    return new Set(rows.map((r) => r.sha256));
  }
  async hosts(scopeKey: string) {
    const rows = await this.sql<{ host: string }[]>`
      select host from core.image_remote_hosts where scope_key = ${scopeKey} order by host`;
    return rows.map((r) => r.host);
  }
  async allowHost(scopeKey: string, host: string) {
    await this.sql`
      insert into core.image_remote_hosts (scope_key, host) values (${scopeKey}, ${host})
      on conflict (scope_key, host) do nothing`;
  }
}

export class MemoryImageRows implements ImageRows {
  readonly rows = new Map<string, ImageRow>();
  readonly allowed = new Map<string, Set<string>>();
  async insert(r: ImageRow) {
    this.rows.set(r.id, r);
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async forThread(threadId: string) {
    return [...this.rows.values()].filter((r) => r.thread_id === threadId);
  }
  async deleteForThread(threadId: string) {
    let n = 0;
    for (const [id, r] of this.rows)
      if (r.thread_id === threadId) {
        this.rows.delete(id);
        n++;
      }
    return n;
  }
  async hashes() {
    return new Set([...this.rows.values()].map((r) => r.sha256));
  }
  async hosts(scopeKey: string) {
    return [...(this.allowed.get(scopeKey) ?? [])].sort();
  }
  async allowHost(scopeKey: string, host: string) {
    const s = this.allowed.get(scopeKey) ?? new Set<string>();
    s.add(host);
    this.allowed.set(scopeKey, s);
  }
}

/** Width and height from the header, when the format says them early. */
export function dimensions(b: Buffer, mime: ImageMime): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && b.length >= 24)
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/gif' && b.length >= 10)
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mime === 'image/webp' && b.length >= 30) {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8 ')
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1] as number;
        const len = b.readUInt16BE(i + 2);
        // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    /* a truncated header: no dimensions */
  }
  return null;
}

export const tooLarge = (what: string, limit = IMAGE_LIMITS.bytes) =>
  new AncileError({
    code: 'image.too_large',
    title: `${what} is too large.`,
    hint: `Images can be up to ${Math.round(limit / 1024 / 1024)} MB. Use a smaller or more compressed copy.`,
    status: 413,
    errorClass: 'permanent',
  });

export const notAnImage = (what: string) =>
  new AncileError({
    code: 'image.type_not_allowed',
    title: `${what} is not an image NVX Ancile can show.`,
    hint: 'Use a PNG, JPEG, WebP or GIF file. SVG is not accepted as an image.',
    status: 415,
    errorClass: 'permanent',
  });

export interface PutImage {
  threadId: string | null;
  bytes: Buffer;
  source: ImageSource;
  alt?: string;
  prompt?: string | null;
  model?: string | null;
  provider?: string | null;
  providerKind?: ImageProviderKind | null;
  costUsd?: number | null;
  /** Used in errors: "That image", "The pasted file". */
  what?: string;
}

export class ImageStore {
  constructor(
    readonly dir: string,
    readonly rows: ImageRows,
  ) {}

  private path(sha: string) {
    return join(this.dir, sha.slice(0, 2), sha);
  }

  async put(p: PutImage): Promise<ImageRecord> {
    const what = p.what ?? 'That image';
    if (p.bytes.length > IMAGE_LIMITS.bytes) throw tooLarge(what);
    const mime = sniffImage(p.bytes);
    if (!mime) throw notAnImage(what);
    const sha = createHash('sha256').update(p.bytes).digest('hex');
    const file = this.path(sha);
    const there = await stat(file).then(
      (s) => s.size === p.bytes.length,
      () => false,
    );
    if (!there) {
      await mkdir(join(this.dir, sha.slice(0, 2)), { recursive: true });
      // Written aside and renamed, so a half-written file is never served.
      const tmp = `${file}.${ulid()}.part`;
      await writeFile(tmp, p.bytes);
      await rename(tmp, file);
    }
    const dim = dimensions(p.bytes, mime);
    const row: ImageRow = {
      id: `img_${ulid()}`,
      thread_id: p.threadId,
      sha256: sha,
      mime,
      bytes: p.bytes.length,
      width: dim?.width ?? null,
      height: dim?.height ?? null,
      source: p.source,
      alt: (p.alt ?? '').slice(0, 500),
      prompt: p.prompt ?? null,
      model: p.model ?? null,
      provider: p.provider ?? null,
      provider_kind: p.providerKind ?? null,
      cost_usd: p.costUsd ?? null,
      created_at: new Date().toISOString(),
    };
    await this.rows.insert(row);
    return { ...row, url: imageUrl(row.id) };
  }

  async get(id: string): Promise<{ record: ImageRecord; bytes: Buffer } | null> {
    if (!IMAGE_ID.test(id)) return null;
    const row = await this.rows.get(id);
    if (!row) return null;
    const bytes = await readFile(this.path(row.sha256)).catch(() => null);
    return bytes ? { record: { ...row, url: imageUrl(row.id) }, bytes } : null;
  }

  async forThread(threadId: string): Promise<ImageRecord[]> {
    return (await this.rows.forThread(threadId)).map((r) => ({ ...r, url: imageUrl(r.id) }));
  }

  /** A thread was deleted: its images go, and so does every file no other thread still uses. */
  async deleteThread(threadId: string, graceMs?: number): Promise<number> {
    await this.rows.deleteForThread(threadId);
    return this.sweep(graceMs);
  }

  /** Remove files no row names (after a thread was deleted). Returns how many went. */
  async sweep(graceMs = 60_000): Promise<number> {
    const keep = await this.rows.hashes();
    let removed = 0;
    const shards = await readdir(this.dir).catch(() => [] as string[]);
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      for (const f of await readdir(join(this.dir, shard)).catch(() => [] as string[])) {
        if (keep.has(f)) continue;
        const file = join(this.dir, shard, f);
        // A put() in progress writes its file a moment before its row: leave recent files be.
        const age = await stat(file).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0,
        );
        if (age < graceMs) continue;
        await rm(file, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
