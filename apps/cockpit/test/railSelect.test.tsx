/**
 * ------------------------------------------------------------------
 *  Title    |  Selecting, dragging and bulk actions in the rail
 *  Ref      |  ROADMAP TC3, TC4, RA1 · guard rail GR23
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Threads are selected with the pointer (Ctrl, Shift) and
 *           |  the keyboard (Space, Shift+arrows, Ctrl+A, Escape),
 *           |  across rows a long rail has not drawn. Selected
 *           |  threads drag onto a notebook together, and a bar moves,
 *           |  archives and deletes them with one notice that names
 *           |  the count, lasts ten seconds, and undoes exactly.
 *           |  Threads left alone (answering) are named. The Trash is
 *           |  reached from the Archive area, restores, and asks
 *           |  before it empties. Threads that need you float up;
 *           |  an opened unread thread is marked read.
 * ------------------------------------------------------------------
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const params = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useParams: () => params,
    useNavigate: () => vi.fn(),
    useRouterState: () => '/',
    useSearch: () => ({}),
    Link: ({
      children,
      to,
      params: p,
      // TanStack-only props never reach the anchor.
      preload: _preload,
      ...rest
    }: {
      children: ReactNode;
      to: string;
      params?: Record<string, string>;
      preload?: unknown;
      [k: string]: unknown;
    }) => (
      <a href={p ? to.replace(/\$\w+/, Object.values(p)[0] ?? '') : to} {...rest}>
        {children}
      </a>
    ),
  };
});
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { leftAlone, nameThem, UNDO_MS } from '../src/lib/threads';
import { DRAG_TYPE, Rail } from '../src/shell/Rail';
import {
  attentionOf,
  dragIds,
  EMPTY,
  extendTo,
  nextNeeding,
  prune,
  rangeBetween,
  rollUp,
  selectAll,
  selectionSaid,
  toggle,
  topOf,
} from '../src/shell/selection';
import { useNotify } from '../src/state/notify';
import { useUi } from '../src/state/ui';

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

const HOUR = 3_600_000;
function thread(i: number, extra: Record<string, unknown> = {}) {
  return {
    id: `thr_${i}`,
    title: `Thread ${i}`,
    notebook_id: null,
    active_head_id: null,
    settings: {},
    pinned_at: null,
    archived_at: null,
    created_at: '',
    updated_at: new Date(Date.now() - i * HOUR * 4).toISOString(),
    branches: 1,
    live: false,
    waiting: false,
    unread: false,
    ...extra,
  };
}
const notebook = (i: number) => ({
  id: `nb_${i}`,
  title: `Notebook ${i}`,
  description: '',
  icon: null,
  color: null,
  pinned: false,
  archived_at: null,
  grounded: false,
  counts: { sources: 2, threads: 3 },
  created_at: '',
  updated_at: '',
});
const stateOf = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Thread ${id.slice(4)}`,
  notebook_id: null,
  archived_at: null,
  pinned_at: null,
  updated_at: '2026-10-01T00:00:00.000Z',
  deleted_at: null,
  ...extra,
});

let trashItems: unknown[] = [];
function workspace(n: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
  const items = Array.from({ length: n }, (_, i) => thread(i, extra(i)));
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/threads?')) return { items, next_cursor: null };
    if (path === '/notebooks') return { items: [notebook(1), notebook(2)], next_cursor: null };
    if (path === '/threads/trash') return { items: trashItems, retention_days: 30 };
    return { items: [], next_cursor: null };
  });
  return items;
}

function mountRail() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <Rail />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

const linkOf = (id: string) => document.querySelector<HTMLElement>(`a[data-thread="${id}"]`) as HTMLElement;
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

/** A DataTransfer the way a browser carries one through a drag. */
function transfer() {
  const data: Record<string, string> = {};
  return {
    data,
    types: [] as string[],
    effectAllowed: '',
    dropEffect: '',
    setData(type: string, value: string) {
      data[type] = value;
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData: (type: string) => data[type] ?? '',
  };
}

beforeEach(() => {
  for (const k of Object.keys(params)) delete params[k];
  useUi.setState({ demo: false, railOpen: true });
  useNotify.setState({ toasts: [], history: [] });
  Element.prototype.scrollIntoView = vi.fn();
  get.mockReset();
  post.mockReset();
  trashItems = [];
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
});
afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('selection rules', () => {
  const order = Array.from({ length: 1000 }, (_, i) => `t${i}`);

  it('a range runs along the whole list, including rows nobody has drawn', () => {
    expect(rangeBetween(order, 't10', 't14')).toEqual(['t10', 't11', 't12', 't13', 't14']);
    expect(rangeBetween(order, 't14', 't10')).toEqual(['t10', 't11', 't12', 't13', 't14']);
    const far = extendTo(toggle(EMPTY, 't3'), order, 't903');
    expect(far.ids.size).toBe(901);
    expect(far.anchor).toBe('t3');
  });

  it('Ctrl toggles one and moves the anchor; Shift replaces unless Ctrl keeps; Ctrl+A takes all', () => {
    let s = toggle(EMPTY, 't5');
    s = toggle(s, 't9');
    expect([...s.ids]).toEqual(['t5', 't9']);
    expect(s.anchor).toBe('t9');
    expect([...toggle(s, 't5').ids]).toEqual(['t9']);
    expect([...extendTo(s, order, 't11').ids].sort()).toEqual(['t10', 't11', 't9']);
    expect(extendTo(s, order, 't11', true).ids.has('t5')).toBe(true);
    expect(selectAll(order).ids.size).toBe(1000);
    expect(extendTo(EMPTY, order, 't7').ids).toEqual(new Set(['t7']));
  });

  it('threads that left the rail leave the selection, and a drag takes the whole selection', () => {
    const s = selectAll(['a', 'b', 'c']);
    expect([...prune(s, ['a', 'c']).ids]).toEqual(['a', 'c']);
    expect(prune(s, ['a', 'b', 'c'])).toBe(s);
    expect(dragIds(s, 'b', ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c']);
    expect(dragIds(s, 'd', ['a', 'b', 'c', 'd'])).toEqual(['d']);
    expect(selectionSaid(0)).toBe('Selection cleared');
    expect(selectionSaid(1)).toBe('1 thread selected');
    expect(selectionSaid(3)).toBe('3 threads selected');
  });

  it('attention is one state: waiting beats working beats unread, and the open thread is never unread', () => {
    const t = (e: object) => ({ id: 'a', live: false, waiting: false, unread: false, ...e });
    expect(attentionOf(t({ waiting: true, live: true }))).toBe('needs_you');
    expect(attentionOf(t({ live: true, unread: true }))).toBe('working');
    expect(attentionOf(t({ unread: true }))).toBe('unread');
    expect(attentionOf(t({ unread: true }), 'a')).toBe('none');
    expect(attentionOf(t({}))).toBe('none');
  });

  it('notebook roll-ups count each state and show the most pressing; Alt+Down walks the ones that need you', () => {
    const list = [
      { id: 'a', waiting: true },
      { id: 'b', waiting: true },
      { id: 'c', live: true },
      { id: 'd', unread: true },
    ].map((e) => ({ title: '', notebookId: null, updatedAt: '', branches: 1, live: false, ...e }));
    const r = rollUp(list as never);
    expect(r).toEqual({ needs_you: 2, working: 1, unread: 1 });
    expect(topOf(r)).toEqual({ state: 'needs_you', count: 2 });
    expect(topOf({ needs_you: 0, working: 0, unread: 0 })).toBeNull();
    expect(nextNeeding(['a', 'b'], undefined)).toBe('a');
    expect(nextNeeding(['a', 'b'], 'a')).toBe('b');
    expect(nextNeeding(['a', 'b'], 'b')).toBe('a');
    expect(nextNeeding([], 'a')).toBeNull();
  });
});

describe('the notices', () => {
  it('names a few threads, then counts the rest, and says why some were left alone', () => {
    expect(nameThem(['A'])).toBe('“A”');
    expect(nameThem(['A', 'B'])).toBe('“A” and “B”');
    expect(nameThem(['A', 'B', 'C', 'D', 'E'])).toBe('“A”, “B”, “C” and 2 more');
    const note = leftAlone([
      { id: '1', title: 'Pump report', reason: 'running', hint: 'x' },
      {
        id: '2',
        title: 'Tide notes',
        reason: 'refused',
        hint: 'Claude Code threads stay out of private notebooks.',
      },
    ]);
    expect(note).toContain('answering now: “Pump report”');
    expect(note).toContain('“Tide notes”: Claude Code threads stay out of private notebooks.');
  });
});

describe('selecting in the rail', () => {
  it('Space selects, Shift+arrow extends, Escape clears, and the bar names the count', async () => {
    workspace(12);
    mountRail();
    await screen.findByText('Thread 3');

    linkOf('thr_3').focus();
    fireEvent.keyDown(linkOf('thr_3'), { key: ' ' });
    expect(linkOf('thr_3')).toHaveAttribute('data-selected');
    expect(await screen.findByRole('toolbar', { name: 'Actions for 1 selected thread' })).toBeInTheDocument();
    expect(within(linkOf('thr_3')).getByText(', selected')).toBeInTheDocument();

    fireEvent.keyDown(linkOf('thr_3'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(linkOf('thr_4'), { key: 'ArrowDown', shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole('toolbar', { name: 'Actions for 3 selected threads' })).toBeInTheDocument(),
    );
    expect(['thr_3', 'thr_4', 'thr_5'].every((id) => linkOf(id).hasAttribute('data-selected'))).toBe(true);

    fireEvent.keyDown(linkOf('thr_5'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
    expect(document.querySelector('[data-selected]')).toBeNull();
  });

  it('Ctrl+A takes every thread, drawn or not, in a rail that draws a window', async () => {
    workspace(400);
    mountRail();
    await screen.findByText('Thread 3');
    const drawn = document.querySelectorAll('a[data-thread]').length;
    expect(drawn).toBeLessThan(400);

    linkOf('thr_3').focus();
    fireEvent.keyDown(linkOf('thr_3'), { key: 'a', ctrlKey: true });
    expect(
      await screen.findByRole('toolbar', { name: 'Actions for 400 selected threads' }),
    ).toBeInTheDocument();
  });

  it('Ctrl click toggles, Shift click takes the range, and a plain click clears', async () => {
    workspace(12);
    mountRail();
    await screen.findByText('Thread 3');

    fireEvent.click(linkOf('thr_3'), { ctrlKey: true });
    fireEvent.click(linkOf('thr_6'), { ctrlKey: true });
    expect(
      [...document.querySelectorAll('[data-selected]')].map((e) => e.getAttribute('data-thread')),
    ).toEqual(['thr_3', 'thr_6']);
    fireEvent.click(linkOf('thr_9'), { shiftKey: true });
    // From the last one picked (thr_6) to thr_9, replacing the earlier two.
    expect(
      [...document.querySelectorAll('[data-selected]')].map((e) => e.getAttribute('data-thread')).sort(),
    ).toEqual(['thr_6', 'thr_7', 'thr_8', 'thr_9']);

    // A plain click opens the thread (jsdom does not navigate) and drops the selection.
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener('click', stay);
    fireEvent.click(linkOf('thr_1'));
    document.removeEventListener('click', stay);
    await waitFor(() => expect(document.querySelector('[data-selected]')).toBeNull());
  });
});

describe('moving, archiving and deleting', () => {
  const done = (ids: string[]) => ({ done: ids.map((id) => stateOf(id)), skipped: [] });

  it('dragging a selected thread takes the whole selection into the notebook, with one ten second Undo', async () => {
    workspace(12);
    post.mockResolvedValue(done(['thr_3', 'thr_4']));
    mountRail();
    await screen.findByText('Thread 3');

    fireEvent.click(linkOf('thr_3'), { ctrlKey: true });
    fireEvent.click(linkOf('thr_4'), { ctrlKey: true });
    const dt = transfer();
    fireEvent.dragStart(linkOf('thr_4'), { dataTransfer: dt });
    expect(JSON.parse(dt.data[DRAG_TYPE] as string)).toEqual(['thr_3', 'thr_4']);

    const target = (await screen.findByText('Notebook 1')).closest('li') as HTMLElement;
    fireEvent.dragEnter(target, { dataTransfer: dt });
    expect(target).toHaveAttribute('data-drop');
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    expect(target).not.toHaveAttribute('data-drop');

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/threads/bulk', {
        action: 'move',
        ids: ['thr_3', 'thr_4'],
        notebook_id: 'nb_1',
      }),
    );
    await flush();
    const toast = useNotify.getState().toasts.at(-1);
    expect(toast?.title).toBe('Moved 2 threads to Notebook 1');
    expect(toast?.ttlMs).toBe(UNDO_MS);
    expect(UNDO_MS).toBe(10_000);

    // Undo sends back the states Core gave, so notebook, pin and place return exactly.
    post.mockResolvedValue(done(['thr_3', 'thr_4']));
    act(() => toast?.undo?.());
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/threads/bulk', {
        action: 'revert',
        states: [stateOf('thr_3'), stateOf('thr_4')],
      }),
    );
  });

  it('a thread dropped on the notebook it is already in stays put', async () => {
    workspace(12, (i) => (i === 3 ? { notebook_id: 'nb_1' } : {}));
    mountRail();
    await screen.findByText('Notebook 1');
    const dt = transfer();
    fireEvent.dragStart(linkOf('thr_3'), { dataTransfer: dt });
    const target = screen.getByText('Notebook 1').closest('li') as HTMLElement;
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText('Already in Notebook 1.')).toBeInTheDocument();
  });

  it('a drag that is not threads is ignored', async () => {
    workspace(12);
    mountRail();
    const target = (await screen.findByText('Notebook 1')).closest('li') as HTMLElement;
    const dt = transfer();
    dt.setData('text/plain', 'hello');
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it('Archive and Delete from the bar make one notice each, and Delete says it went to the Trash', async () => {
    workspace(12);
    mountRail();
    await screen.findByText('Thread 3');
    fireEvent.click(linkOf('thr_3'), { ctrlKey: true });
    fireEvent.click(linkOf('thr_4'), { ctrlKey: true });
    const bar = await screen.findByRole('toolbar');

    post.mockResolvedValueOnce({ done: [stateOf('thr_3'), stateOf('thr_4')], skipped: [] });
    fireEvent.click(within(bar).getByRole('button', { name: /Archive/ }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/threads/bulk', { action: 'archive', ids: ['thr_3', 'thr_4'] }),
    );
    await flush();
    expect(useNotify.getState().toasts.at(-1)?.title).toBe('Archived 2 threads');

    post.mockResolvedValueOnce({ done: [stateOf('thr_3'), stateOf('thr_4')], skipped: [] });
    fireEvent.click(within(await screen.findByRole('toolbar')).getByRole('button', { name: /Delete/ }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/threads/bulk', { action: 'delete', ids: ['thr_3', 'thr_4'] }),
    );
    await flush();
    const t = useNotify.getState().toasts.at(-1);
    expect(t?.title).toBe('Moved 2 threads to the Trash');
    expect(t?.body).toContain('Kept for 30 days.');
    expect(t?.undo).toBeTypeOf('function');
  });

  it('a thread being answered is left, named in the same notice, and the rest still go', async () => {
    workspace(12);
    post.mockResolvedValue({
      done: [stateOf('thr_3')],
      skipped: [{ id: 'thr_4', title: 'Thread 4', reason: 'running', hint: 'Answering now' }],
    });
    mountRail();
    await screen.findByText('Thread 3');
    fireEvent.click(linkOf('thr_3'), { ctrlKey: true });
    fireEvent.click(linkOf('thr_4'), { ctrlKey: true });
    fireEvent.click(within(await screen.findByRole('toolbar')).getByRole('button', { name: /Archive/ }));
    await waitFor(() => expect(useNotify.getState().toasts.length).toBe(1));
    const t = useNotify.getState().toasts[0];
    expect(t?.title).toBe('Archived 1 thread');
    expect(t?.level).toBe('warn');
    expect(t?.body).toContain('answering now: “Thread 4”');
    expect(t?.undo).toBeTypeOf('function');
  });

  it('when everything is left alone, it says nothing changed and offers no Undo', async () => {
    workspace(12);
    post.mockResolvedValue({
      done: [],
      skipped: [{ id: 'thr_3', title: 'Thread 3', reason: 'running', hint: 'Answering now' }],
    });
    mountRail();
    await screen.findByText('Thread 3');
    fireEvent.click(linkOf('thr_3'), { ctrlKey: true });
    fireEvent.click(within(await screen.findByRole('toolbar')).getByRole('button', { name: /Delete/ }));
    await waitFor(() => expect(useNotify.getState().toasts.length).toBe(1));
    const t = useNotify.getState().toasts[0];
    expect(t?.title).toBe('Nothing was deleted');
    expect(t?.undo).toBeUndefined();
  });

  it('the Move menu lists notebooks and moves the selection', async () => {
    workspace(12);
    post.mockResolvedValue(done(['thr_3']));
    mountRail();
    await screen.findByText('Thread 3');
    fireEvent.click(linkOf('thr_3'), { ctrlKey: true });
    const move = within(await screen.findByRole('toolbar')).getByRole('button', { name: /Move/ });
    fireEvent.pointerDown(move, { button: 0, ctrlKey: false });
    fireEvent.keyDown(move, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Notebook 2' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/threads/bulk', {
        action: 'move',
        ids: ['thr_3'],
        notebook_id: 'nb_2',
      }),
    );
  });

  it('a failed call puts the list back and says what happened', async () => {
    workspace(12);
    post.mockRejectedValue(new Error('offline'));
    mountRail();
    await screen.findByText('Thread 3');
    fireEvent.click(linkOf('thr_3'), { ctrlKey: true });
    fireEvent.click(within(await screen.findByRole('toolbar')).getByRole('button', { name: /Archive/ }));
    await waitFor(() => expect(useNotify.getState().toasts.at(-1)?.level).toBe('error'));
    expect(useNotify.getState().toasts.at(-1)?.title).toContain("didn't reach Core");
  });
});

describe('what a thread wants of you', () => {
  it('threads that need you float into their own group, with an amber shield, and appear nowhere else', async () => {
    workspace(12, (i) =>
      i === 5 ? { waiting: true, live: true } : i === 7 ? { live: true } : i === 8 ? { unread: true } : {},
    );
    mountRail();
    const group = (await screen.findByRole('button', { name: 'Needs you' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(group).getByText('Thread 5')).toBeInTheDocument();
    expect(within(group).getByRole('img', { name: 'Needs you' })).toBeInTheDocument();
    expect(document.querySelectorAll('a[data-thread="thr_5"]').length).toBe(1);
    expect(screen.getByRole('img', { name: 'Answering' })).toHaveClass('live-dot');
    expect(screen.getByRole('img', { name: 'New answer, not opened yet' })).toBeInTheDocument();
  });

  it('a notebook rolls up the states of the threads inside it', async () => {
    workspace(12, (i) =>
      i === 5
        ? { notebook_id: 'nb_1', waiting: true }
        : i === 6
          ? { notebook_id: 'nb_1', waiting: true }
          : {},
    );
    mountRail();
    const row = (await screen.findByText('Notebook 1')).closest('a') as HTMLElement;
    expect(within(row).getByRole('img', { name: 'Needs you: 2' })).toBeInTheDocument();
  });

  it('opening a thread with a new answer marks it read in Core', async () => {
    workspace(12, (i) => (i === 4 ? { unread: true } : {}));
    params.threadId = 'thr_4';
    post.mockResolvedValue(undefined);
    mountRail();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/threads/thr_4/seen'));
    expect(screen.queryByRole('img', { name: 'New answer, not opened yet' })).toBeNull();
  });
});

describe('the Trash in the Archive area', () => {
  const item = (id: string, title: string, deleted: number) => ({
    id,
    title,
    notebook_id: null,
    deleted_at: new Date(Date.now() - deleted * 86_400_000).toISOString(),
    purge_at: new Date(Date.now() + (30 - deleted) * 86_400_000).toISOString(),
  });

  async function openTrash() {
    workspace(3);
    mountRail();
    await screen.findByText('Thread 1');
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trash' }));
  }

  it('lists deleted threads with when they go, and restores one with an Undo', async () => {
    trashItems = [item('thr_x', 'Old plan', 3)];
    await openTrash();
    expect(await screen.findByText('Old plan')).toBeInTheDocument();
    expect(screen.getByText(/Removed for good in 27 days/)).toBeInTheDocument();

    post.mockResolvedValue({
      done: [stateOf('thr_x', { deleted_at: '2026-10-01T00:00:00.000Z' })],
      skipped: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore Old plan' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/threads/bulk', { action: 'restore', ids: ['thr_x'] }),
    );
    await flush();
    expect(useNotify.getState().toasts.at(-1)?.title).toBe('Restored from the Trash');
  });

  it('Empty Trash asks first, says it cannot be undone, and sends the confirm only on yes', async () => {
    trashItems = [item('thr_x', 'Old plan', 3), item('thr_y', 'Older plan', 20)];
    await openTrash();
    fireEvent.click(await screen.findByRole('button', { name: /Empty Trash/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Empty the Trash?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/2 threads and their messages for good. They cannot be restored./),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep them' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).not.toHaveBeenCalled();

    post.mockResolvedValue({ purged: 2, kept: 0 });
    fireEvent.click(screen.getByRole('button', { name: /Empty Trash/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Empty Trash' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/threads/trash/empty', { confirm: true }));
    await flush();
    expect(useNotify.getState().toasts.at(-1)?.title).toBe('Trash emptied');
  });

  it('an empty Trash says so', async () => {
    trashItems = [];
    await openTrash();
    expect(await screen.findByText('The Trash is empty.')).toBeInTheDocument();
  });
});
