/**
 * A thread whose private notebook was deleted keeps that notebook's privacy for the checks that
 * ask the privacy policy (hosted decisions, the web in fact-checks, passive memory, shared
 * verdicts), not only for model calls: it has no notebook to look up any more, so the policy
 * reads the thread's own stored limits.
 */
import { describe, expect, it } from 'vitest';
import { VerdictCache } from '../../src/factcheck/cache';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { PrivacyPolicies } from '../../src/privacy/policy';
import { MemorySettings } from '../../src/settings';
import { MemoryThreadRepo } from '../../src/threads/repo';
import { ThreadBackedScopes } from '../notebooks/delete-fakes';

const WS = 'wsp_test';

async function formerThread() {
  const threads = new MemoryThreadRepo();
  const books = new MemoryNotebookRepo();
  const scopes = new ThreadBackedScopes(threads, books);
  books.wire({ threads, scopes });
  await books.create({ id: 'nbk_priv', workspace_id: WS, title: 'Secret' });
  await scopes.setPrivate('nbk_priv', true);
  await threads.createThread({ id: 'thr_was_private', workspace_id: WS, notebook_id: 'nbk_priv' });
  await threads.createThread({ id: 'thr_plain', workspace_id: WS, notebook_id: null });
  await books.remove('nbk_priv');
  const privacy = new PrivacyPolicies({
    settings: new MemorySettings(),
    isPrivate: (id) => scopes.isPrivate(id),
    threadPrivate: async (id) => (await scopes.getPatch('thread', id)).patch.data_leaves_machine === false,
  });
  return { privacy, scopes };
}

describe('a thread from a deleted private notebook', () => {
  it('has no notebook, yet is still treated as private', async () => {
    const { privacy, scopes } = await formerThread();
    expect(await scopes.threadNotebook('thr_was_private')).toBeNull();
    expect(
      (await privacy.resolve('factcheck_web', { notebookId: null, threadId: 'thr_was_private' })).via,
    ).toBe('denied');
  });

  it('refuses the web in a fact-check', async () => {
    const { privacy } = await formerThread();
    expect(await privacy.allows('factcheck_web', { notebookId: null, threadId: 'thr_was_private' })).toBe(
      false,
    );
    // An ordinary thread outside any notebook is not affected.
    expect(await privacy.allows('factcheck_web', { notebookId: null, threadId: 'thr_plain' })).toBe(true);
    // Without the thread, the policy cannot know (the gap this closes).
    expect(await privacy.allows('factcheck_web', { notebookId: null })).toBe(true);
  });

  it('refuses hosted decision models unless the call is local', async () => {
    const { privacy } = await formerThread();
    const ctx = { notebookId: null, threadId: 'thr_was_private' };
    expect((await privacy.resolve('decisions_off_machine', ctx)).allowed).toBe(false);
    expect((await privacy.resolve('decisions_off_machine', { ...ctx, local: true })).allowed).toBe(true);
  });

  it('does not learn passively, and keeps cloud models out', async () => {
    const { privacy } = await formerThread();
    const ctx = { notebookId: null, threadId: 'thr_was_private' };
    expect((await privacy.resolve('passive_memory', ctx)).allowed).toBe(false);
    expect((await privacy.resolve('cloud_models', ctx)).allowed).toBe(false);
  });

  it('does not share verdicts, and the gate is asked about the thread', async () => {
    const { privacy } = await formerThread();
    const asked: unknown[] = [];
    const cache = new VerdictCache({} as never, {
      allows: async (c, ctx) => {
        asked.push(ctx);
        return privacy.allows(c, ctx);
      },
    });
    expect(await cache.mayShare('', 'thr_was_private')).toBe(false);
    expect(await cache.mayShare('nbk_other', 'thr_was_private')).toBe(false);
    expect(asked).toEqual([{ notebookId: 'nbk_other', threadId: 'thr_was_private' }]);
  });

  it('a given ctx.private still wins, with no lookup', async () => {
    let looked = 0;
    const p = new PrivacyPolicies({
      settings: new MemorySettings(),
      threadPrivate: async () => {
        looked++;
        return true;
      },
    });
    expect(await p.allows('factcheck_web', { private: false, threadId: 't' })).toBe(true);
    expect(looked).toBe(0);
  });
});
