/**
 * PgStore against a real database: runs when CONTROLLER_TEST_DATABASE_URL is
 * set (the dev stack's Postgres, for example), skipped otherwise. Everything
 * it writes uses ids under "nod_pgtest" and is removed afterwards.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { PgStore } from '../src/pgstore';
import type { NodeRecord } from '../src/store';

const url = process.env.CONTROLLER_TEST_DATABASE_URL;
const sql = url ? postgres(url, { max: 2, onnotice: () => {} }) : null;
const store = sql ? new PgStore(sql) : null;
const ID = `nod_pgtest_${Date.now()}`;

const node = (over: Partial<NodeRecord> = {}): NodeRecord => ({
  id: ID,
  provider: 'fake',
  provider_ref: ID,
  name: 'PG test node',
  gpu_type: 'A100',
  region: 'EU-RO-1',
  observed_state: 'stopped',
  desired_state: 'stopped',
  endpoint_url: null,
  served_models: ['m1'],
  hourly_rate: 1.19,
  storage_rate_month: 10,
  healthy: false,
  last_activity_at: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  terminatedAt: null,
  runningSince: null,
  ...over,
});

describe.skipIf(!sql)('PgStore', () => {
  beforeAll(async () => {
    if (sql) await migrate(sql);
  });
  afterAll(async () => {
    if (!sql) return;
    await sql`delete from controller.nodes where id = ${ID}`;
    await sql`delete from controller.routes where alias = ${`node/${ID}`}`;
    await sql.end();
  });

  it('round-trips a node, its operation, usage and route', async () => {
    const s = store as PgStore;
    await s.putNode(node());
    await s.putNode(
      node({ observed_state: 'running', healthy: true, last_activity_at: '2026-10-07T10:00:00.000Z' }),
    );
    expect(await s.getNode(ID)).toMatchObject({
      observed_state: 'running',
      healthy: true,
      served_models: ['m1'],
    });

    const at = '2026-10-07T10:00:00.000Z';
    const op = {
      id: `opn_${ID}`,
      node_id: ID,
      action: 'start' as const,
      status: 'requested' as const,
      timeline: [{ status: 'requested' as const, at, detail: 'Start requested' }],
      requested_by: 'test',
      reason: null,
      error: null,
      trace_id: 't',
      created_at: at,
      updated_at: at,
    };
    await s.putOperation(op, `key-${ID}`);
    expect((await s.liveOperationFor(ID))?.id).toBe(op.id);
    await s.putOperation({ ...op, status: 'confirmed' });
    expect(await s.liveOperationFor(ID)).toBeUndefined();
    expect((await s.findOperationByKey(`key-${ID}`))?.status).toBe('confirmed');

    await s.openInterval(ID, new Date('2026-10-07T08:00:00Z'), 1.19);
    await s.openInterval(ID, new Date('2026-10-07T08:30:00Z'), 1.19); // one open interval per node
    await s.closeInterval(ID, new Date('2026-10-07T10:00:00Z'));
    const mine = (await s.intervals()).filter((i) => i.nodeId === ID);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.endedAt?.toISOString()).toBe('2026-10-07T10:00:00.000Z');

    await s.putRoute({ alias: `node/${ID}`, targets: [{ node_id: ID }], policy: {} });
    expect(await s.deleteNode(ID)).toBe(true);
    expect((await s.listRoutes()).some((r) => r.alias === `node/${ID}`)).toBe(false);
  });
});
