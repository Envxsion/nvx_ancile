/**
 * "Keep apart" / "Show together" for two notebooks that are one repository,
 * on both backends: one row per pair, found from either side, the last
 * choice wins.
 */
import { beforeEach, expect, it } from 'vitest';
import { MemoryRepoPairStore, PgRepoPairStore, type RepoPairStore } from '../../src/claudecode/same-repo';
import { eachBackend, uid } from '../support/stores';

eachBackend('same-repository choices', (backend) => {
  let pairs: RepoPairStore;
  beforeEach(() => {
    const b = backend();
    pairs = b.sql ? new PgRepoPairStore(b.sql) : new MemoryRepoPairStore();
  });

  it('keeps one choice per pair, whichever side it was made from', async () => {
    const a = uid('nbk');
    const b = uid('nbk');
    await pairs.set(b, a, 'keep_apart');
    await pairs.set(a, b, 'show_together');
    const mine = (await pairs.all()).filter((p) => [a, b].includes(p.a));
    expect(mine).toEqual([{ a: a < b ? a : b, b: a < b ? b : a, choice: 'show_together' }]);
  });
});
