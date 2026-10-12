/**
 * Merging notebook B into notebook A (docs/notebooks.md), in memory:
 * preview first, then everything moves; the scope only narrows and
 * private wins; citations of a merged duplicate still resolve; history
 * keeps the merge, and undo puts it all back within the window.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { MemoryTombstoneStore, sourceIntegrity } from '../../src/knowledge/integrity';
import { MemoryLinkStore } from '../../src/links/store';
import { NotebookMergeService } from '../../src/notebooks/merge';
import { MemoryMergeStore } from '../../src/notebooks/merge-store';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { notebookRoutes } from '../../src/notebooks/routes';
import { errorHandler } from '../../src/obs/errors';
import { getEffectiveScope, MemoryScopeStore } from '../../src/scopes';
import { MemoryThreadRepo } from '../../src/threads/repo';
import { FakeKnowledge, FakeMemory } from './merge-fakes';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const B_MEMORY = `---
type: projects
scope: notebook
---
# Bravo

## Findings

- Pumps fail above 50 bar. <!-- m:01AAA -->
- Use the blue gasket. <!-- m:01BBB -->
`;

let now: Date;
let scopes: MemoryScopeStore;
let links: MemoryLinkStore;
let tombstones: MemoryTombstoneStore;
let store: MemoryMergeStore;
let kn: FakeKnowledge;
let memory: FakeMemory;
let merge: NotebookMergeService;

beforeEach(async () => {
  now = new Date('2026-10-12T10:00:00.000Z');
  scopes = new MemoryScopeStore();
  links = new MemoryLinkStore();
  tombstones = new MemoryTombstoneStore();
  store = new MemoryMergeStore({ scopes, links, tombstones, now: () => now });
  kn = new FakeKnowledge();
  memory = new FakeMemory();
  merge = new NotebookMergeService({ workspaceId: WS, store, scopes, kn, memory, now: () => now });

  store.notebooks.set('nbk_a', {
    id: 'nbk_a',
    workspace_id: WS,
    title: 'Alpha',
    slug: 'alpha',
    instructions: { instructions: 'Answer briefly.', persona: '' },
  });
  store.notebooks.set('nbk_b', {
    id: 'nbk_b',
    workspace_id: WS,
    title: 'Bravo',
    slug: 'bravo',
    instructions: { instructions: 'Cite every claim.', persona: 'A careful engineer' },
  });
  store.notebooks.set('nbk_c', { id: 'nbk_c', workspace_id: WS, title: 'Charlie', slug: 'charlie' });
  for (const id of ['nbk_a', 'nbk_b', 'nbk_c']) scopes.notebooks.add(id);
  for (const [id, title, nb, cwd] of [
    ['thr_a1', 'Alpha thread', 'nbk_a', null],
    ['thr_b1', 'Bravo thread', 'nbk_b', null],
    ['thr_b2', 'Claude Code in repo', 'nbk_b', 'C:/work/repo-b'],
  ] as const) {
    store.threads.set(id, { title, notebook_id: nb, cwd });
    scopes.threads.set(id, nb);
  }
  store.notes.set('not_b1', { title: 'Bravo note', notebook_id: 'nbk_b' });
  store.flows.set('flw_a', { name: 'Alpha flow', notebook_id: 'nbk_a', active: true });
  store.flows.set('flw_b', { name: 'Bravo flow', notebook_id: 'nbk_b', active: true });
  store.folders.set('c:\\work\\repo-a', { cwd: 'C:/work/repo-a', notebook_id: 'nbk_a' });
  store.folders.set('c:\\work\\repo-b', { cwd: 'C:/work/repo-b', notebook_id: 'nbk_b' });
  store.grants.set('nbk_b', 2);
  store.sharedHistory.set('ssh_b', { notebook_id: 'nbk_b' });

  kn.add('nbk_a', { id: 'src_a_manual', title: 'Pump manual', kind: 'file', uri: null, hash: 'h-manual' });
  kn.add('nbk_a', { id: 'src_a_spec', title: 'Spec', kind: 'text', uri: null, hash: 'h-spec-1' });
  kn.add('nbk_b', {
    id: 'src_b_copy',
    title: 'Pump manual (copy)',
    kind: 'file',
    uri: null,
    hash: 'h-manual',
  });
  kn.add('nbk_b', { id: 'src_b_spec', title: 'Spec', kind: 'text', uri: null, hash: 'h-spec-2' });
  kn.add(
    'nbk_b',
    { id: 'src_b_own', title: 'Trial log', kind: 'text', uri: null, hash: 'h-trial' },
    'insights',
  );
  kn.link('nbk_b', 'src_a_manual');

  await scopes.mergePatch('notebook', 'nbk_a', { network: false, tools_allow: ['fs.*', 'git.*'] });
  await scopes.mergePatch('notebook', 'nbk_b', { tools_allow: ['fs.read'], memory_write: false });
  await memory.save('PROJECTS/bravo.md', B_MEMORY, null);

  await links.create({
    id: 'lnk_c_to_b',
    workspace_id: WS,
    from_kind: 'notebook',
    from_id: 'nbk_c',
    to_kind: 'notebook',
    to_id: 'nbk_b',
    kind: 'sources',
  });
  await links.create({
    id: 'lnk_a_to_b',
    workspace_id: WS,
    from_kind: 'notebook',
    from_id: 'nbk_a',
    to_kind: 'notebook',
    to_id: 'nbk_b',
    kind: 'sources',
  });
});

describe('previewing a merge', () => {
  it('says everything that would happen, and changes nothing', async () => {
    const p = await merge.preview('nbk_a', 'nbk_b');
    expect(p.into).toEqual({ id: 'nbk_a', title: 'Alpha' });
    expect(p.threads.map((t) => [t.id, t.cwd])).toEqual([
      ['thr_b1', null],
      ['thr_b2', 'C:/work/repo-b'],
    ]);
    expect(p.notes).toEqual([{ id: 'not_b1', title: 'Bravo note' }]);
    expect(p.sources.move.map((s) => s.id).sort()).toEqual(['src_b_own', 'src_b_spec']);
    expect(p.sources.already.map((s) => s.id)).toEqual(['src_a_manual']);
    expect(p.sources.duplicates).toEqual([
      { id: 'src_b_copy', title: 'Pump manual (copy)', into_id: 'src_a_manual', into_title: 'Pump manual' },
    ]);
    expect(p.sources.versions).toEqual([{ id: 'src_b_spec', title: 'Spec', into_id: 'src_a_spec' }]);
    expect(p.memory).toEqual({ from_path: 'PROJECTS/bravo.md', into_path: 'PROJECTS/alpha.md', entries: 2 });
    expect(p.flows).toEqual([{ id: 'flw_b', name: 'Bravo flow', active: true, switched_off: true }]);
    expect(p.instructions.same).toBe(false);
    expect(p.instructions.from.persona).toBe('A careful engineer');
    expect(p.folders).toEqual({ into: ['C:/work/repo-a'], from: ['C:/work/repo-b'] });
    expect(p.links).toEqual({ retarget: 1, dropped: 1 });
    expect(p.grants_left_behind).toBe(2);
    expect(p.undo_hours).toBe(168);
    // The scope only narrows: B's tighter tools and memory switch, A's network off.
    const narrowed = p.scope.changes.filter((c) => c.narrows_into).map((c) => c.field);
    expect(narrowed).toEqual(expect.arrayContaining(['tools_allow', 'memory_write']));
    expect(p.scope.merged).toMatchObject({ network: false, memory_write: false, tools_allow: ['fs.read'] });
    expect(p.warnings.join(' ')).toMatch(/other version.*Both versions are kept/);
    expect(p.warnings.join(' ')).toMatch(/2 remembered approvals/);
    // Nothing moved.
    expect(store.threads.get('thr_b1')?.notebook_id).toBe('nbk_b');
    expect(kn.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('refuses a notebook into itself and notebooks that are not here', async () => {
    await expect(merge.preview('nbk_a', 'nbk_a')).rejects.toMatchObject({ code: 'notebook.merge_self' });
    await expect(merge.preview('nbk_a', 'nbk_zz')).rejects.toMatchObject({ code: 'request.not_found' });
    store.notebooks.set('nbk_x', { id: 'nbk_x', workspace_id: 'wsp_else', title: 'X', slug: 'x' });
    await expect(merge.preview('nbk_x', 'nbk_a')).rejects.toMatchObject({ code: 'request.not_found' });
  });
});

describe('applying a merge', () => {
  it('moves everything into A, narrows the scope and keeps the merge in history', async () => {
    const m = await merge.apply('nbk_a', {
      from_id: 'nbk_b',
      instructions: {
        choice: 'combined',
        instructions: 'Answer briefly. Cite every claim.',
        persona: 'An engineer',
      },
    });
    expect(m.counts).toEqual({
      threads: 2,
      notes: 1,
      sources_moved: 2,
      sources_deduplicated: 1,
      flows: 1,
      folders: 1,
      links: 1,
    });
    expect(m.can_undo).toBe(true);
    expect(m.undo_until).toBe('2026-10-19T10:00:00.000Z');
    expect(m.scope_narrowed).toEqual(expect.arrayContaining(['tools_allow', 'memory_write']));
    // Threads (keeping their own folder), notes, flows (switched off: A has one), folders.
    expect(store.threads.get('thr_b2')).toMatchObject({ notebook_id: 'nbk_a', cwd: 'C:/work/repo-b' });
    expect(store.notes.get('not_b1')?.notebook_id).toBe('nbk_a');
    expect(store.flows.get('flw_b')).toMatchObject({ notebook_id: 'nbk_a', active: false });
    expect(store.flows.get('flw_a')?.active).toBe(true);
    expect([...store.folders.values()].every((f) => f.notebook_id === 'nbk_a')).toBe(true);
    // B is gone, pointing at A.
    expect(store.notebooks.get('nbk_b')).toMatchObject({ deleted: true, merged_into: 'nbk_a' });
    // The thread that was in B now reads A's (narrower) scope.
    const s = await getEffectiveScope(scopes, { threadId: 'thr_b1' });
    expect(s.notebook_id).toBe('nbk_a');
    expect(s.scope.tools_allow).toEqual(['fs.read']);
    expect(s.scope.network).toBe(false);
    expect(s.scope.memory_write).toBe(false);
    // Instructions as chosen; memory appended in one commit.
    expect(store.notebooks.get('nbk_a')?.instructions).toEqual({
      instructions: 'Answer briefly. Cite every claim.',
      persona: 'An engineer',
    });
    const alpha = (await memory.read('PROJECTS/alpha.md'))?.content ?? '';
    expect(alpha).toContain('## Merged from Bravo (2026-10-12)');
    expect(alpha).toContain('- Pumps fail above 50 bar.');
    // Links: C → B now reads A; A → B would point at A itself, so it went.
    expect(links.rows.get('lnk_c_to_b')).toMatchObject({ to_id: 'nbk_a' });
    expect(links.rows.has('lnk_a_to_b')).toBe(false);
    // "Sent before it became private" history follows to A.
    expect([...store.sharedHistory.values()].filter((h) => h.notebook_id === 'nbk_a')).toHaveLength(1);
    // Sources: B's own joined A; the copy merged into A's manual.
    expect(kn.ids('nbk_a').sort()).toEqual(['src_a_manual', 'src_a_spec', 'src_b_own', 'src_b_spec']);
    expect(kn.links.get('nbk_a')?.get('src_b_own')).toBe('insights');
    expect((await merge.list('nbk_a')).map((x) => x.id)).toEqual([m.id]);
    expect((await merge.list('nbk_b')).map((x) => x.id)).toEqual([m.id]);
  });

  it('keeps old citations resolving: a merged copy names the source it was merged into', async () => {
    await merge.apply('nbk_a', { from_id: 'nbk_b' });
    const integrity = sourceIntegrity({ workspaceId: WS, tombstones });
    const [copy, moved] = await integrity.check([
      { ref: 'chk_1', source_id: 'src_b_copy', text_sha256: null },
      { ref: 'chk_2', source_id: 'src_b_own', text_sha256: null },
    ]);
    expect(copy).toMatchObject({
      state: 'removed',
      source_title: 'Pump manual (copy)',
      merged_into: 'src_a_manual',
    });
    expect(moved?.state).toBe('unknown');
    expect(moved?.merged_into).toBeNull();
  });

  it('private wins, and takes A’s instructions by default', async () => {
    await scopes.setPrivate('nbk_b', true);
    const p = await merge.preview('nbk_a', 'nbk_b');
    expect(p.scope.private).toEqual({ into: false, from: true, merged: true });
    expect(p.warnings[0]).toMatch(/Bravo is private/);
    await merge.apply('nbk_a', { from_id: 'nbk_b' });
    expect(await scopes.isPrivate('nbk_a')).toBe(true);
    const s = await getEffectiveScope(scopes, { threadId: 'thr_a1' });
    expect(s.scope.data_leaves_machine).toBe(false);
    expect(s.scope.engines).toEqual(['gateway_local']);
    expect(store.notebooks.get('nbk_a')?.instructions?.instructions).toBe('Answer briefly.');
  });

  it('puts the sources and memory back when Core’s half fails', async () => {
    const apply = store.apply.bind(store);
    store.apply = async (plan) => {
      // Someone deleted B while the merge was under way.
      const b = store.notebooks.get('nbk_b');
      if (b) b.deleted = true;
      return apply(plan);
    };
    await expect(merge.apply('nbk_a', { from_id: 'nbk_b' })).rejects.toMatchObject({
      code: 'notebook.merge_conflict',
      status: 409,
    });
    expect(kn.calls.filter((c) => c.endsWith('/merge/undo'))).toHaveLength(1);
    expect(kn.ids('nbk_b').sort()).toEqual(['src_a_manual', 'src_b_copy', 'src_b_own', 'src_b_spec']);
    expect((await memory.read('PROJECTS/alpha.md'))?.content ?? null).toBeNull();
  });

  it('stops before anything moves when the knowledge service fails', async () => {
    kn.failMerge = true;
    await expect(merge.apply('nbk_a', { from_id: 'nbk_b' })).rejects.toThrow('knowledge down');
    expect(store.threads.get('thr_b1')?.notebook_id).toBe('nbk_b');
    expect(await memory.read('PROJECTS/alpha.md')).toBeNull();
  });
});

describe('undoing a merge', () => {
  it('puts every part back, once, within the window', async () => {
    const m = await merge.apply('nbk_a', { from_id: 'nbk_b', instructions: { choice: 'from' } });
    const back = await merge.undo(m.id);
    expect(back.undone_at).not.toBeNull();
    expect(back.can_undo).toBe(false);
    expect(store.threads.get('thr_b1')?.notebook_id).toBe('nbk_b');
    expect(scopes.threads.get('thr_b1')).toBe('nbk_b');
    expect(store.notes.get('not_b1')?.notebook_id).toBe('nbk_b');
    expect(store.flows.get('flw_b')).toMatchObject({ notebook_id: 'nbk_b', active: true });
    expect(store.folders.get('c:\\work\\repo-b')?.notebook_id).toBe('nbk_b');
    expect(store.notebooks.get('nbk_b')).toMatchObject({ deleted: false, merged_into: null });
    expect(store.notebooks.get('nbk_a')?.instructions?.instructions).toBe('Answer briefly.');
    expect((await scopes.getPatch('notebook', 'nbk_a')).patch).toEqual({
      network: false,
      tools_allow: ['fs.*', 'git.*'],
    });
    expect(links.rows.get('lnk_c_to_b')?.to_id).toBe('nbk_b');
    expect(links.rows.get('lnk_a_to_b')?.to_id).toBe('nbk_b');
    expect(tombstones.rows.size).toBe(0);
    expect([...store.sharedHistory.keys()]).toEqual(['ssh_b']);
    expect(kn.ids('nbk_b').sort()).toEqual(['src_a_manual', 'src_b_copy', 'src_b_own', 'src_b_spec']);
    expect(kn.ids('nbk_a').sort()).toEqual(['src_a_manual', 'src_a_spec']);
    expect(await memory.read('PROJECTS/alpha.md')).toBeNull();
    await expect(merge.undo(m.id)).rejects.toMatchObject({ code: 'notebook.merge_undone' });
  });

  it('can no longer be undone after the window', async () => {
    const m = await merge.apply('nbk_a', { from_id: 'nbk_b' });
    now = new Date('2026-10-19T10:00:01.000Z');
    await expect(merge.undo(m.id)).rejects.toMatchObject({ code: 'notebook.merge_expired', status: 409 });
    expect((await merge.list('nbk_a'))[0]?.can_undo).toBe(false);
    await expect(merge.undo('nbm_nope')).rejects.toMatchObject({ code: 'request.not_found' });
  });
});

describe('merge routes', () => {
  it('preview, merge, history and undo over HTTP', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route(
      '/',
      notebookRoutes({
        workspaceId: WS,
        notebooks: new MemoryNotebookRepo(),
        threads: new MemoryThreadRepo(),
        kn: {} as never,
        merge,
      }),
    );
    expect((await app.request('/notebooks/nbk_a/merge-preview')).status).toBe(400);
    const p = await app.request('/notebooks/nbk_a/merge-preview?from=nbk_b');
    expect(p.status).toBe(200);
    const made = await app.request('/notebooks/nbk_a/merge', {
      method: 'POST',
      body: JSON.stringify({ from_id: 'nbk_b', instructions: { choice: 'into' } }),
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const hist = (await (await app.request('/notebooks/nbk_a/merges')).json()) as { items: { id: string }[] };
    expect(hist.items.map((x) => x.id)).toEqual([id]);
    expect((await app.request(`/notebook-merges/${id}/undo`, { method: 'POST' })).status).toBe(200);
    const bad = await app.request('/notebooks/nbk_a/merge', { method: 'POST', body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
  });

  it('answers 404 when merging is not set up', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route(
      '/',
      notebookRoutes({
        workspaceId: WS,
        notebooks: new MemoryNotebookRepo(),
        threads: new MemoryThreadRepo(),
        kn: {} as never,
      }),
    );
    expect((await app.request('/notebooks/nbk_a/merges')).status).toBe(404);
  });
});
