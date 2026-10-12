/**
 * Context packs are Pro (docs/notebooks.md). The public build holds only
 * the seam: every pack route answers 402 pro.feature_required where no Pro
 * route answered, a Pro route still wins, and the host Pro is lent checks
 * scopes the way a context link does.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { MemoryEngineStore } from '../../src/engines/store';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { errorHandler } from '../../src/obs/errors';
import { proPackHost } from '../../src/pro/packs';
import { identityMiddleware, lockedProRoutes, ownerIdentity, proRoutes } from '../../src/pro/routes';
import { MemoryScopeStore, scopeResolver } from '../../src/scopes';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';

function app(withPro: boolean) {
  const a = new Hono<AppEnv>();
  a.onError(errorHandler);
  a.use(
    '*',
    identityMiddleware(() => ownerIdentity({ userId: 'usr_1', workspaceId: WS })),
  );
  a.route(
    '/',
    proRoutes({
      routes: withPro
        ? [
            {
              method: 'GET',
              path: '/context-packs',
              feature: 'context_packs',
              handler: async () => ({ body: { items: [] } }),
            },
          ]
        : [],
      hasFeature: () => true,
    }),
  );
  a.route('/', lockedProRoutes());
  return a;
}

describe('the context packs seam', () => {
  it('answers 402 for every pack path in the free build', async () => {
    const free = app(false);
    for (const [method, path] of [
      ['GET', '/pro/context-packs'],
      ['POST', '/pro/context-packs'],
      ['POST', '/pro/context-packs/cpk_1/attach'],
      ['GET', '/pro/context-packs/cpk_1/export'],
      ['POST', '/pro/context-packs/import/preview'],
    ] as const) {
      const res = await free.request(path, { method });
      expect(res.status).toBe(402);
      const body = (await res.json()) as {
        error: { code: string; title: string; context: { feature: string } };
      };
      expect(body.error.code).toBe('pro.feature_required');
      expect(body.error.title).toBe('Context packs is part of NVX Ancile Pro');
      expect(body.error.context.feature).toBe('context_packs');
    }
  });

  it('lets a Pro route answer first', async () => {
    const res = await app(true).request('/pro/context-packs');
    expect(res.status).toBe(200);
  });
});

describe('what Pro is lent for packs', () => {
  let scopes: MemoryScopeStore;
  let notebooks: MemoryNotebookRepo;
  let threads: MemoryThreadRepo;
  let engines: MemoryEngineStore;
  const posted: unknown[] = [];
  let host: ReturnType<typeof proPackHost>;

  beforeEach(async () => {
    scopes = new MemoryScopeStore();
    notebooks = new MemoryNotebookRepo();
    threads = new MemoryThreadRepo();
    engines = new MemoryEngineStore();
    posted.length = 0;
    for (const [id, title] of [
      ['nbk_a', 'Alpha'],
      ['nbk_p', 'Private'],
    ]) {
      await notebooks.create({ id: id as string, workspace_id: WS, title: title as string });
      scopes.notebooks.add(id as string);
    }
    await notebooks.create({ id: 'nbk_far', workspace_id: 'wsp_other', title: 'Far' });
    await threads.createThread({ id: 'thr_1', workspace_id: WS, notebook_id: 'nbk_a', title: 'Thread one' });
    scopes.threads.set('thr_1', 'nbk_a');
    await scopes.setPrivate('nbk_p', true);
    engines.known.add('nbk_a');
    await engines.setNotebookInstructions('nbk_a', { instructions: 'Be brief.', persona: 'Engineer' });
    host = proPackHost({
      workspaceId: WS,
      kn: {
        get: async <T>(path: string): Promise<T> => {
          if (path.startsWith('/sources/src_1/content')) return { markdown: '# Manual\nText.' } as T;
          if (path.startsWith('/sources/src_1')) return { id: 'src_1', title: 'Manual', kind: 'file' } as T;
          if (path.startsWith('/notebooks/nbk_a/sources')) return [{ id: 'src_1', title: 'Manual' }] as T;
          throw new Error('not found');
        },
        post: async <T>(path: string, body?: unknown): Promise<T> => {
          posted.push({ path, body });
          return { id: 'src_new' } as T;
        },
      },
      scopes: scopeResolver(scopes),
      threads,
      notebooks,
      engines,
      summaryOf: async (id) => (id === 'thr_1' ? 'A summary.' : null),
    });
  });

  it('reads sources, places, instructions and summaries in this workspace only', async () => {
    expect(await host.sourceText('src_1')).toEqual({
      id: 'src_1',
      title: 'Manual',
      kind: 'file',
      content_hash: null,
      text: '# Manual\nText.',
    });
    expect(await host.sourceText('src_gone')).toBeNull();
    expect(await host.notebookSources('nbk_a')).toEqual([{ id: 'src_1', title: 'Manual' }]);
    expect(await host.addTextSource({ title: 'T', text: 'x', notebookId: 'nbk_a' })).toEqual({
      id: 'src_new',
    });
    expect(posted[0]).toMatchObject({ path: '/sources', body: { kind: 'text', notebook_ids: ['nbk_a'] } });
    expect(await host.place({ kind: 'thread', id: 'thr_1' })).toEqual({
      title: 'Thread one',
      notebookId: 'nbk_a',
    });
    expect(await host.place({ kind: 'notebook', id: 'nbk_far' })).toBeNull();
    expect(await host.instructionsOf({ kind: 'notebook', id: 'nbk_a' })).toEqual({
      instructions: 'Be brief.',
      persona: 'Engineer',
    });
    expect(await host.instructionsOf({ kind: 'thread', id: 'thr_1' })).toEqual({
      instructions: '',
      persona: '',
    });
    expect(await host.summaryOf('thr_1')).toBe('A summary.');
    expect(await host.keepsLocal({ kind: 'notebook', id: 'nbk_p' })).toBe(true);
    expect(await host.keepsLocal({ kind: 'notebook', id: 'nbk_a' })).toBe(false);
  });

  it('refuses to attach a pack where its items may not be read', async () => {
    const fromPrivate = {
      name: 'Diary',
      local_only: true,
      origins: [{ kind: 'notebook' as const, id: 'nbk_p' }],
    };
    expect(await host.checkAttach({ kind: 'thread', id: 'thr_1' }, fromPrivate)).toMatchObject({
      ok: false,
      code: 'scope.data_stays_local',
    });
    expect(
      await host.checkAttach({ kind: 'thread', id: 'thr_1' }, { ...fromPrivate, local_only: false }),
    ).toMatchObject({ ok: false, code: 'scope.private_notebook' });
    await scopes.mergePatch('thread', 'thr_1', { data_leaves_machine: false });
    expect(await host.checkAttach({ kind: 'thread', id: 'thr_1' }, fromPrivate)).toEqual({ ok: true });
    expect(
      await host.checkAttach(
        { kind: 'notebook', id: 'nbk_far' },
        { name: 'X', local_only: false, origins: [] },
      ),
    ).toMatchObject({ ok: false, code: 'request.not_found' });
  });
});
