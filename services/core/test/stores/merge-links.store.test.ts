/**
 * Phase 3 (C) stores: context links in memory and on Postgres, and a whole
 * notebook merge on Postgres (one transaction each way), with the scope
 * narrowed, citations of a merged copy still resolving, and undo.
 */
import { beforeEach, expect, it } from 'vitest';
import { PgTombstoneStore, sourceIntegrity } from '../../src/knowledge/integrity';
import { LinkService } from '../../src/links/service';
import { type LinkStore, MemoryLinkStore, PgLinkStore } from '../../src/links/store';
import { NotebookMergeService } from '../../src/notebooks/merge';
import { PgMergeStore } from '../../src/notebooks/merge-store';
import { getEffectiveScope, PgScopeStore, scopeResolver } from '../../src/scopes';
import { FakeKnowledge, FakeMemory } from '../notebooks/merge-fakes';
import { eachBackend, uid } from '../support/stores';

eachBackend('context links', (backend) => {
  let store: LinkStore;
  let ws: string;
  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    store = b.sql ? new PgLinkStore(b.sql) : new MemoryLinkStore();
  });

  it('keeps one link per pair, lists both ends oldest first, and removes', async () => {
    const t = uid('thr');
    const a = uid('nbk');
    const b = uid('nbk');
    const one = await store.create({
      id: uid('lnk'),
      workspace_id: ws,
      from_kind: 'thread',
      from_id: t,
      to_kind: 'notebook',
      to_id: a,
      kind: 'sources',
    });
    expect(one).toMatchObject({ from_id: t, to_id: a, kind: 'sources' });
    const again = await store.create({
      id: uid('lnk'),
      workspace_id: ws,
      from_kind: 'thread',
      from_id: t,
      to_kind: 'notebook',
      to_id: a,
      kind: 'sources',
    });
    expect(again).toBeUndefined();
    const two = await store.create({
      id: uid('lnk'),
      workspace_id: ws,
      from_kind: 'notebook',
      from_id: b,
      to_kind: 'notebook',
      to_id: a,
      kind: 'sources',
    });
    expect(
      (
        await store.outgoing([
          { kind: 'thread', id: t },
          { kind: 'notebook', id: b },
        ])
      ).map((l) => l.id),
    ).toEqual([one?.id, two?.id]);
    expect((await store.incoming({ kind: 'notebook', id: a })).map((l) => l.id)).toEqual([one?.id, two?.id]);
    expect(await store.outgoing([])).toEqual([]);
    expect((await store.get(one?.id ?? ''))?.to_id).toBe(a);
    expect(await store.remove(one?.id ?? '')).toBe(true);
    expect(await store.remove(one?.id ?? '')).toBe(false);
    expect(await store.get(one?.id ?? '')).toBeUndefined();
  });
});

eachBackend('notebook merge', (backend) => {
  it('merges and undoes on Postgres in one transaction each way', async () => {
    const b = backend();
    if (!b.sql) return; // The in-memory store is covered by test/notebooks/merge.test.ts.
    const sql = b.sql;
    const ws = b.owner.workspaceId;
    const A = uid('nbk');
    const B = uid('nbk');
    const C = uid('nbk');
    const slug = (id: string) => id.toLowerCase();
    for (const [id, title] of [
      [A, 'Alpha'],
      [B, 'Bravo'],
      [C, 'Charlie'],
    ] as const)
      await sql`insert into core.notebooks (id, workspace_id, title, slug, memory_path, settings)
        values (${id}, ${ws}, ${title}, ${slug(id)}, ${`notebooks/${slug(id)}`},
          ${sql.json({ ancile: { instructions: `${title} rules`, persona: '' } })})`;
    const tA = uid('thr');
    const tB = uid('thr');
    await sql`insert into core.threads (id, workspace_id, notebook_id, title) values
      (${tA}, ${ws}, ${A}, 'Alpha thread'), (${tB}, ${ws}, ${B}, 'Bravo thread')`;
    const note = uid('not');
    await sql`insert into core.notes (id, notebook_id, kind, title, content_md) values (${note}, ${B}, 'human', 'N', 'x')`;
    const fA = uid('flw');
    const fB = uid('flw');
    const graph = sql.json({ nodes: [], edges: [] });
    await sql`insert into core.flows (id, workspace_id, scope, scope_ref, name, graph, active) values
      (${fA}, ${ws}, 'notebook', ${A}, 'A flow', ${graph}, true),
      (${fB}, ${ws}, 'notebook', ${B}, 'B flow', ${graph}, true)`;
    const cwdKey = `c:\\work\\${B.toLowerCase()}`;
    await sql`insert into core.claude_code_projects (workspace_id, cwd_key, cwd, notebook_id)
      values (${ws}, ${cwdKey}, ${`C:/work/${B}`}, ${B})`;
    const lCB = uid('lnk');
    const lAB = uid('lnk');
    await sql`insert into core.context_links (id, workspace_id, from_kind, from_id, to_kind, to_id, kind) values
      (${lCB}, ${ws}, 'notebook', ${C}, 'notebook', ${B}, 'sources'),
      (${lAB}, ${ws}, 'notebook', ${A}, 'notebook', ${B}, 'sources')`;
    const hist = uid('ssh');
    await sql`insert into core.scope_shared_history (id, level, ref_id, change, turns, destinations)
      values (${hist}, 'notebook', ${B}, 'private', 3, ${sql.json([{ destination: 'anthropic', turns: 3 }])})`;
    const scopes = new PgScopeStore(sql);
    await scopes.mergePatch('notebook', A, { network: false });
    await scopes.mergePatch('notebook', B, { memory_write: false, tools_allow: ['fs.read'] });
    await scopes.setPrivate(B, true);

    const kn = new FakeKnowledge();
    const sA = uid('src');
    const sCopy = uid('src');
    const sOwn = uid('src');
    kn.add(A, { id: sA, title: 'Manual', kind: 'file', uri: null, hash: 'h1' });
    kn.add(B, { id: sCopy, title: 'Manual copy', kind: 'file', uri: null, hash: 'h1' });
    kn.add(B, { id: sOwn, title: 'Trial', kind: 'text', uri: null, hash: 'h2' });
    const memory = new FakeMemory();
    const merge = new NotebookMergeService({
      workspaceId: ws,
      store: new PgMergeStore(sql),
      scopes,
      kn,
      memory,
    });

    const p = await merge.preview(A, B);
    expect(p.threads.map((t) => t.id)).toEqual([tB]);
    expect(p.flows).toEqual([{ id: fB, name: 'B flow', active: true, switched_off: true }]);
    expect(p.links).toEqual({ retarget: 1, dropped: 1 });
    expect(p.scope.private.merged).toBe(true);

    const m = await merge.apply(A, { from_id: B, instructions: { choice: 'from' } });
    expect(m.counts).toMatchObject({
      threads: 1,
      notes: 1,
      flows: 1,
      folders: 1,
      links: 1,
      sources_deduplicated: 1,
    });
    const [thread] = await sql<
      { notebook_id: string }[]
    >`select notebook_id from core.threads where id = ${tB}`;
    expect(thread?.notebook_id).toBe(A);
    const [flow] = await sql<
      { scope_ref: string; active: boolean }[]
    >`select scope_ref, active from core.flows where id = ${fB}`;
    expect(flow).toEqual({ scope_ref: A, active: false });
    const [nb] = await sql<{ deleted_at: Date | null; merged_into: string | null }[]>`
      select deleted_at, merged_into from core.notebooks where id = ${B}`;
    expect(nb?.merged_into).toBe(A);
    expect(nb?.deleted_at).not.toBeNull();
    const [proj] = await sql<{ notebook_id: string }[]>`
      select notebook_id from core.claude_code_projects where cwd_key = ${cwdKey} and workspace_id = ${ws}`;
    expect(proj?.notebook_id).toBe(A);
    expect((await sql`select 1 from core.context_links where id = ${lAB}`).length).toBe(0);
    const [cb] = await sql<{ to_id: string }[]>`select to_id from core.context_links where id = ${lCB}`;
    expect(cb?.to_id).toBe(A);
    expect((await sql`select 1 from core.scope_shared_history where ref_id = ${A}`).length).toBe(1);
    // Private wins; the thread that came from B reads A's merged, narrower scope.
    const eff = await getEffectiveScope(scopes, { threadId: tB });
    expect(eff.private).toBe(true);
    expect(eff.scope.network).toBe(false);
    expect(eff.scope.memory_write).toBe(false);
    expect(eff.scope.tools_allow).toEqual(['fs.read']);
    const [settings] = await sql<{ settings: { ancile: { instructions: string } } }[]>`
      select settings from core.notebooks where id = ${A}`;
    expect(settings?.settings.ancile.instructions).toBe('Bravo rules');
    // Citations of B's copy still resolve, naming what it was merged into.
    const tombstones = new PgTombstoneStore(sql);
    const [check] = await sourceIntegrity({ workspaceId: ws, tombstones }).check([
      { ref: 'chk', source_id: sCopy, text_sha256: null },
    ]);
    expect(check).toMatchObject({ state: 'removed', source_title: 'Manual copy', merged_into: sA });
    // A link into the merged notebook from a cloud thread is now refused (it is private).
    const links = new LinkService({
      workspaceId: ws,
      store: new PgLinkStore(sql),
      scopes: scopeResolver(scopes),
      lookup: {
        thread: async () => null,
        notebook: async (id) =>
          id === C ? { title: 'Charlie', workspace_id: ws } : { title: 'Alpha', workspace_id: ws },
      },
      summaryOf: async () => null,
    });
    expect((await links.list({ kind: 'notebook', id: C })).outgoing[0]?.status).toMatchObject({
      ok: false,
      code: 'scope.private_notebook',
    });

    const back = await merge.undo(m.id);
    expect(back.undone_at).not.toBeNull();
    const [t2] = await sql<{ notebook_id: string }[]>`select notebook_id from core.threads where id = ${tB}`;
    expect(t2?.notebook_id).toBe(B);
    const [f2] = await sql<
      { scope_ref: string; active: boolean }[]
    >`select scope_ref, active from core.flows where id = ${fB}`;
    expect(f2).toEqual({ scope_ref: B, active: true });
    const [nb2] = await sql<
      { deleted_at: Date | null }[]
    >`select deleted_at from core.notebooks where id = ${B}`;
    expect(nb2?.deleted_at).toBeNull();
    expect(await scopes.isPrivate(A)).toBe(false);
    expect((await scopes.getPatch('notebook', A)).patch).toEqual({ network: false });
    expect((await sql`select 1 from core.context_links where id = ${lAB}`).length).toBe(1);
    expect((await sql`select 1 from core.scope_shared_history where ref_id = ${A}`).length).toBe(0);
    expect((await tombstones.get(ws, [sCopy])).size).toBe(0);
    await expect(merge.undo(m.id)).rejects.toMatchObject({ code: 'notebook.merge_undone' });
    expect((await merge.list(A))[0]?.undone_at).not.toBeNull();
  });
});
