/**
 * What deleting a notebook settles, from the memory repo and from the Postgres one (the Postgres
 * half runs when CORE_TEST_DATABASE_URL is set): its limits move onto its threads first, its notes
 * and links go, its folder is marked dismissed, and Sync can tell that a thread moved.
 */
import { beforeEach, expect, it } from 'vitest';
import { type ClaudeCodeStore, MemoryClaudeCodeStore, PgClaudeCodeStore } from '../../src/claudecode/store';
import { type LinkStore, MemoryLinkStore, PgLinkStore } from '../../src/links/store';
import { MemoryNotebookRepo, type NotebookRepo, PgNotebookRepo } from '../../src/notebooks/repo';
import { getEffectiveScope, PgScopeStore, type ScopeStore } from '../../src/scopes';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { ThreadBackedScopes } from '../notebooks/delete-fakes';
import { eachBackend, uid } from '../support/stores';

eachBackend('Deleting a notebook', (backend) => {
  let threads: ThreadRepo;
  let notebooks: NotebookRepo;
  let scopes: ScopeStore;
  let links: LinkStore;
  let cc: ClaudeCodeStore;
  let ws: string;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    if (b.sql) {
      threads = new PgThreadRepo(b.sql);
      notebooks = new PgNotebookRepo(b.sql);
      scopes = new PgScopeStore(b.sql);
      links = new PgLinkStore(b.sql);
      cc = new PgClaudeCodeStore(b.sql, 'win32');
    } else {
      const t = new MemoryThreadRepo();
      const n = new MemoryNotebookRepo();
      const s = new ThreadBackedScopes(t, n);
      const l = new MemoryLinkStore();
      n.wire({ threads: t, scopes: s, links: l });
      threads = t;
      notebooks = n;
      scopes = s;
      links = l;
      cc = new MemoryClaudeCodeStore(t, 'win32');
    }
  });

  const book = (title: string) =>
    notebooks.create({ id: uid('nbk'), workspace_id: ws, title: `${title} ${uid('t')}` });
  const thread = (notebook: string | null) =>
    threads.createThread({ id: uid('thr'), workspace_id: ws, notebook_id: notebook, title: 'T' });

  it('keeps a private notebook private for every thread in it: live, archived and in the Trash', async () => {
    const nb = await book('Private');
    await scopes.setPrivate(nb.id, true);
    const live = await thread(nb.id);
    const archived = await thread(nb.id);
    const trashed = await thread(nb.id);
    await threads.setFields(ws, archived.id, { archived_at: '2026-10-01T00:00:00.000Z' });
    await threads.setFields(ws, trashed.id, { deleted_at: '2026-10-02T00:00:00.000Z' });

    expect(await notebooks.remove(nb.id)).toBe(true);

    for (const t of [live, archived, trashed]) {
      const eff = await getEffectiveScope(scopes, { threadId: t.id });
      expect(eff.notebook_id).toBeNull();
      expect(eff.scope.data_leaves_machine).toBe(false);
      expect(eff.scope.engines).toEqual(['gateway_local']);
    }
    // Restoring from the Trash keeps it.
    await threads.setFields(ws, trashed.id, { deleted_at: null });
    const back = await getEffectiveScope(scopes, { threadId: trashed.id });
    expect(back.scope.data_leaves_machine).toBe(false);
  });

  it('adds the notebook’s limits to what a thread chose, never loosening either', async () => {
    const nb = await book('Limits');
    await scopes.mergePatch('notebook', nb.id, { network: false, tools_deny: ['shell.run'] });
    const t = await thread(nb.id);
    await scopes.mergePatch('thread', t.id, { tools_deny: ['fs.write'], memory_write: false });
    await notebooks.remove(nb.id);
    const eff = await getEffectiveScope(scopes, { threadId: t.id });
    expect(eff.scope.network).toBe(false);
    expect(eff.scope.memory_write).toBe(false);
    expect([...eff.scope.tools_deny].sort()).toEqual(['fs.write', 'shell.run']);
    // The notebook's own scope row is gone with it.
    expect((await scopes.getPatch('notebook', nb.id)).patch).toEqual({});
  });

  it('leaves a thread of a notebook with no limits without a scope of its own', async () => {
    const nb = await book('Plain');
    const t = await thread(nb.id);
    await notebooks.remove(nb.id);
    expect((await scopes.getPatch('thread', t.id)).patch).toEqual({});
  });

  it('deletes its notes and its context links', async () => {
    const nb = await book('Notes');
    const other = await book('Other');
    const note = await notebooks.createNote({
      id: uid('not'),
      notebook_id: nb.id,
      kind: 'human',
      title: 'N',
      content_md: 'x',
    });
    const keep = await notebooks.createNote({
      id: uid('not'),
      notebook_id: other.id,
      kind: 'human',
      title: 'K',
      content_md: 'y',
    });
    const into = await links.create({
      id: uid('lnk'),
      workspace_id: ws,
      from_kind: 'notebook',
      from_id: other.id,
      to_kind: 'notebook',
      to_id: nb.id,
      kind: 'sources',
    });
    await notebooks.remove(nb.id);
    expect(await notebooks.getNote(note.id)).toBeUndefined();
    expect(await notebooks.notes(nb.id)).toEqual([]);
    expect(await notebooks.getNote(keep.id)).toBeDefined();
    expect(into && (await links.get(into.id))).toBeFalsy();
    expect((await notebooks.noteCounts(ws)).get(nb.id)).toBeUndefined();
  });

  it('marks a bound Claude Code folder dismissed, and the folder returns when it is added again', async () => {
    const nb = await book('Folder');
    await cc.putProject(ws, 'C:\\Code\\gone', nb.id, true);
    expect(await cc.dismissNotebook(ws, nb.id)).toEqual(['C:\\Code\\gone']);
    expect((await cc.dismissed(ws)).has('c:\\code\\gone')).toBe(true);
    expect((await cc.projects(ws)).some((p) => p.notebook_id === nb.id)).toBe(false);
    expect(await cc.undismiss(ws, 'C:\\CODE\\Gone\\')).toBe(true);
    expect((await cc.dismissed(ws)).has('c:\\code\\gone')).toBe(false);
    expect(await cc.undismiss(ws, 'C:\\Code\\gone')).toBe(false);
  });

  it('answers false for a notebook that is already gone', async () => {
    const nb = await book('Twice');
    expect(await notebooks.remove(nb.id)).toBe(true);
    expect(await notebooks.remove(nb.id)).toBe(false);
  });
});

eachBackend('Deleting a notebook, in Postgres', (backend) => {
  it('revokes its grants, drops its image hosts and tells Sync its threads moved', async () => {
    const b = backend();
    const sql = b.sql;
    if (!sql) return; // the memory repo has no grants or image hosts
    const ws = b.owner.workspaceId;
    const notebooks = new PgNotebookRepo(sql);
    const threads = new PgThreadRepo(sql);
    const nb = await notebooks.create({ id: uid('nbk'), workspace_id: ws, title: `Grants ${uid('t')}` });
    const t = await threads.createThread({ id: uid('thr'), workspace_id: ws, notebook_id: nb.id });
    const grant = uid('gnt');
    await sql`
      insert into core.grants (id, user_id, principal, action_pattern, resource_pattern, effect, scope, scope_ref)
      values (${grant}, ${b.owner.userId}, 'user', 'fs.read', 'fs:/x/**', 'allow', 'notebook', ${nb.id})`;
    await sql`insert into core.image_remote_hosts (scope_key, host) values (${nb.id}, 'example.test')`;
    const before = (
      await sql<{ updated_at: Date }[]>`select updated_at from core.threads where id = ${t.id}`
    )[0];

    await notebooks.remove(nb.id);

    const [g] = await sql<
      { revoked_at: Date | null }[]
    >`select revoked_at from core.grants where id = ${grant}`;
    expect(g?.revoked_at).not.toBeNull();
    const hosts = await sql`select 1 from core.image_remote_hosts where scope_key = ${nb.id}`;
    expect(hosts).toHaveLength(0);
    const [after] = await sql<{ updated_at: Date; placed_at: Date | null; notebook_id: string | null }[]>`
      select updated_at, placed_at, notebook_id from core.threads where id = ${t.id}`;
    expect(after?.notebook_id).toBeNull();
    // The rail does not move, and Sync still sees that the thread did.
    expect(after?.updated_at.toISOString()).toBe(before?.updated_at.toISOString());
    expect(after?.placed_at).not.toBeNull();
  });
});
