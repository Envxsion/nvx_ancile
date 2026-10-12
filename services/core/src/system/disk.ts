/**
 * ------------------------------------------------------------------
 *  Title    |  Free disk space
 *  Ref      |  ROADMAP.md track G (data, updates and licensing)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say "not enough space" before starting something that
 *           |  would fill the disk half way through: a database
 *           |  backup, a migration, a source being added.
 *  How      |  statfs on the nearest folder that exists (bavail, the
 *           |  space this user may write), against what the job needs
 *           |  plus a reserve, so the database can still write its own
 *           |  log afterwards. The error names the drive (Windows) or
 *           |  the folder (macOS, Linux).
 *  Note     |  An estimate, not a promise: "~" in the message says so.
 *           |  A check that cannot run (statfs missing) lets the job go.
 *           |  Knowledge keeps sources in the same data folder, so
 *           |  Core's check before POST /sources covers its ingest.
 * ------------------------------------------------------------------
 */

import { statfs as nodeStatfs } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { AncileError } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';

/** Kept free beyond what a job needs, so Postgres can still write after it. */
export const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

export type StatFs = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export interface DiskSpace {
  /** Bytes this user may still write. */
  free: number;
  /** "C:" on Windows; the folder elsewhere. */
  drive: string;
}

/** "C:" for a Windows path, otherwise the folder itself (Unix has no drive letters). */
export function driveOf(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const m = /^([A-Za-z]:)/.exec(path);
    if (m?.[1]) return m[1].toUpperCase();
    const root = parse(path).root.replace(/[\\/]+$/, '');
    return root || path;
  }
  return path;
}

export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = i === 0 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${shown} ${units[i]}`;
}

/** Free space on the disk holding `path` (or its nearest existing parent). */
export async function diskSpace(
  path: string,
  opts: { statfs?: StatFs; platform?: NodeJS.Platform } = {},
): Promise<DiskSpace> {
  const stat = opts.statfs ?? (nodeStatfs as StatFs);
  let at = resolve(path);
  for (let i = 0; i < 64; i++) {
    try {
      const s = await stat(at);
      return {
        free: Number(s.bavail) * Number(s.bsize),
        drive: driveOf(at, opts.platform),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const up = dirname(at);
      if (code !== 'ENOENT' || up === at) throw err;
      at = up;
    }
  }
  throw new Error(`no folder found above ${path}`);
}

export function diskFull(need: number, space: DiskSpace, what: string, platform = process.platform) {
  const where = platform === 'win32' ? `drive ${space.drive}` : `the disk holding ${space.drive}`;
  return new AncileError({
    code: 'system.disk_full',
    title: `Not enough free disk space: needs ~${formatBytes(need)}, ${formatBytes(space.free)} free on ${where}`,
    hint: `Free some space on ${where} (empty the ${platform === 'darwin' ? 'Bin' : platform === 'win32' ? 'Recycle Bin' : 'trash'}, remove large downloads), then try again. Nothing was changed.`,
    status: 507,
    errorClass: 'capacity',
    detail: `Needed for ${what}.`,
    context: { need_bytes: need, free_bytes: space.free, drive: space.drive, for: what },
  });
}

/**
 * Throw `system.disk_full` unless `need` bytes (plus the reserve) are free
 * on the disk holding `path`. A check that cannot run lets the job go.
 */
export async function ensureFreeSpace(
  path: string,
  need: number,
  what: string,
  opts: { statfs?: StatFs; platform?: NodeJS.Platform; reserve?: number } = {},
): Promise<DiskSpace | null> {
  let space: DiskSpace;
  try {
    space = await diskSpace(path, opts);
  } catch {
    return null;
  }
  const total = Math.ceil(need) + (opts.reserve ?? DISK_RESERVE_BYTES);
  if (space.free < total) throw diskFull(total, space, what, opts.platform);
  return space;
}

/** Room a new source needs: the file, the text taken from it, and its search index. */
export function sourceNeeds(contentLength: number | null): number {
  const base = 50 * 1024 * 1024;
  return contentLength && contentLength > 0 ? contentLength * 3 + base : 2 * base;
}

/**
 * Adding a source (POST /sources) checks the disk first, so ingest never
 * stops half way on a full disk. Mounted before the route it guards.
 */
export function sourceDiskGuard(deps: {
  dataDir: string;
  statfs?: StatFs;
  platform?: NodeJS.Platform;
}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/sources', async (c, next) => {
    if (c.req.method === 'POST') {
      const length = Number(c.req.header('content-length') ?? '');
      await ensureFreeSpace(
        deps.dataDir,
        sourceNeeds(Number.isFinite(length) ? length : null),
        'adding this source',
        {
          ...(deps.statfs && { statfs: deps.statfs }),
          ...(deps.platform && { platform: deps.platform }),
        },
      );
    }
    await next();
  });
  return r;
}
