/**
 * The breadcrumb names a thread opened directly (from a link or Activity),
 * not only one the sidebar's list holds.
 */
import { describe, expect, it } from 'vitest';
import { threadCrumbs } from '../src/app/AppShell';

const notebooks = [{ id: 'nb_1', title: 'Research' }];

describe('threadCrumbs', () => {
  it('uses the open thread when the list does not hold it', () => {
    expect(threadCrumbs('thr_9', [], { title: 'Old plan', notebookId: 'nb_1' }, notebooks)).toEqual([
      { label: 'Research', to: '/n/nb_1' },
      { label: 'Old plan' },
    ]);
  });

  it('prefers the list, and says "Thread" only while nothing is known', () => {
    expect(
      threadCrumbs('thr_1', [{ id: 'thr_1', title: 'Listed', notebookId: null }], undefined, notebooks),
    ).toEqual([{ label: 'Listed' }]);
    expect(threadCrumbs('thr_1', undefined, undefined, undefined)).toEqual([{ label: 'Thread' }]);
  });
});
