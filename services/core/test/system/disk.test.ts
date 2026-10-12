/**
 * Free disk space: checked before a backup, a migration and a new source,
 * with a message that says how much is needed, how much is free, and where.
 */
import { join, resolve } from 'node:path';
import { AncileError } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/obs/errors';
import {
  DISK_RESERVE_BYTES,
  diskSpace,
  driveOf,
  ensureFreeSpace,
  formatBytes,
  sourceDiskGuard,
  sourceNeeds,
} from '../../src/system/disk';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const free = (bytes: number) => async () => ({ bavail: bytes / 4096, bsize: 4096 });

describe('free disk space', () => {
  it('names the drive on Windows and the folder elsewhere', () => {
    expect(driveOf('C:\\Users\\ana\\AppData\\Roaming\\NVX Ancile', 'win32')).toBe('C:');
    expect(driveOf('d:/data', 'win32')).toBe('D:');
    expect(driveOf('/home/ana/.local/share/NVX Ancile', 'linux')).toBe('/home/ana/.local/share/NVX Ancile');
  });

  it('formats sizes the way people read them', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(300 * MB)).toBe('300 MB');
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB');
  });

  it('refuses with how much is needed, how much is free and on which drive', async () => {
    const err = await ensureFreeSpace('C:\\data', 1 * GB, 'a backup of the database', {
      statfs: free(700 * MB),
      platform: 'win32',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AncileError);
    const e = err as AncileError;
    expect(e.code).toBe('system.disk_full');
    expect(e.status).toBe(507);
    expect(e.title).toBe(
      `Not enough free disk space: needs ~${formatBytes(GB + DISK_RESERVE_BYTES)}, 700 MB free on drive C:`,
    );
    expect(e.hint).toContain('Recycle Bin');
    expect(e.detail).toContain('a backup of the database');
  });

  it('passes when there is room, reserve included', async () => {
    const space = await ensureFreeSpace('/data', 100 * MB, 'x', { statfs: free(2 * GB), platform: 'linux' });
    expect(space?.free).toBe(2 * GB);
    await expect(
      ensureFreeSpace('/data', 100 * MB, 'x', {
        statfs: free(100 * MB + DISK_RESERVE_BYTES - 1),
        platform: 'linux',
      }),
    ).rejects.toMatchObject({ code: 'system.disk_full' });
  });

  it('measures the nearest folder that exists, and lets the job go when it cannot measure', async () => {
    const seen: string[] = [];
    const statfs = async (p: string) => {
      seen.push(p);
      if (p.endsWith('backups')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { bavail: 10, bsize: 4096 };
    };
    const data = resolve('/data');
    expect((await diskSpace(join(data, 'backups'), { statfs, platform: 'linux' })).drive).toBe(data);
    expect(seen).toEqual([join(data, 'backups'), data]);
    const broken = async () => {
      throw Object.assign(new Error('not supported'), { code: 'ENOSYS' });
    };
    expect(await ensureFreeSpace('/data', 10 * GB, 'x', { statfs: broken })).toBeNull();
  });

  it('checks the disk before a source is added, sized by the upload', async () => {
    expect(sourceNeeds(100 * MB)).toBe(350 * MB);
    expect(sourceNeeds(null)).toBe(100 * MB);
    const guard = sourceDiskGuard({ dataDir: 'C:\\data', statfs: free(300 * MB), platform: 'win32' });
    guard.onError(errorHandler);
    guard.post('/sources', (c) => c.json({ added: true }, 201));
    guard.get('/sources', (c) => c.json({ listed: true }));
    const big = await guard.request('/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(200 * MB) },
      body: '{}',
    });
    expect(big.status).toBe(507);
    const body = (await big.json()) as { error: { code: string; title: string } };
    expect(body.error.code).toBe('system.disk_full');
    expect(body.error.title).toContain('free on drive C:');
    // Reading the list never needs room.
    expect((await guard.request('/sources')).status).toBe(200);
  });
});
