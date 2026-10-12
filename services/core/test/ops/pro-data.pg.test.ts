/**
 * Pro lapses, or the build goes back to the free edition, while Pro's data
 * exists (needs CORE_TEST_DATABASE_URL; a throwaway database): every row
 * stays, readable and exportable, and nothing deletes it.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { prepareDatabase } from '../../src/db/prepare';
import { errorHandler } from '../../src/obs/errors';
import { loadPro } from '../../src/pro';
import { proDataRoutes } from '../../src/pro/data';
import { proRoutes } from '../../src/pro/routes';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';
import { type Throwaway, throwawayDb } from '../support/throwaway-db';

const base = inject('pgUrl');

describe.skipIf(!base)("Pro's data after Pro ends (postgres)", () => {
  let db: Throwaway;
  let dataDir: string;

  const proRows = async () => ({
    packs: await db.sql<{ id: string; title: string }[]>`select id, title from pro.context_packs order by id`,
    insights: await db.sql<{ id: string }[]>`select id from pro.insights order by id`,
    sync: await db.sql<{ device: string }[]>`select device from pro.sync_state`,
  });

  beforeAll(async () => {
    db = await throwawayDb(base as string, 'ancile_coretest_prodata');
    dataDir = mkdtempSync(join(tmpdir(), 'ancile-prodata-'));
    // A Pro install: Core's schema, then the tables Pro keeps in its own schema.
    await prepareDatabase({ sql: db.sql, url: db.url, dataDir, appVersion: '0.3.0-pro', knowledgeDir: null });
    await db.sql.unsafe(`
      create schema if not exists pro;
      create table pro.context_packs (id text primary key, title text not null, body jsonb not null, sealed bytea);
      create table pro.insights (id text primary key, notebook_id text, text text not null);
      create table pro.sync_state (device text primary key, cursor timestamptz not null);
      insert into pro.context_packs values
        ('cpk_1', 'Thesis notes', '{"items":[1,2,3]}', '\\x0102'),
        ('cpk_2', 'Client brief', '{"items":[]}', null);
      insert into pro.insights values ('ins_1', 'nb_1', 'Three sources disagree on the date.');
      insert into pro.sync_state values ('laptop', '2026-10-01T00:00:00Z');
    `);
  });
  afterAll(async () => {
    await db?.drop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps every row through a downgrade to the free build, and exports them', async () => {
    const before = await proRows();

    // The free build starts on the same database: no Pro code at all.
    const free = await loadPro({
      tier: 'free',
      host: {
        settings: new MemorySettings(),
        secrets: new MemorySecretStore(new SecretBox(randomBytes(32).toString('base64'))),
        keys: {},
        licenseUrl: 'https://licence.test',
        version: '0.3.0',
      },
    });
    expect(free.build).toBe('free');
    const started = await prepareDatabase({
      sql: db.sql,
      url: db.url,
      dataDir,
      appVersion: '0.3.0',
      knowledgeDir: null,
    });
    expect(started.applied).toEqual([]);
    expect(await proRows()).toEqual(before);

    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', proDataRoutes({ sql: db.sql, edition: () => free.build }));

    const summary = (await (await app.request('/system/pro-data')).json()) as {
      tables: { name: string; rows: number }[];
      total_rows: number;
    };
    expect(summary.tables).toEqual([
      { name: 'context_packs', rows: 2 },
      { name: 'insights', rows: 1 },
      { name: 'sync_state', rows: 1 },
    ]);
    expect(summary.total_rows).toBe(4);

    const res = await app.request('/system/pro-data/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="nvx-ancile-pro-data-/);
    const dump = (await res.json()) as {
      edition: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(dump.edition).toBe('free');
    expect(dump.tables.context_packs?.map((r) => r.title)).toEqual(['Thesis notes', 'Client brief']);
    expect(dump.tables.context_packs?.[0]).toMatchObject({ body: { items: [1, 2, 3] }, sealed: 'AQI=' });
    expect(dump.tables.insights?.[0]).toMatchObject({ text: 'Three sources disagree on the date.' });
    expect(dump.tables.sync_state?.[0]).toMatchObject({ device: 'laptop' });

    // Reading changed nothing.
    expect(await proRows()).toEqual(before);
  });

  it("stays readable in a Pro build whose licence lapsed, while Pro's own routes are locked", async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route(
      '/',
      proRoutes({
        routes: [
          {
            method: 'GET',
            path: '/packs',
            feature: 'insights',
            handler: async () => ({ body: [] }),
          },
        ],
        hasFeature: () => false,
      }),
    );
    app.route('/', proDataRoutes({ sql: db.sql, edition: () => 'pro' }));
    expect((await app.request('/pro/packs')).status).toBe(402);
    const dump = (await (await app.request('/system/pro-data/export')).json()) as {
      edition: string;
      tables: Record<string, unknown[]>;
    };
    expect(dump.edition).toBe('pro');
    expect(dump.tables.context_packs).toHaveLength(2);
  });

  it('answers with nothing, not an error, when Pro never ran here', async () => {
    const app = new Hono<AppEnv>();
    app.route('/', proDataRoutes({ sql: db.sql, edition: () => 'free', schema: 'pro_never_made' }));
    expect(await (await app.request('/system/pro-data')).json()).toEqual({ tables: [], total_rows: 0 });
  });
});
