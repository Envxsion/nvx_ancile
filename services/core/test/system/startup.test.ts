/**
 * The start-up screen Core serves when it stopped before opening the
 * database: ready (so the window opens), why it stopped, and only the
 * actions that fit.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AncileError } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { backupsDir } from '../../src/db/backup';
import { SKIP_BACKUP_MARKER } from '../../src/db/prepare';
import { actionsFor, RESTART_ALL_EXIT, stoppedApp } from '../../src/system/startup';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(error: AncileError, managed = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ancile-start-'));
  dirs.push(dataDir);
  const exits: number[] = [];
  const a = stoppedApp({
    error,
    sql: (() => Promise.reject(new Error('no database here'))) as unknown as Sql,
    url: 'postgres://a:b@127.0.0.1:1/x',
    dataDir,
    version: '0.2.0',
    schema: () => ({ expected: '0020_x.sql', current: '0021_y.sql' }),
    allowedOrigins: ['http://localhost:7701'],
    managed,
    exit: (c) => exits.push(c),
  });
  return { a, exits, dataDir };
}

const failedBackup = new AncileError({
  code: 'system.backup_failed',
  title: 'The database could not be backed up',
  hint: 'Your data was not changed.',
  status: 503,
});
const post = (body: unknown = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:7701' },
  body: JSON.stringify(body),
});

describe('the start-up screen', () => {
  it('opens the window and says why Core stopped', async () => {
    const { a } = app(failedBackup);
    expect((await a.request('/ready')).status).toBe(200);
    const s = (await (await a.request('/api/v1/system/startup')).json()) as {
      state: string;
      error: { code: string; hint: string };
      actions: string[];
      schema: { expected: string; current: string };
    };
    expect(s.state).toBe('stopped');
    expect(s.error.code).toBe('system.backup_failed');
    expect(s.actions).toEqual(['retry', 'continue_without_backup']);
    expect(s.schema).toEqual({ expected: '0020_x.sql', current: '0021_y.sql' });
  });

  it('answers every other route with the same error, never a half-started Core', async () => {
    const { a } = app(failedBackup);
    const r = await a.request('/api/v1/threads');
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('system.backup_failed');
  });

  it('continues without a backup only after one failed, and only once asked', async () => {
    const { a, exits, dataDir } = app(failedBackup);
    const r = await a.request('/api/v1/system/startup/continue-without-backup', post());
    expect(r.status).toBe(200);
    expect(existsSync(join(backupsDir(dataDir), SKIP_BACKUP_MARKER))).toBe(true);
    expect(exits).toEqual([RESTART_ALL_EXIT]);

    const newer = app(new AncileError({ code: 'system.database_newer', title: 'x', hint: 'y', status: 409 }));
    const refused = await newer.a.request('/api/v1/system/startup/continue-without-backup', post());
    expect(refused.status).toBe(409);
    expect(existsSync(join(backupsDir(newer.dataDir), SKIP_BACKUP_MARKER))).toBe(false);
  });

  it('asks the desktop app to start again on Try again; elsewhere it says to restart', async () => {
    const managed = app(failedBackup);
    expect(await (await managed.a.request('/api/v1/system/startup/retry', post())).json()).toEqual({
      restarting: true,
    });
    expect(managed.exits).toEqual([RESTART_ALL_EXIT]);
    const dev = app(failedBackup, false);
    expect(await (await dev.a.request('/api/v1/system/startup/retry', post())).json()).toEqual({
      restarting: false,
    });
    expect(dev.exits).toEqual([]);
  });

  it('refuses actions from another site', async () => {
    const { a, exits } = app(failedBackup);
    const r = await a.request('/api/v1/system/startup/retry', {
      ...post(),
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
    expect(exits).toEqual([]);
  });

  it('offers what fits each reason', () => {
    expect(actionsFor('system.database_newer', true)).toEqual(['restore', 'reinstall']);
    expect(actionsFor('system.database_newer', false)).toEqual(['reinstall']);
    expect(actionsFor('system.disk_full', true)).toEqual(['retry', 'restore']);
    expect(actionsFor('system.migration_failed', false)).toEqual(['retry']);
  });
});
