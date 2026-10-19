/**
 * TS1 and TS2 (Pro halves, public side): the locked state is a gilt line and never a dead control, the
 * Pro parts are handed the words and the way to act, switching branch says so when the branch is gone,
 * and the find bar steps to a hit on another branch once that branch is showing.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/threadPages', () => ({ ensureLoaded: vi.fn() }));
vi.mock('../src/lib/branching', () => ({ refreshThread: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/findBranches', () => ({ switchToBranch: vi.fn() }));

const feature = {
  ui: null as null | { parts?: Record<string, unknown> },
  unlocked: false,
  build: 'free' as 'free' | 'pro' | null,
  loading: false,
  noSeat: false,
};
vi.mock('../src/pro/slot', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/pro/slot')>();
  return { ...real, useProFeature: () => feature };
});

import { ApiCallError, api } from '../src/lib/api';
import { refreshThread } from '../src/lib/branching';
import { switchToBranch as realSwitch } from '../src/lib/findBranches';
import { useFind } from '../src/lib/findStore';
import { queryClient } from '../src/lib/query';
import type { MessageView } from '../src/lib/types';
import { SearchFilters } from '../src/palette/SearchFilters';
import { useNotify } from '../src/state/notify';
import { useUi } from '../src/state/ui';
import { FindBar } from '../src/thread/FindBar';
import { FindBranches } from '../src/thread/FindBranches';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={queryClient}>
    <Tooltip.Provider>{ui}</Tooltip.Provider>
  </QueryClientProvider>
);

beforeEach(() => {
  feature.ui = null;
  feature.unlocked = false;
  feature.build = 'free';
  feature.loading = false;
  feature.noSeat = false;
  nav.mockClear();
  vi.mocked(api.get).mockResolvedValue({ items: [] });
  queryClient.setQueryData(['models', 'all'], []);
});
afterEach(() => {
  document.body.innerHTML = '';
  useFind.setState({ open: false, threadId: null, jump: null });
});

describe('Ctrl+K filters, Pro search', () => {
  it('says what Pro adds, in a gilt line, when it is locked', () => {
    render(wrap(<SearchFilters value={{}} onChange={() => {}} />));
    expect(screen.getByText(/Search tool outputs, notes and fact-check claims/)).toBeTruthy();
    expect(screen.getByText('About Pro')).toBeTruthy();
  });
  it('asks for a seat, not for Pro, when Pro is on but this person has none', () => {
    feature.build = 'pro';
    feature.noSeat = true;
    render(wrap(<SearchFilters value={{}} onChange={() => {}} />));
    expect(screen.getByText(/no Pro seat/)).toBeTruthy();
    expect(screen.getByText('See who has a seat')).toBeTruthy();
  });
  it('hands Pro the words typed, the filters, and a way to open a hit and to use a saved search', () => {
    const seen: Record<string, unknown>[] = [];
    feature.unlocked = true;
    feature.ui = {
      parts: {
        SearchPro: (
          p: Record<string, unknown> & { open: (t: unknown) => void; apply: (q: string, f: unknown) => void },
        ) => {
          seen.push(p);
          return (
            <>
              <button
                type="button"
                onClick={() => p.open({ threadId: 'thr_1', messageId: 'm_1', notebookId: null })}
              >
                open hit
              </button>
              <button type="button" onClick={() => p.apply('pump', { notebook: 'nbk_1' })}>
                use saved
              </button>
            </>
          );
        },
      },
    };
    const input = document.createElement('input');
    input.setAttribute('cmdk-input', '');
    input.value = 'pump';
    document.body.append(input);
    const onChange = vi.fn();
    useUi.setState({ paletteOpen: true });
    render(wrap(<SearchFilters value={{ who: 'mine' }} onChange={onChange} />));
    expect(seen.at(-1)).toMatchObject({ query: 'pump', filter: { who: 'mine' } });

    fireEvent.click(screen.getByText('open hit'));
    expect(nav).toHaveBeenCalledWith({ to: '/t/$threadId', params: { threadId: 'thr_1' }, hash: 'm_1' });
    expect(useUi.getState().paletteOpen).toBe(false);

    fireEvent.click(screen.getByText('use saved'));
    expect(onChange).toHaveBeenCalledWith({ notebook: 'nbk_1' });
  });
});

describe('Find bar, All branches', () => {
  it('is a gilt line when locked, and asks nothing', () => {
    vi.mocked(api.get).mockClear();
    render(wrap(<FindBranches threadId="thr_1" query="pump" currentId="m2" pick={() => {}} />));
    expect(screen.getByText(/Find these words on the other branches/)).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
  it('hands Pro the thread, the words and the branch on screen when unlocked', () => {
    const got = vi.fn();
    feature.unlocked = true;
    feature.ui = {
      parts: {
        FindBranches: (p: unknown) => {
          got(p);
          return <p>Pro list</p>;
        },
      },
    };
    render(wrap(<FindBranches threadId="thr_1" query="pump" currentId="m2" pick={() => {}} />));
    expect(screen.getByText('Pro list')).toBeTruthy();
    expect(got).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thr_1', query: 'pump', currentId: 'm2' }),
    );
  });
});

const msg = (id: string, text: string): MessageView => ({
  id,
  parentId: null,
  role: 'assistant',
  blocks: [],
  parts: [{ type: 'text', text }],
  modelId: 'm/one',
  createdAt: '2026-10-19T00:00:00.000Z',
});

describe('Find bar, jumping to another branch', () => {
  const setup = (result: 'ok' | 'gone' | 'failed') => {
    vi.mocked(realSwitch).mockResolvedValue(result);
    feature.unlocked = true;
    feature.ui = {
      parts: {
        FindBranches: (p: { pick: (x: unknown) => void }) => (
          <button type="button" onClick={() => p.pick({ leafId: 'm9', messageId: 'm9', where: 'text' })}>
            jump to Branch 1
          </button>
        ),
      },
    };
    useFind.getState().show('thr_1');
    const current = [msg('m1', 'a pump here'), msg('m2', 'more')];
    const view = render(wrap(<FindBar messages={current} />));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in this thread' }), {
      target: { value: 'pump' },
    });
    fireEvent.click(screen.getByRole('button', { name: /find on other branches/i }));
    return { view, current };
  };

  it('switches branch, then steps to the hit once the branch is showing', async () => {
    const { view } = setup('ok');
    await act(async () => {
      fireEvent.click(screen.getByText('jump to Branch 1'));
    });
    expect(realSwitch).toHaveBeenCalledWith(
      'thr_1',
      expect.objectContaining({ leafId: 'm9', messageId: 'm9' }),
      'm2',
    );
    // The thread now shows the other branch.
    view.rerender(
      wrap(<FindBar messages={[msg('m1', 'a pump here'), msg('m9', 'the pump on the other branch')]} />),
    );
    await waitFor(() => expect(useFind.getState().jump?.hit.messageId).toBe('m9'));
  });

  it('says a deleted branch is gone, moves nothing, and asks for the list again', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    setup('gone');
    await act(async () => {
      fireEvent.click(screen.getByText('jump to Branch 1'));
    });
    expect(useNotify.getState().history.some((n) => n.title === 'That branch has been deleted')).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['pro', 'find', 'branches'] });
    expect(useFind.getState().jump?.hit.messageId).not.toBe('m9');
  });
});

describe('switching branch', () => {
  it('reads as gone when Core no longer has the branch, and when the hit is no longer on its path', async () => {
    const { switchToBranch } =
      await vi.importActual<typeof import('../src/lib/findBranches')>('../src/lib/findBranches');
    const threadPages = await import('../src/lib/threadPages');
    // The write itself says the message is gone.
    vi.mocked(api.patch).mockRejectedValueOnce(
      new ApiCallError(404, {
        error: { code: 'request.not_found', title: 'That message is not there', hint: '', trace_id: 't' },
      } as never),
    );
    expect(await switchToBranch('thr_1', { leafId: 'x', messageId: 'y' }, 'm2')).toBe('gone');

    // The write worked, but the hit's message was deleted in the meantime: put the head back.
    vi.mocked(api.patch).mockReset().mockResolvedValue({});
    vi.mocked(threadPages.ensureLoaded).mockResolvedValueOnce(false);
    expect(await switchToBranch('thr_1', { leafId: 'x', messageId: 'y' }, 'm2')).toBe('gone');
    expect(api.patch).toHaveBeenLastCalledWith('/threads/thr_1', { active_head_id: 'm2' });
    expect(refreshThread).toHaveBeenCalled();

    vi.mocked(threadPages.ensureLoaded).mockResolvedValueOnce(true);
    expect(await switchToBranch('thr_1', { leafId: 'x', messageId: 'y' }, 'm2')).toBe('ok');
  });
});
