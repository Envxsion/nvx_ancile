/**
 * Notebook, source and note actions (lib/notebooks.ts): each sends the right
 * call, puts its answer in the cache at once, rolls the cache back when Core
 * refuses, and says what went wrong in Core's words (or that Core was not
 * reached). Removing a source from a notebook offers Undo.
 */
import type { Source } from '@nvx/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ApiCallError, api, localError } from '../src/lib/api';
import { keys } from '../src/lib/data';
import * as nb from '../src/lib/notebooks';
import { queryClient } from '../src/lib/query';
import type { SourceView } from '../src/lib/types';
import { useNotify } from '../src/state/notify';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;

const source = (id: string, title = id): Source =>
  ({
    id,
    title,
    kind: 'text',
    status: 'ready',
    stale: false,
    context_level: 'full',
    tags: [],
    uri: null,
    mime: null,
    bytes: null,
    summary: null,
    chunks: 3,
    pages: null,
    progress: null,
    error: null,
    duplicate_of: null,
    created_at: '2026-10-12T00:00:00Z',
  }) as unknown as Source;

const view = (id: string, title = id) => ({ id, title, contextLevel: 'full' }) as SourceView;
const refused = (title: string, hint: string) =>
  new ApiCallError(422, { error: { ...localError('x.refused', title, hint, 't').error, context: {} } });
const lastToast = () => useNotify.getState().history[0];
const listOf = (id: string) => queryClient.getQueryData<SourceView[]>(keys.sources(id));

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  useNotify.setState({ toasts: [], history: [] });
});

describe('notebooks', () => {
  it('create, patch and delete call Core and report a refusal in its words', async () => {
    mocked.post.mockResolvedValueOnce({ id: 'nbk_1', title: 'Pumps' });
    expect(await nb.createNotebook({ title: 'Pumps' })).toMatchObject({ id: 'nbk_1' });
    expect(mocked.post).toHaveBeenCalledWith('/notebooks', { title: 'Pumps' });

    mocked.patch.mockResolvedValueOnce({});
    expect(await nb.patchNotebook('nbk_1', { pinned: true })).toBe(true);
    mocked.patch.mockRejectedValueOnce(refused('That notebook was not found', 'Refresh the view.'));
    expect(await nb.patchNotebook('nbk_1', { pinned: true })).toBe(false);
    expect(lastToast()).toMatchObject({ level: 'error', title: 'That notebook was not found' });

    mocked.del.mockResolvedValueOnce(undefined);
    expect(await nb.deleteNotebook('nbk_1')).toBe(true);
    mocked.del.mockRejectedValueOnce(new TypeError('offline'));
    expect(await nb.deleteNotebook('nbk_1')).toBe(false);
    expect(lastToast()).toMatchObject({ title: "Deleting the notebook didn't reach Core" });

    mocked.post.mockRejectedValueOnce(new TypeError('offline'));
    expect(await nb.createNotebook({ title: 'x' })).toBeNull();
  });
});

describe('adding sources', () => {
  it('a link, text and a past thread land at the top of the notebook at once', async () => {
    queryClient.setQueryData(keys.sources('nbk_1'), [view('src_old')]);
    mocked.post.mockResolvedValueOnce(source('src_link'));
    await nb.addLink('nbk_1', 'https://example.com');
    expect(mocked.post).toHaveBeenLastCalledWith('/sources', {
      kind: 'url',
      url: 'https://example.com',
      notebook_id: 'nbk_1',
    });
    mocked.post.mockResolvedValueOnce(source('src_text'));
    await nb.addText('nbk_1', 'Owls hunt at night.', 'Owls');
    expect(mocked.post).toHaveBeenLastCalledWith('/sources', {
      kind: 'text',
      text: 'Owls hunt at night.',
      notebook_id: 'nbk_1',
      title: 'Owls',
    });
    mocked.post.mockResolvedValueOnce(source('src_thr'));
    await nb.addThread('nbk_1', 'thr_1');
    expect(listOf('nbk_1')?.map((s) => s.id)).toEqual(['src_thr', 'src_text', 'src_link', 'src_old']);

    for (const add of [
      () => nb.addLink('nbk_1', 'https://x.test'),
      () => nb.addText('nbk_1', 'x'),
      () => nb.addThread('nbk_1', 'thr_x'),
    ]) {
      mocked.post.mockRejectedValueOnce(refused('That link could not be read', 'Check the address.'));
      expect(await add()).toBeNull();
    }
    expect(lastToast()?.title).toBe('That link could not be read');
  });
});

describe('changing sources', () => {
  beforeEach(() => {
    queryClient.setQueryData(keys.sources('nbk_1'), [view('src_a', 'A'), view('src_b', 'B')]);
    queryClient.setQueryData(keys.sources('nbk_2'), [view('src_a', 'A')]);
  });

  it('a context level changes at once, and goes back when Core refuses', async () => {
    mocked.patch.mockResolvedValueOnce({});
    await nb.setContextLevel('nbk_1', 'src_a', 'insights');
    expect(listOf('nbk_1')?.[0]?.contextLevel).toBe('insights');
    expect(mocked.patch).toHaveBeenCalledWith('/notebooks/nbk_1/sources/src_a', {
      context_level: 'insights',
    });
    mocked.patch.mockRejectedValueOnce(new TypeError('offline'));
    await nb.setContextLevel('nbk_1', 'src_a', 'off');
    expect(listOf('nbk_1')?.[0]?.contextLevel).toBe('insights');
  });

  it('removing from a notebook offers Undo, which puts it back at its level', async () => {
    mocked.del.mockResolvedValueOnce(undefined);
    mocked.put.mockResolvedValueOnce({});
    await nb.removeSource('nbk_1', view('src_b', 'B'));
    expect(listOf('nbk_1')?.map((s) => s.id)).toEqual(['src_a']);
    const toast = lastToast();
    expect(toast).toMatchObject({ title: 'Removed from the notebook', body: 'B' });
    toast?.undo?.();
    await vi.waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/notebooks/nbk_1/sources/src_b', { context_level: 'full' }),
    );
  });

  it('a refused removal leaves the list as it was', async () => {
    mocked.del.mockRejectedValueOnce(refused('Not now', 'Try again.'));
    await nb.removeSource('nbk_1', view('src_b'));
    expect(listOf('nbk_1')?.map((s) => s.id)).toEqual(['src_a', 'src_b']);
  });

  it('renames a source in every notebook that holds it, and rolls back on refusal', async () => {
    mocked.patch.mockResolvedValueOnce(source('src_a', 'Alpha'));
    await nb.renameSource('src_a', '  Alpha  ');
    expect(mocked.patch).toHaveBeenCalledWith('/sources/src_a', { title: 'Alpha' });
    expect(listOf('nbk_1')?.[0]?.title).toBe('Alpha');
    expect(listOf('nbk_2')?.[0]?.title).toBe('Alpha');
    mocked.patch.mockRejectedValueOnce(refused('No', 'Later.'));
    await expect(nb.renameSource('src_a', 'Beta')).rejects.toBeInstanceOf(ApiCallError);
    expect(listOf('nbk_2')?.[0]?.title).toBe('Alpha');
  });

  it('deleting a source takes it out of every notebook; a refusal puts it back', async () => {
    mocked.del.mockRejectedValueOnce(new TypeError('offline'));
    await nb.deleteSource(view('src_a', 'A'));
    expect(listOf('nbk_2')?.map((s) => s.id)).toEqual(['src_a']);
    mocked.del.mockResolvedValueOnce(undefined);
    await nb.deleteSource(view('src_a', 'A'));
    expect(listOf('nbk_2')).toEqual([]);
    expect(listOf('nbk_1')?.map((s) => s.id)).toEqual(['src_b']);
    expect(lastToast()).toMatchObject({ title: 'Source deleted', body: 'A' });
  });

  it('retry, refetch, merge and keep-both each make one call', async () => {
    mocked.post.mockResolvedValue({});
    await nb.retrySource('nbk_1', 'src_a');
    await nb.refetchSource('nbk_1', 'src_a');
    await nb.mergeSources('nbk_1', 'src_a', 'src_b');
    await nb.dismissDuplicate('nbk_1', 'src_a', 'src_b');
    expect(mocked.post.mock.calls).toEqual([
      ['/sources/src_a/retry'],
      ['/sources/src_a/refetch'],
      ['/sources/merge', { keep_id: 'src_a', drop_id: 'src_b' }],
      ['/sources/duplicates/dismiss', { a_id: 'src_a', b_id: 'src_b' }],
    ]);
    mocked.post.mockRejectedValue(new TypeError('offline'));
    await nb.retrySource('nbk_1', 'src_a');
    await nb.refetchSource('nbk_1', 'src_a');
    await nb.mergeSources('nbk_1', 'src_a', 'src_b');
    await nb.dismissDuplicate('nbk_1', 'src_a', 'src_b');
    expect(useNotify.getState().history.filter((h) => h.level === 'error')).toHaveLength(4);
  });
});

describe('notes', () => {
  it('create, save, delete and keep an answer as a note', async () => {
    mocked.post.mockResolvedValueOnce({ id: 'not_1', title: 'Idea' });
    expect(await nb.createNote('nbk_1', 'Idea')).toMatchObject({ id: 'not_1' });
    expect(mocked.post).toHaveBeenLastCalledWith('/notebooks/nbk_1/notes', { title: 'Idea', content_md: '' });
    mocked.patch.mockResolvedValueOnce({});
    expect(await nb.saveNote('nbk_1', 'not_1', { pinned: true })).toBe(true);
    mocked.del.mockResolvedValueOnce(undefined);
    await nb.deleteNote('nbk_1', 'not_1');
    expect(mocked.del).toHaveBeenCalledWith('/notes/not_1');
    mocked.post.mockResolvedValueOnce({});
    expect(await nb.saveAnswerAsNote('msg_1', 'nbk_1', 'Kept')).toBe(true);
    expect(mocked.post).toHaveBeenLastCalledWith('/messages/msg_1/to-note', {
      notebook_id: 'nbk_1',
      title: 'Kept',
    });
    expect(lastToast()?.title).toBe('Saved as a note');

    mocked.post.mockRejectedValue(new TypeError('offline'));
    mocked.patch.mockRejectedValue(new TypeError('offline'));
    mocked.del.mockRejectedValue(new TypeError('offline'));
    expect(await nb.createNote('nbk_1', 'x')).toBeNull();
    expect(await nb.saveNote('nbk_1', 'not_1', {})).toBe(false);
    await nb.deleteNote('nbk_1', 'not_1');
    expect(await nb.saveAnswerAsNote('msg_1', 'nbk_1')).toBe(false);
  });
});
