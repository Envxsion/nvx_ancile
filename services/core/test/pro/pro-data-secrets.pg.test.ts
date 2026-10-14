/**
 * Pro's data export never carries a secret: a column marked with the
 * comment `nvx:secret` (a passphrase hash, a token's hash) is left out,
 * whatever the edition reading it, while every other column stays. In a
 * team, only an admin may read or export Pro's data. Needs
 * CORE_TEST_DATABASE_URL (a throwaway database).
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { errorHandler } from '../../src/obs/errors';
import { proDataExport, proDataRoutes, SECRET_MARK } from '../../src/pro/data';
import { identityMiddleware } from '../../src/pro/routes';
import type { IdentityProvider, Principal } from '../../src/pro/types';
import { type Throwaway, throwawayDb } from '../support/throwaway-db';

const base = inject('pgUrl');
const SCHEMA = 'pro_secrets_test';

describe.skipIf(!base)('the Pro data export and secrets (postgres)', () => {
  let db: Throwaway;
  beforeAll(async () => {
    db = await throwawayDb(base as string, 'ancile_coretest_prosecrets');
    await db.sql.unsafe(`
      create schema ${SCHEMA};
      create table ${SCHEMA}.accounts (id text primary key, email text not null, pass_hash text, note text);
      create table ${SCHEMA}.links (token_hash text primary key);
      comment on column ${SCHEMA}.accounts.pass_hash is '${SECRET_MARK}';
      comment on column ${SCHEMA}.accounts.note is 'what this is for (not a secret)';
      comment on column ${SCHEMA}.links.token_hash is '${SECRET_MARK}: what a link was made from';
      insert into ${SCHEMA}.accounts values ('a1', 'ana@example.com', 'scrypt$32768$8$1$c2FsdA$aGFzaA', 'hello');
      insert into ${SCHEMA}.links values ('dG9rZW4taGFzaA');
    `);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('leaves marked columns out and keeps every other one, in every edition', async () => {
    for (const edition of ['free', 'pro'] as const) {
      const dump = await proDataExport(db.sql, edition, SCHEMA);
      expect(dump.tables.accounts).toEqual([{ id: 'a1', email: 'ana@example.com', note: 'hello' }]);
      // A table whose only column is secret still says how many rows it has.
      expect(dump.tables.links).toEqual([{}]);
      const text = JSON.stringify(dump);
      expect(text).not.toContain('scrypt$');
      expect(text).not.toContain('dG9rZW4taGFzaA');
    }
  });

  it('is an admin’s to read in a team; a single owner’s always', async () => {
    const as = (role: Principal['role']): IdentityProvider => ({
      resolve: async () => ({ userId: 'u', workspaceId: 'w', role, name: 'Sam', via: 'session' }),
    });
    const mount = (identity: IdentityProvider) => {
      const a = new Hono<AppEnv>();
      a.onError(errorHandler);
      const api = new Hono<AppEnv>();
      api.use(
        '*',
        identityMiddleware(() => identity),
      );
      api.route('/', proDataRoutes({ sql: db.sql, edition: () => 'pro', schema: SCHEMA }));
      a.route('/api/v1', api);
      return a;
    };
    for (const role of ['member', 'viewer'] as const) {
      const a = mount(as(role));
      for (const path of ['/system/pro-data', '/system/pro-data/export']) {
        const res = await a.request(`/api/v1${path}`);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('auth.role_too_low');
      }
    }
    for (const role of ['admin', 'owner'] as const) {
      const res = await mount(as(role)).request('/api/v1/system/pro-data/export');
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toContain('scrypt$');
    }
  });
});
