/**
 * Automations from both backends: a built-in changed in Admin keeps its
 * change when automations.yaml is read again, your own are created and
 * deleted, and built-ins cannot be deleted.
 */
import { beforeEach, expect, it } from 'vitest';
import { type AutomationStore, MemoryAutomationStore, PgAutomationStore } from '../../src/automations/runner';
import { eachBackend, uid } from '../support/stores';

eachBackend('automation store', (backend) => {
  let store: AutomationStore;
  beforeEach(() => {
    const b = backend();
    store = b.sql ? new PgAutomationStore(b.sql) : new MemoryAutomationStore();
  });

  it('keeps a customised built-in through a re-read of the file', async () => {
    const id = uid('job');
    await store.ensure([{ id, cron: '0 3 * * *', config: { a: 1 }, enabled: true }]);
    await store.patch(id, { cron: '30 2 * * 0', config: { a: 2 }, customised: true });
    await store.ensure([{ id, cron: '0 4 * * *', config: { a: 3 }, enabled: true }]);
    const row = (await store.list()).find((r) => r.id === id);
    expect(row).toMatchObject({ origin: 'builtin', cron: '30 2 * * 0', config: { a: 2 }, customised: true });

    await store.patch(id, { customised: false });
    await store.ensure([{ id, cron: '0 4 * * *', config: { a: 3 }, enabled: true }]);
    expect((await store.list()).find((r) => r.id === id)).toMatchObject({
      cron: '0 4 * * *',
      config: { a: 3 },
    });
    expect(await store.remove(id)).toBe(false);
  });

  it('creates, changes and deletes your own', async () => {
    const id = uid('aut');
    await store.create({
      id,
      kind: 'notify',
      title: 'Stretch',
      cron: '0 15 * * *',
      config: { title: 'Time to stretch', body: '' },
      enabled: true,
      next_run_at: null,
    });
    await store.patch(id, { title: 'Walk', last_detail: 'Sent the reminder.', last_href: '/t/thr_1' });
    expect((await store.list()).find((r) => r.id === id)).toMatchObject({
      origin: 'user',
      kind: 'notify',
      title: 'Walk',
      last_detail: 'Sent the reminder.',
      last_href: '/t/thr_1',
    });
    expect(await store.remove(id)).toBe(true);
    expect((await store.list()).some((r) => r.id === id)).toBe(false);
  });
});
