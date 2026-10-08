/**
 * ------------------------------------------------------------------
 *  Title    |  Drafts and UI state
 *  Ref      |  DESIGN.md §9.4 (nothing you typed is ever lost)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A half-written message survives a reload, a crash and
 *           |  a different device; so does where you were (scroll
 *           |  position, open panels).
 *  How      |  Drafts are keyed by thread and the message they reply
 *           |  to ('' for a first message); an empty draft deletes the
 *           |  row. UI state is opaque JSON per key, capped at 64 kB.
 * ------------------------------------------------------------------
 */

import { Draft } from '@nvx/contracts';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { badRequest } from '../obs/errors';

export interface StateStore {
  getDraft(threadId: string, parentId: string): Promise<Draft | undefined>;
  putDraft(threadId: string, parentId: string, text: string): Promise<Draft>;
  getUi(key: string): Promise<unknown>;
  putUi(key: string, value: unknown): Promise<void>;
}

export class PgStateStore implements StateStore {
  constructor(
    private readonly sql: Sql,
    private readonly userId: string,
  ) {}

  async getDraft(threadId: string, parentId: string) {
    const rows = await this.sql<{ content: { text?: string }; updated_at: Date }[]>`
      select content, updated_at from core.drafts where thread_id = ${threadId} and parent_id = ${parentId} and user_id = ${this.userId}`;
    const r = rows[0];
    return r ? { text: r.content.text ?? '', updated_at: r.updated_at.toISOString() } : undefined;
  }

  async putDraft(threadId: string, parentId: string, text: string) {
    if (!text) {
      await this
        .sql`delete from core.drafts where thread_id = ${threadId} and parent_id = ${parentId} and user_id = ${this.userId}`;
      return { text: '' };
    }
    const rows = await this.sql<{ updated_at: Date }[]>`
      insert into core.drafts (thread_id, parent_id, user_id, content) values (${threadId}, ${parentId}, ${this.userId}, ${this.sql.json({ text })})
      on conflict (thread_id, parent_id, user_id) do update set content = excluded.content, updated_at = now()
      returning updated_at`;
    return { text, updated_at: (rows[0] as { updated_at: Date }).updated_at.toISOString() };
  }

  async getUi(key: string) {
    const rows = await this.sql<
      { value: unknown }[]
    >`select value from core.ui_state where user_id = ${this.userId} and key = ${key}`;
    return rows[0]?.value;
  }

  async putUi(key: string, value: unknown) {
    // null means "forget it": the client falls back to its defaults.
    if (value === null || value === undefined) {
      await this.sql`delete from core.ui_state where user_id = ${this.userId} and key = ${key}`;
      return;
    }
    await this.sql`
      insert into core.ui_state (user_id, key, value) values (${this.userId}, ${key}, ${this.sql.json(value as never)})
      on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`;
  }
}

export class MemoryStateStore implements StateStore {
  drafts = new Map<string, Draft>();
  ui = new Map<string, unknown>();
  async getDraft(t: string, p: string) {
    return this.drafts.get(`${t}/${p}`);
  }
  async putDraft(t: string, p: string, text: string) {
    if (!text) {
      this.drafts.delete(`${t}/${p}`);
      return { text: '' };
    }
    const d = { text, updated_at: new Date().toISOString() };
    this.drafts.set(`${t}/${p}`, d);
    return d;
  }
  async getUi(k: string) {
    return this.ui.get(k);
  }
  async putUi(k: string, v: unknown) {
    if (v === null || v === undefined) this.ui.delete(k);
    else this.ui.set(k, v);
  }
}

const KEY = /^[a-z0-9._:-]{1,120}$/i;
const parentKey = (p: string) => (p === '_' || p === 'root' ? '' : p);

export function stateRoutes(store: StateStore) {
  const r = new Hono<AppEnv>();

  r.get('/drafts/:thread/:parent', async (c) => {
    const d = await store.getDraft(c.req.param('thread'), parentKey(c.req.param('parent')));
    return c.json(d ?? { text: '' });
  });

  r.put('/drafts/:thread/:parent', async (c) => {
    const req = await body(c, Draft);
    return c.json(await store.putDraft(c.req.param('thread'), parentKey(c.req.param('parent')), req.text));
  });

  r.get('/ui-state/:key', async (c) => {
    const key = c.req.param('key');
    if (!KEY.test(key)) throw badRequest('That key is not valid');
    const value = await store.getUi(key);
    return c.json({ key, value: value ?? null });
  });

  r.put('/ui-state/:key', async (c) => {
    const key = c.req.param('key');
    if (!KEY.test(key)) throw badRequest('That key is not valid');
    const text = await c.req.text();
    if (text.length > 65_536) throw badRequest('UI state is limited to 64 kB per key');
    let value: unknown;
    try {
      value = (JSON.parse(text) as { value?: unknown }).value ?? null;
    } catch {
      throw badRequest('The body is not valid JSON');
    }
    await store.putUi(key, value);
    return c.json({ key, value });
  });

  return r;
}
