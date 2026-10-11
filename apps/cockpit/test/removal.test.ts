/**
 * Removing and renaming what you can see: repositories, sources and
 * memory files. Each call reaches the right route and keeps every cached
 * list in step, and a failure puts the list back as it was.
 */
import type { Source } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { deleteSource, renameSource } from '../src/lib/notebooks';
import { queryClient } from '../src/lib/query';
import type { SourceView } from '../src/lib/types';
import { isProtectedFile } from '../src/memory/api';
import { removeRepo, repoKeys } from '../src/repos/data';
import { useNotify } from '../src/state/notify';

const view = (id: string, title: string) => ({ id, title }) as SourceView;

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  useNotify.setState({ toasts: [], history: [] });
});

describe('sources', () => {
  it('delete takes the source out of every notebook it is in, and says so without an Undo', async () => {
    queryClient.setQueryData(['sources', 'nb1'], [view('s1', 'A'), view('s2', 'B')]);
    queryClient.setQueryData(['sources', 'nb2'], [view('s1', 'A')]);
    const del = vi.spyOn(api, 'del').mockResolvedValue(undefined);
    await deleteSource(view('s1', 'A'));
    expect(del).toHaveBeenCalledWith('/sources/s1');
    expect(queryClient.getQueryData<SourceView[]>(['sources', 'nb1'])?.map((s) => s.id)).toEqual(['s2']);
    expect(queryClient.getQueryData<SourceView[]>(['sources', 'nb2'])).toEqual([]);
    const toast = useNotify.getState().toasts.at(-1);
    expect(toast?.title).toBe('Source deleted');
    expect(toast?.undo).toBeUndefined();
  });

  it('a failed delete puts the lists back', async () => {
    queryClient.setQueryData(['sources', 'nb1'], [view('s1', 'A')]);
    vi.spyOn(api, 'del').mockRejectedValue(new Error('offline'));
    await deleteSource(view('s1', 'A'));
    expect(queryClient.getQueryData<SourceView[]>(['sources', 'nb1'])?.map((s) => s.id)).toEqual(['s1']);
    expect(useNotify.getState().toasts.at(-1)?.level).toBe('error');
  });

  it('rename patches the title once and shows it in every list', async () => {
    queryClient.setQueryData(['sources', 'nb1'], [view('s1', 'Old')]);
    queryClient.setQueryData(['sources', 'nb2'], [view('s1', 'Old'), view('s2', 'Other')]);
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ id: 's1', title: 'New' } as Source);
    await renameSource('s1', '  New ');
    expect(patch).toHaveBeenCalledWith('/sources/s1', { title: 'New' });
    expect(queryClient.getQueryData<SourceView[]>(['sources', 'nb2'])?.map((s) => s.title)).toEqual([
      'New',
      'Other',
    ]);
  });

  it('a failed rename keeps the old title', async () => {
    queryClient.setQueryData(['sources', 'nb1'], [view('s1', 'Old')]);
    vi.spyOn(api, 'patch').mockRejectedValue(new Error('offline'));
    await expect(renameSource('s1', 'New')).rejects.toThrow();
    expect(queryClient.getQueryData<SourceView[]>(['sources', 'nb1'])?.[0]?.title).toBe('Old');
  });
});

describe('repositories', () => {
  it('remove calls Core and forgets the repository here', async () => {
    queryClient.setQueryData(repoKeys.status('r1'), { branch: 'main' });
    const del = vi.spyOn(api, 'del').mockResolvedValue(undefined);
    vi.spyOn(api, 'get').mockResolvedValue({ items: [] });
    await removeRepo('r1');
    expect(del).toHaveBeenCalledWith('/repos/r1');
    expect(queryClient.getQueryData(repoKeys.status('r1'))).toBeUndefined();
  });
});

describe('memory files', () => {
  it('offers delete only where Core allows it', () => {
    expect(isProtectedFile('USER.md')).toBe(true);
    expect(isProtectedFile('agents.md')).toBe(true);
    expect(isProtectedFile('PROJECTS/README.md')).toBe(true);
    expect(isProtectedFile('PROJECTS/_template.md')).toBe(true);
    expect(isProtectedFile('PROJECTS/old-plan.md')).toBe(false);
    expect(isProtectedFile('FAILURES/user.md')).toBe(false);
  });
});
