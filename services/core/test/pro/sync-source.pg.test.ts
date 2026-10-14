/**
 * What sync may carry from Core (needs CORE_TEST_DATABASE_URL; a throwaway
 * database): anything whose notebook or thread keeps data on this machine
 * goes as `local`, without its data; nothing arriving from another computer
 * lands there; a withdrawn copy is emptied; a deletion carries no content;
 * and device-only preferences never leave or arrive.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { ensureOwner, type Owner } from '../../src/db/bootstrap';
import { migrate } from '../../src/db/migrate';
import { sqlSyncSource } from '../../src/pro/sync-source';
import type { ProSyncChange, ProSyncSource } from '../../src/pro/types';
import { PgScopeStore } from '../../src/scopes';
import { type Throwaway, throwawayDb } from '../support/throwaway-db';

const base = inject('pgUrl');

type Row = Record<string, unknown>;
const byId = (list: ProSyncChange[]) => new Map(list.map((c) => [c.id, c]));

describe.skipIf(!base)('the sync source (postgres)', () => {
  let db: Throwaway;
  let owner: Owner;
  let src: ProSyncSource;
  let scopes: PgScopeStore;

  beforeAll(async () => {
    db = await throwawayDb(base as string, 'ancile_coretest_syncsource');
    await migrate(db.sql);
    owner = await ensureOwner(db.sql);
    src = sqlSyncSource(db.sql, owner);
    scopes = new PgScopeStore(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
  });

  const sql = () => db.sql;
  const notebook = (id: string, title: string, priv = false) =>
    sql()`insert into core.notebooks (id, workspace_id, title, slug, memory_path, private)
          values (${id}, ${owner.workspaceId}, ${title}, ${id}, ${`notebooks/${id}`}, ${priv})`;
  const thread = (id: string, nb: string | null, title = 'A thread') =>
    sql()`insert into core.threads (id, workspace_id, notebook_id, title) values (${id}, ${owner.workspaceId}, ${nb}, ${title})`;
  const message = (id: string, th: string, text: string) =>
    sql()`insert into core.messages (id, thread_id, role, parts, status, trace_id)
          values (${id}, ${th}, 'user', ${sql().json([{ type: 'text', text }] as never)}, 'complete', 'trc')`;
  const note = (id: string, nb: string, text: string) =>
    sql()`insert into core.notes (id, notebook_id, kind, title, content_md) values (${id}, ${nb}, 'human', 'A note', ${text})`;
  const flow = (id: string, scope: string, ref: string | null) =>
    sql()`insert into core.flows (id, workspace_id, scope, scope_ref, name, graph)
          values (${id}, ${owner.workspaceId}, ${scope}, ${ref}, 'A flow', ${sql().json({ nodes: [] } as never)})`;

  beforeEach(async () => {
    await sql().unsafe(`
      delete from core.summaries; delete from core.drafts;
      delete from core.flow_versions; delete from core.flows; delete from core.notes; delete from core.messages;
      delete from core.threads; delete from core.scopes; delete from core.notebooks; delete from core.ui_state;`);
    // Shared: nb_open with thr_open (and thr_quiet, which keeps data here on its own).
    // Private: nb_priv with thr_priv.
    await notebook('nb_open', 'Open notebook');
    await notebook('nb_priv', 'Private notebook', true);
    await thread('thr_open', 'nb_open');
    await thread('thr_quiet', 'nb_open');
    await thread('thr_priv', 'nb_priv', 'Secret plans');
    await scopes.mergePatch('thread', 'thr_quiet', { data_leaves_machine: false });
    await message('msg_open', 'thr_open', 'hello');
    await message('msg_quiet', 'thr_quiet', 'quiet words');
    await message('msg_priv', 'thr_priv', 'the launch date');
    await note('not_open', 'nb_open', 'shared note');
    await note('not_priv', 'nb_priv', 'private note');
    await flow('flw_ws', 'workspace', null);
    await flow('flw_priv', 'notebook', 'nb_priv');
    await flow('flw_quiet', 'thread', 'thr_quiet');
    await flow('flw_open', 'thread', 'thr_open');
  });

  it('hands over what keeps data here as local, without its data', async () => {
    const nbs = byId(await src.changes('notebooks', null));
    expect(nbs.get('nb_open')).toMatchObject({ data: { title: 'Open notebook' } });
    expect(nbs.get('nb_priv')).toEqual({ id: 'nb_priv', updatedAt: expect.any(String), local: true });

    const ths = byId(await src.changes('threads', null));
    expect(ths.get('thr_open')?.local).toBeFalsy();
    expect(ths.get('thr_quiet')?.local).toBe(true);
    expect(ths.get('thr_priv')).not.toHaveProperty('data');

    const msgs = byId(await src.changes('messages', null));
    expect(msgs.get('msg_open')).toHaveProperty('data');
    expect(msgs.get('msg_quiet')).toMatchObject({ local: true });
    expect(msgs.get('msg_priv')).toMatchObject({ local: true });
    expect(JSON.stringify([...msgs.values()])).not.toContain('launch date');

    const notes = byId(await src.changes('notes', null));
    expect(notes.get('not_open')).toHaveProperty('data');
    expect(notes.get('not_priv')).toMatchObject({ local: true });

    const flows = byId(await src.changes('flows', null));
    expect(flows.get('flw_ws')).toHaveProperty('data');
    expect(flows.get('flw_open')).toHaveProperty('data');
    expect(flows.get('flw_priv')).toMatchObject({ local: true });
    expect(flows.get('flw_quiet')).toMatchObject({ local: true });
  });

  it('lists the places that keep data here, as the scopes say now', async () => {
    expect(await src.localPlaces()).toEqual(['notebook:nb_priv', 'thread:thr_priv', 'thread:thr_quiet']);
    // Data leaving switched off for a whole notebook: it and every thread in it.
    await scopes.mergePatch('notebook', 'nb_open', { data_leaves_machine: false });
    expect(await src.localPlaces()).toEqual([
      'notebook:nb_open',
      'notebook:nb_priv',
      'thread:thr_open',
      'thread:thr_priv',
      'thread:thr_quiet',
    ]);
    // Back on, and the private notebook made shareable: only the quiet thread is left.
    await scopes.mergePatch('notebook', 'nb_open', { data_leaves_machine: true });
    await scopes.setPrivate('nb_priv', false);
    expect(await src.localPlaces()).toEqual(['thread:thr_quiet']);
  });

  it('a thread moved into a private notebook becomes a local place', async () => {
    await sql()`update core.threads set notebook_id = 'nb_priv', updated_at = now() where id = 'thr_open'`;
    expect(await src.localPlaces()).toContain('thread:thr_open');
  });

  it('finds everything inside a place, deleted items included', async () => {
    await sql()`update core.notes set deleted_at = now() where id = 'not_priv'`;
    const items = await src.itemsIn(['notebook:nb_priv']);
    expect(items.map((i) => `${i.collection}/${i.id}`).sort()).toEqual([
      'flows/flw_priv',
      'messages/msg_priv',
      'notebooks/nb_priv',
      'notes/not_priv',
      'threads/thr_priv',
    ]);
    const quiet = await src.itemsIn(['thread:thr_quiet']);
    expect(quiet.map((i) => i.id).sort()).toEqual(['flw_quiet', 'msg_quiet', 'thr_quiet']);
    expect(await src.itemsIn([])).toEqual([]);
  });

  it('never writes an arriving item into a place that keeps data here', async () => {
    const arriving = [
      { id: 'msg_new_priv', data: { id: 'msg_new_priv', thread_id: 'thr_priv' } },
      { id: 'msg_new_open', data: { id: 'msg_new_open', thread_id: 'thr_open' } },
      // A deletion carries no place: the copy here says where it is.
      { id: 'msg_quiet', data: { deleted: true } },
    ];
    expect([...(await src.localOnly('messages', arriving))].sort()).toEqual(['msg_new_priv', 'msg_quiet']);
    expect(
      await src.localOnly('threads', [{ id: 'thr_new', data: { id: 'thr_new', notebook_id: 'nb_priv' } }]),
    ).toEqual(new Set(['thr_new']));
    expect(await src.localOnly('notes', [{ id: 'not_x', data: { notebook_id: 'nb_open' } }])).toEqual(
      new Set(),
    );
    // A notebook another computer withdrew counts as local here.
    expect(
      await src.localOnly('notes', [{ id: 'not_x', data: { notebook_id: 'nb_open' } }], ['notebook:nb_open']),
    ).toEqual(new Set(['not_x']));
    const withdrawnHere = byId(await src.changes('messages', null, ['thread:thr_open']));
    expect(withdrawnHere.get('msg_open')).toMatchObject({ local: true });
    expect(await src.localOnly('preferences', [{ id: 'prefs', data: {} }])).toEqual(new Set());
  });

  it('writes a message that is new here, and its reply after it', async () => {
    const at = (s: number) => new Date(Date.parse('2026-10-12T10:00:00Z') + s * 1000).toISOString();
    const n = await src.apply('messages', [
      {
        id: 'msg_b',
        deleted: false,
        data: {
          id: 'msg_b',
          thread_id: 'thr_open',
          parent_id: 'msg_a',
          role: 'assistant',
          parts: [{ type: 'text', text: 'an answer' }],
          status: 'complete',
          provenance: {},
          created_at: at(2),
        },
      },
      {
        id: 'msg_a',
        deleted: false,
        data: {
          id: 'msg_a',
          thread_id: 'thr_open',
          parent_id: null,
          role: 'user',
          parts: [{ type: 'text', text: 'a question' }],
          status: 'complete',
          provenance: {},
          created_at: at(1),
        },
      },
    ]);
    expect(n).toBe(2);
    const [row] = await sql()<{ trace_id: string; parent_id: string }[]>`
      select trace_id, parent_id from core.messages where id = 'msg_b'`;
    expect(row).toEqual({ trace_id: '0'.repeat(32), parent_id: 'msg_a' });
  });

  it('marks a deletion without needing its content, and ignores one for an item it never had', async () => {
    expect(await src.apply('notes', [{ id: 'not_open', deleted: true, data: { deleted: true } }])).toBe(1);
    expect(await src.apply('notes', [{ id: 'not_never', deleted: true, data: { deleted: true } }])).toBe(0);
    const [r] = await sql()<{ deleted_at: Date | null; content_md: string }[]>`
      select deleted_at, content_md from core.notes where id = 'not_open'`;
    expect(r?.deleted_at).toBeInstanceOf(Date);
    expect(r?.content_md).toBe('shared note');
    // A deleted item's change carries the time only; the engine seals a tombstone for it.
    expect(byId(await src.changes('notes', null)).get('not_open')).toMatchObject({
      data: { deleted_at: expect.any(Date) },
    });
  });

  it('empties and deletes a copy another computer withdrew', async () => {
    await sql()`insert into core.flow_versions (flow_id, version, name, graph) values ('flw_open', 1, 'v1', '{}')`;
    await sql()`insert into core.summaries (id, thread_id, upto_message_id, kind, content, tokens, model_id)
                values ('sum_1', 'thr_open', 'msg_open', 'tldr', 'They said hello', 4, 'm')`;
    await sql()`update core.threads set pinned_tldr_id = 'sum_1' where id = 'thr_open'`;
    await sql()`insert into core.drafts (thread_id, parent_id, user_id, content)
                values ('thr_open', '', ${owner.userId}, ${sql().json({ text: 'half a reply' } as never)})`;
    expect(await src.remove('notes', ['not_open', 'not_never'])).toBe(1);
    expect(await src.remove('messages', ['msg_open'])).toBe(1);
    expect(await src.remove('threads', ['thr_open'])).toBe(1);
    expect(await src.remove('flows', ['flw_open'])).toBe(1);
    expect(await src.remove('notebooks', ['nb_open'])).toBe(1);
    expect(await src.remove('preferences', ['prefs'])).toBe(0);
    const [n] = await sql()<
      Row[]
    >`select title, content_md, deleted_at from core.notes where id = 'not_open'`;
    expect(n).toMatchObject({ title: '', content_md: '', deleted_at: expect.any(Date) });
    const [m] = await sql()<Row[]>`select parts from core.messages where id = 'msg_open'`;
    expect(m?.parts).toEqual([]);
    const [t] = await sql()<Row[]>`select title, pinned_tldr_id from core.threads where id = 'thr_open'`;
    expect(t).toEqual({ title: '', pinned_tldr_id: null });
    expect(await sql()`select 1 from core.summaries where thread_id = 'thr_open'`).toHaveLength(0);
    expect(await sql()`select 1 from core.drafts where thread_id = 'thr_open'`).toHaveLength(0);
    const [nb] = await sql()<Row[]>`select title, slug, description from core.notebooks where id = 'nb_open'`;
    expect(nb).toEqual({ title: '', slug: 'nb_open', description: null });
    const [f] = await sql()<Row[]>`select name, graph, active from core.flows where id = 'flw_open'`;
    expect(f).toEqual({ name: '', graph: {}, active: false });
    expect(await sql()`select 1 from core.flow_versions where flow_id = 'flw_open'`).toHaveLength(0);
  });

  it('reads a flow with its versions, the same as it sends it', async () => {
    await sql()`insert into core.flow_versions (flow_id, version, name, graph) values ('flw_ws', 1, 'v1', '{}')`;
    const sent = byId(await src.changes('flows', null)).get('flw_ws');
    const here = await src.read('flows', 'flw_ws');
    expect(here).toEqual(sent && 'data' in sent ? sent.data : null);
    expect((here as { versions: unknown[] }).versions).toHaveLength(1);
  });

  describe('preferences', () => {
    const put = (key: string, value: unknown) =>
      sql()`insert into core.ui_state (user_id, key, value) values (${owner.userId}, ${key}, ${sql().json(value as never)})
            on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`;
    const storedUi = async (key: string) =>
      (
        await sql()<
          { value: Row }[]
        >`select value from core.ui_state where user_id = ${owner.userId} and key = ${key}`
      )[0]?.value;

    it('never carries device-only settings, even from an old copy that still has them', async () => {
      // An older Cockpit wrote everything to Core, custom CSS included.
      await put('prefs', {
        prefs: {
          appearance: { theme: 'dark', zoom: 1.25 },
          advanced: { css: 'body{display:none}', performance: 'lite', developer: true },
          layout: { density: 'compact', railWidth: 300 },
        },
        changedAt: 5,
      });
      await put('help', { tours: { intro: 'done' } });
      await put('scroll.thr_open', { top: 420 });
      const out = byId(await src.changes('preferences', null));
      expect([...out.keys()].sort()).toEqual(['help', 'prefs']);
      const sent = JSON.stringify(out.get('prefs'));
      expect(sent).not.toContain('display:none');
      expect(sent).not.toContain('zoom');
      expect(sent).not.toContain('railWidth');
      expect(sent).not.toContain('performance');
      expect(out.get('prefs')).toMatchObject({
        data: {
          value: { prefs: { appearance: { theme: 'dark' }, advanced: { developer: true } }, changedAt: 5 },
        },
      });
      // Read for a conflict copy the same way it is sent.
      expect(await src.read('preferences', 'prefs')).toEqual((out.get('prefs') as { data: unknown }).data);
      expect(await src.read('preferences', 'scroll.thr_open')).toBeNull();
    });

    it('keeps this machine’s own device settings when preferences arrive, and takes none from elsewhere', async () => {
      await put('prefs', {
        prefs: { appearance: { theme: 'dark', zoom: 1.1 }, advanced: { css: 'mine' } },
        changedAt: 1,
      });
      await src.apply('preferences', [
        {
          id: 'prefs',
          deleted: false,
          data: {
            value: {
              prefs: {
                appearance: { theme: 'light', zoom: 2 },
                advanced: { css: '.approval{opacity:0}', developer: true },
                keyboard: { browserSafe: true, vim: true },
              },
              changedAt: 9,
            },
          },
        },
      ]);
      const v = (await storedUi('prefs')) as { prefs: Record<string, Row>; changedAt: number };
      expect(v.changedAt).toBe(9);
      expect(v.prefs.appearance).toEqual({ theme: 'light', zoom: 1.1 });
      expect(v.prefs.advanced).toEqual({ developer: true, css: 'mine' });
      expect(v.prefs.keyboard).toEqual({ vim: true });
      expect(JSON.stringify(v)).not.toContain('opacity:0');
    });

    it('takes no device setting from elsewhere when this machine has none', async () => {
      await src.apply('preferences', [
        {
          id: 'prefs',
          deleted: false,
          data: { value: { prefs: { advanced: { css: 'x{}' } }, changedAt: 2 } },
        },
      ]);
      expect(await storedUi('prefs')).toEqual({ prefs: { advanced: {} }, changedAt: 2 });
    });

    it('ignores UI state about another screen, from an older computer', async () => {
      expect(
        await src.apply('preferences', [
          { id: 'scroll.thr_open', deleted: false, data: { value: { top: 9 } } },
        ]),
      ).toBe(0);
      expect(await storedUi('scroll.thr_open')).toBeUndefined();
    });
  });
});
