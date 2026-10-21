/**
 * The palette's Recent list (palette/frecency.ts) leaves out notebooks and threads that no longer
 * exist, and forgets them for good, so a deleted notebook never turns up as a place to open.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FRECENCY_KEY, forgetUses, liveUses, readUses, recordUse } from '../src/palette/frecency';

const use = (kind: 'thread' | 'notebook' | 'command', label: string) => ({
  n: 3,
  last: Date.now(),
  label,
  kind,
});

beforeEach(() => localStorage.clear());

describe('liveUses', () => {
  const uses = {
    'notebook:nbk_here': use('notebook', 'Here'),
    'notebook:nbk_gone': use('notebook', 'Gone'),
    'thread:thr_live': use('thread', 'Live'),
    'thread:thr_trashed': use('thread', 'Trashed'),
    'command:new-thread': use('command', 'New thread'),
  };

  it('drops a deleted notebook and a thread known to be gone, and nothing else', () => {
    const live = liveUses(uses, { notebooks: ['nbk_here'], gone: new Set(['thr_trashed']) });
    expect(Object.keys(live).sort()).toEqual(['command:new-thread', 'notebook:nbk_here', 'thread:thr_live']);
  });

  it('judges nothing gone before the notebook list has loaded', () => {
    expect(Object.keys(liveUses(uses, {}))).toHaveLength(5);
  });

  it('keeps a thread the sidebar does not show: only a thread known to be gone is dropped', () => {
    const live = liveUses({ 'thread:thr_archived': use('thread', 'Archived') }, { notebooks: [] });
    expect(Object.keys(live)).toEqual(['thread:thr_archived']);
  });
});

describe('forgetUses', () => {
  it('removes the stored entries for good and reports how many there were', () => {
    recordUse('notebook:nbk_gone', { label: 'Gone', kind: 'notebook' });
    recordUse('notebook:nbk_here', { label: 'Here', kind: 'notebook' });
    expect(forgetUses(['notebook:nbk_gone', 'notebook:never_stored'])).toBe(1);
    expect(Object.keys(readUses())).toEqual(['notebook:nbk_here']);
    expect(localStorage.getItem(FRECENCY_KEY)).not.toContain('nbk_gone');
    expect(forgetUses([])).toBe(0);
  });
});
