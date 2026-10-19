/**
 * Roadmap FC3 wired into the thread: words highlighted in a message of yours
 * or in an answer offer Fact-check, F checks the highlight (not the whole
 * answer) when there is one, and the whole-answer check still works when
 * nothing is highlighted. The card loads only when a highlight is checked.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useNavigate: () => vi.fn(),
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

import { installKeys } from '../src/keys/dispatch';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import type { MessageView } from '../src/lib/types';
import { useSelectionCheck } from '../src/state/selectionCheck';
import { useUi } from '../src/state/ui';
import { Message } from '../src/thread/Message';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;

const view = (role: 'user' | 'assistant', text: string): MessageView => ({
  id: role === 'user' ? 'u1' : 'a1',
  parentId: role === 'user' ? null : 'u1',
  role,
  blocks: [],
  parts: [{ type: 'text', text }],
  modelId: null,
  createdAt: new Date().toISOString(),
  status: 'complete',
});

const WORDS = 'Error code E-17 means the impeller is blocked. Owls are nocturnal birds.';

function show(m: MessageView, selected = true) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <Message m={m} threadId="thr_1" selected={selected} onSelect={() => {}} />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

function highlightWords(container: HTMLElement) {
  const p = container.querySelector('.msg__body p') as HTMLElement;
  const range = document.createRange();
  range.setStart(p.firstChild as Node, 0);
  range.setEnd(p.firstChild as Node, 46);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  fireEvent.mouseUp(p);
  return p;
}

let off: () => void;
beforeEach(() => {
  Range.prototype.getBoundingClientRect = () =>
    ({ left: 100, top: 200, right: 260, bottom: 220, width: 160, height: 20 }) as DOMRect;
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.get.mockResolvedValue(null);
  mocked.post.mockResolvedValue({});
  useUi.setState({ demo: false });
  useSelectionCheck.setState({ toolbar: null, card: null });
  off = installKeys();
});
afterEach(() => {
  off();
  window.getSelection()?.removeAllRanges();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 5)));

describe('a highlight in a message', () => {
  it('in your own message offers Fact-check, and F checks the highlight', async () => {
    const { container } = show(view('user', WORDS));
    highlightWords(container);
    await settle();
    expect(screen.getByRole('toolbar', { name: 'Highlighted text' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'f' });
    expect(useSelectionCheck.getState().card).toMatchObject({
      messageId: 'u1',
      threadId: 'thr_1',
      text: 'Error code E-17 means the impeller is blocked.',
    });
  });

  it('in an answer: F checks the highlight and not the whole answer', async () => {
    const { container } = show(view('assistant', WORDS));
    highlightWords(container);
    await settle();
    fireEvent.keyDown(window, { key: 'f' });
    expect(useSelectionCheck.getState().card?.messageId).toBe('a1');
    // The whole-answer check was not started.
    expect(mocked.post.mock.calls.map((c) => c[0])).not.toContain('/messages/a1/factcheck');
  });

  it('with nothing highlighted, F still checks the whole answer', async () => {
    mocked.post.mockResolvedValue({ factcheck_id: 'f', run_id: 'r', stream_url: '/x' });
    show(view('assistant', WORDS));
    fireEvent.keyDown(window, { key: 'f' });
    await settle();
    expect(mocked.post).toHaveBeenCalledWith('/messages/a1/factcheck', undefined);
    expect(useSelectionCheck.getState().card).toBeNull();
  });

  it('is not offered while an answer is still being written, or on demo data', async () => {
    const writing = { ...view('assistant', WORDS), status: 'streaming' as const };
    const { container, unmount } = show(writing);
    highlightWords(container);
    await settle();
    expect(screen.queryByRole('toolbar', { name: 'Highlighted text' })).toBeNull();
    unmount();
    useUi.setState({ demo: true });
    const demo = show(view('assistant', WORDS));
    highlightWords(demo.container);
    await settle();
    expect(screen.queryByRole('toolbar', { name: 'Highlighted text' })).toBeNull();
  });
});
