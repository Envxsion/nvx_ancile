/**
 * The notification centre's history: notices on the bus are kept once,
 * listed newest first with a cursor, and can be marked read.
 */
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '../../src/events/bus';
import {
  MemoryNotificationStore,
  notificationRoutes,
  startNotificationSink,
} from '../../src/notifications/routes';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('notifications', () => {
  it('keeps each notice once, newest first, and marks them read', async () => {
    const bus = new MemoryEventBus();
    const store = new MemoryNotificationStore();
    startNotificationSink(bus, store);
    for (const i of [1, 2, 3])
      await bus.publish({ type: 'notification', id: `ntf_${i}`, level: 'info', title: `Notice ${i}` });
    await bus.publish({ type: 'run.updated', run_id: 'run_x', status: 'running' } as never);
    await flush();
    expect(store.rows).toHaveLength(3);

    const app = notificationRoutes(store);
    const first = (await (await app.request('/notifications?limit=2')).json()) as {
      items: { id: string }[];
      unread: number;
      next_cursor: string | null;
    };
    expect(first.unread).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const rest = (await (
      await app.request(`/notifications?limit=2&cursor=${encodeURIComponent(first.next_cursor as string)}`)
    ).json()) as { items: { id: string }[]; next_cursor: string | null };
    expect([...first.items, ...rest.items].map((i) => i.id).sort()).toEqual(['ntf_1', 'ntf_2', 'ntf_3']);
    expect(rest.next_cursor).toBeNull();

    const marked = await app.request('/notifications/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['ntf_1'] }),
    });
    expect(((await marked.json()) as { marked: number }).marked).toBe(1);
    await app.request('/notifications/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    const after = (await (await app.request('/notifications?unread=1')).json()) as {
      items: unknown[];
      unread: number;
    };
    expect(after.unread).toBe(0);
    expect(after.items).toHaveLength(0);
  });
});
