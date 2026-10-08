/**
 * ------------------------------------------------------------------
 *  Title    |  Notifications
 *  Ref      |  DESIGN.md §4.1 (State), §13.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every notice Core sends is also kept, so the
 *           |  notification centre shows what happened while the tab
 *           |  was closed, with read state that follows you.
 *  How      |  A sink subscribes to the event bus and writes each
 *           |  `notification` event once (its id is the primary key,
 *           |  so a replayed event is a no-op). GET lists newest
 *           |  first with a cursor; POST /read marks ids or all.
 *  Note     |  Kept for 90 days; older rows are pruned on start.
 * ------------------------------------------------------------------
 */

import {
  type GlobalEvent,
  MarkNotificationsRead,
  type NotificationItem,
  type NotificationList,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../app';
import type { EventBus } from '../events/bus';
import { body } from '../http/body';
import { logFor } from '../obs/logger';

const log = logFor('notifications');
const KEEP_DAYS = 90;

type Notice = Extract<GlobalEvent, { type: 'notification' }>;

export interface NotificationStore {
  add(n: Notice, at: string): Promise<void>;
  list(opts: { limit: number; cursor?: string; unreadOnly?: boolean }): Promise<NotificationList>;
  markRead(opts: { ids?: string[]; all?: boolean }): Promise<number>;
  prune(days: number): Promise<void>;
}

interface Row {
  id: string;
  kind: string;
  level: NotificationItem['level'];
  title: string;
  body: string | null;
  action: NotificationItem['action'];
  trace_id: string | null;
  read_at: Date | null;
  created_at: Date;
}

const toItem = (r: Row): NotificationItem => ({
  id: r.id,
  kind: r.kind,
  level: r.level,
  title: r.title,
  body: r.body,
  action: r.action ?? null,
  trace_id: r.trace_id,
  read_at: r.read_at ? r.read_at.toISOString() : null,
  created_at: r.created_at.toISOString(),
});

/** Cursor = "<iso created_at>|<id>", newest first. */
const cursorOf = (i: NotificationItem) => `${i.created_at}|${i.id}`;
function parseCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c) return null;
  const [at, id] = c.split('|');
  return at && id && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
}

export class PgNotificationStore implements NotificationStore {
  constructor(
    private readonly sql: Sql,
    private readonly userId: string,
  ) {}

  async add(n: Notice, at: string) {
    await this.sql`
      insert into core.notifications (id, user_id, kind, level, title, body, action, trace_id, created_at)
      values (${n.id}, ${this.userId}, ${n.category ?? 'general'}, ${n.level}, ${n.title}, ${n.body ?? null},
              ${n.action ? this.sql.json(n.action) : null}, null, ${at})
      on conflict (id) do nothing`;
  }

  async list({ limit, cursor, unreadOnly }: { limit: number; cursor?: string; unreadOnly?: boolean }) {
    const c = parseCursor(cursor);
    const rows = await this.sql<Row[]>`
      select id, kind, level, title, body, action, trace_id, read_at, created_at from core.notifications
      where user_id = ${this.userId}
        ${unreadOnly ? this.sql`and read_at is null` : this.sql``}
        ${c ? this.sql`and (created_at, id) < (${c.at}::timestamptz, ${c.id})` : this.sql``}
      order by created_at desc, id desc limit ${limit + 1}`;
    const counted = await this.sql<{ n: number }[]>`
      select count(*)::int as n from core.notifications where user_id = ${this.userId} and read_at is null`;
    const n = counted[0]?.n ?? 0;
    const items = rows.slice(0, limit).map(toItem);
    const last = items.at(-1);
    return { items, unread: n, next_cursor: rows.length > limit && last ? cursorOf(last) : null };
  }

  async markRead({ ids, all }: { ids?: string[]; all?: boolean }) {
    const res = all
      ? await this
          .sql`update core.notifications set read_at = now() where user_id = ${this.userId} and read_at is null`
      : await this.sql`update core.notifications set read_at = now()
          where user_id = ${this.userId} and read_at is null and id = any(${ids ?? []})`;
    return res.count;
  }

  async prune(days: number) {
    await this.sql`delete from core.notifications where created_at < now() - make_interval(days => ${days})`;
  }
}

export class MemoryNotificationStore implements NotificationStore {
  rows: NotificationItem[] = [];
  async add(n: Notice, at: string) {
    if (this.rows.some((r) => r.id === n.id)) return;
    this.rows.push({
      id: n.id,
      kind: n.category ?? 'general',
      level: n.level,
      title: n.title,
      body: n.body ?? null,
      action: n.action ?? null,
      trace_id: null,
      read_at: null,
      created_at: at,
    });
  }
  async list({ limit, cursor, unreadOnly }: { limit: number; cursor?: string; unreadOnly?: boolean }) {
    const c = parseCursor(cursor);
    const sorted = [...this.rows]
      .filter((r) => !unreadOnly || !r.read_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .filter((r) => !c || r.created_at < c.at || (r.created_at === c.at && r.id < c.id));
    const items = sorted.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      unread: this.rows.filter((r) => !r.read_at).length,
      next_cursor: sorted.length > limit && last ? cursorOf(last) : null,
    };
  }
  async markRead({ ids, all }: { ids?: string[]; all?: boolean }) {
    let n = 0;
    const now = new Date().toISOString();
    for (const r of this.rows)
      if (!r.read_at && (all || ids?.includes(r.id))) {
        r.read_at = now;
        n++;
      }
    return n;
  }
  async prune() {}
}

/** Keep every notification the bus carries. Returns the unsubscribe. */
export function startNotificationSink(bus: EventBus, store: NotificationStore): () => void {
  void store.prune(KEEP_DAYS).catch((err) => log.warn({ err }, 'could not prune old notifications'));
  return bus.subscribe(Number.MAX_SAFE_INTEGER, (e) => {
    if (e.type !== 'notification') return;
    void store.add(e, e.at).catch((err) => log.warn({ err }, 'could not keep a notification'));
  });
}

export function notificationRoutes(store: NotificationStore) {
  const r = new Hono<AppEnv>();

  r.get('/notifications', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
    const cursor = c.req.query('cursor') || undefined;
    const unreadOnly = c.req.query('unread') === '1';
    return c.json(await store.list({ limit, ...(cursor && { cursor }), unreadOnly }));
  });

  r.post('/notifications/read', async (c) => {
    const req = await body(c, MarkNotificationsRead);
    const marked = await store.markRead({ ...(req.ids && { ids: req.ids }), ...(req.all && { all: true }) });
    return c.json({ marked });
  });

  return r;
}
