/**
 * AN3 (free half and the Pro seam) and TC4 (the memory inbox): Open as artifact for a diagram, the Apply to
 * repo button's conditions and its locked card, the inbox's Ctrl and Shift selection with one bar and one
 * Undo, and the rail's locked smart sections row.
 */
import type { MemoryProposal, MemoryProposalList } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  useRouterState: () => '/t/thr_1',
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('mermaid', () => ({
  default: { initialize: () => {}, render: async () => ({ svg: '<svg role="presentation"></svg>' }) },
}));
const feature = {
  unlocked: false,
  build: 'free' as 'free' | 'pro',
  ui: null as unknown,
  loading: false,
  noSeat: false,
};
vi.mock('../src/pro/slot', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/pro/slot')>();
  return { ...real, useProFeature: () => feature };
});
let linked: { id: string; name: string; root: string } | null = {
  id: 'rep_1',
  name: 'app',
  root: '/home/me/app',
};
vi.mock('../src/repos/data', () => ({
  useRepoScope: () => ({ threadId: 'thr_1', notebookId: null }),
  useLinkedRepo: () => ({ data: linked }),
}));

import { useArtifacts } from '../src/artifacts/store';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { AnswerContext, ThreadIdContext } from '../src/lib/threadContext';
import { decideMany } from '../src/memory/api';
import { Inbox } from '../src/memory/Inbox';
import { SmartSectionsHost } from '../src/pro/SmartSectionsHost';
import { useNotify } from '../src/state/notify';
import { CodeTools, diagramKey, MermaidView } from '../src/thread/CodeActions';

const mocked = api as unknown as Record<'get' | 'post' | 'put', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
const answer = (streaming: boolean) => ({ messageId: 'msg_1', createdAt: '2026-10-12T09:00:00Z', streaming });
const inAnswer = (streaming: boolean, ui: ReactNode) => (
  <ThreadIdContext.Provider value="thr_1">
    <AnswerContext.Provider value={answer(streaming)}>{ui}</AnswerContext.Provider>
  </ThreadIdContext.Provider>
);

beforeEach(() => {
  linked = { id: 'rep_1', name: 'app', root: '/home/me/app' };
  feature.unlocked = false;
  feature.build = 'free';
  feature.ui = null;
  feature.loading = false;
  feature.noSeat = false;
});
afterEach(() => {
  queryClient.clear();
  for (const m of Object.values(mocked)) m.mockReset();
  useArtifacts.getState().close();
  useNotify.setState({ toasts: [], history: [] });
});

describe('Open as artifact (a Mermaid diagram)', () => {
  it('hands the diagram to the artifact panel, and waits while the fence is still being written', async () => {
    const code = 'graph TD\n  A --> B';
    const view = wrap(inAnswer(true, <MermaidView code={code} />));
    const btn = await screen.findByRole('button', { name: /Open as artifact/ }, { timeout: 3_000 });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    view.unmount();

    wrap(inAnswer(false, <MermaidView code={code} />));
    fireEvent.click(await screen.findByRole('button', { name: /Open as artifact/ }, { timeout: 3_000 }));
    const open = useArtifacts.getState().open;
    expect(open).toMatchObject({ threadId: 'thr_1', messageId: 'msg_1' });
    expect(open?.artifact).toMatchObject({
      type: 'mermaid',
      content: code,
      complete: true,
      key: diagramKey(code),
    });
    expect(diagramKey(code)).toBe(diagramKey(code));
    expect(diagramKey(code)).not.toBe(diagramKey(`${code}\n  B --> C`));
  });
});

describe('Apply to repo (the button and its locked card)', () => {
  const tools = (streaming = false) =>
    wrap(inAnswer(streaming, <CodeTools code="x = 1" lang="python" wrap={false} onWrap={() => {}} />));

  it('is hidden in a thread with no linked repository', () => {
    linked = null;
    tools();
    expect(screen.queryByRole('button', { name: /Apply to repo/ })).toBeNull();
  });

  it('is hidden outside an answer', () => {
    wrap(<CodeTools code="x = 1" lang="python" wrap={false} onWrap={() => {}} />);
    expect(screen.queryByRole('button', { name: /Apply to repo/ })).toBeNull();
  });

  it('is disabled while the answer is still being written', () => {
    tools(true);
    expect((screen.getByRole('button', { name: /Apply to repo/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens a gilt card, not a broken control, when Pro is not there', () => {
    tools();
    fireEvent.click(screen.getByRole('button', { name: /Apply to repo/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/Apply a code block to your repository/)).toBeTruthy();
    expect(screen.getByText(/part of NVX Ancile Pro, which this build does not include/)).toBeTruthy();
    expect(mocked.put).not.toHaveBeenCalled();
    expect(mocked.get).not.toHaveBeenCalled();
  });

  it('hands Pro the block, the repo and when the answer was written, and writes nothing itself', () => {
    const Part = vi.fn((_props: Record<string, unknown>) => <p>Pro review</p>);
    feature.unlocked = true;
    feature.build = 'pro';
    feature.ui = { parts: { ApplyToRepo: Part } };
    tools();
    fireEvent.click(screen.getByRole('button', { name: /Apply to repo/ }));
    expect(screen.getByText('Pro review')).toBeTruthy();
    expect(Part.mock.calls[0]?.[0]).toMatchObject({
      threadId: 'thr_1',
      code: 'x = 1',
      lang: 'python',
      repo: { id: 'rep_1', root: '/home/me/app' },
      answeredAt: '2026-10-12T09:00:00Z',
    });
    expect(mocked.put).not.toHaveBeenCalled();
  });
});

describe('smart sections in the rail', () => {
  it('shows nothing in the rail: the rail is for your work, not offers', () => {
    const { container } = render(<SmartSectionsHost activeId={null} notebooks={[]} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button', { name: /Smart sections/ })).toBeNull();
  });
  it('draws Pro’s sections when Pro has them and the licence unlocks them', () => {
    const Part = vi.fn((_props: Record<string, unknown>) => <p>Pro sections</p>);
    feature.unlocked = true;
    feature.ui = { parts: { SmartSections: Part } };
    render(<SmartSectionsHost activeId="thr_1" notebooks={[{ id: 'n', title: 'N' }]} />);
    expect(screen.getByText('Pro sections')).toBeTruthy();
    expect(Part.mock.calls[0]?.[0]).toEqual({ activeId: 'thr_1', notebooks: [{ id: 'n', title: 'N' }] });
  });
});

const proposal = (n: number, over: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: `mpr_${n}`,
  kind: 'preference',
  target_path: 'USER.md',
  op: 'add',
  section: 'Preferences',
  text: `Entry number ${n}.`,
  target_key: null,
  target_text: null,
  rationale: 'You corrected the last answer.',
  confidence: 0.85,
  provenance: 'user_message',
  evidence: [],
  status: 'proposed',
  commit_sha: null,
  created_at: '2026-10-19T00:00:00.000Z',
  decided_at: null,
  ...over,
});

function serve(items: MemoryProposal[]) {
  mocked.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/memory/proposals'))
      return { items, pending: items.length } satisfies MemoryProposalList;
    return {};
  });
  mocked.post.mockImplementation(async (_p: string, body: { decision: string }) => ({
    ...items[0],
    status: body.decision,
  }));
}
const cards = () => [...document.querySelectorAll<HTMLElement>('.mem-card')];

describe('the memory inbox, selecting like the rail', () => {
  it('Ctrl click toggles, Shift click runs a range from the anchor, and one bar acts on all of them', async () => {
    serve([1, 2, 3, 4, 5].map((n) => proposal(n)));
    wrap(<Inbox />);
    await waitFor(() => expect(cards()).toHaveLength(5));
    expect(screen.queryByRole('toolbar')).toBeNull();

    fireEvent.click(cards()[1] as HTMLElement, { ctrlKey: true });
    expect(screen.getByRole('toolbar').textContent).toContain('1 selected');
    fireEvent.click(cards()[3] as HTMLElement, { shiftKey: true });
    expect(screen.getByRole('toolbar').textContent).toContain('3 selected');
    expect(cards().map((c) => c.hasAttribute('data-selected'))).toEqual([false, true, true, true, false]);
    fireEvent.click(cards()[2] as HTMLElement, { ctrlKey: true });
    expect(cards().map((c) => c.hasAttribute('data-selected'))).toEqual([false, true, false, true, false]);

    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /Remember/ }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
    expect(mocked.post.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['/memory/proposals/mpr_2', { decision: 'approve' }],
      ['/memory/proposals/mpr_4', { decision: 'approve' }],
    ]);
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
  });

  it('Space picks the focused card, Ctrl+A takes all, Escape lets go', async () => {
    serve([1, 2, 3].map((n) => proposal(n)));
    wrap(<Inbox />);
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.keyDown(cards()[0] as HTMLElement, { key: ' ' });
    expect(cards()[0]?.hasAttribute('data-selected')).toBe(true);
    fireEvent.keyDown(cards()[0] as HTMLElement, { key: 'a', ctrlKey: true });
    expect(screen.getByRole('toolbar').textContent).toContain('3 selected');
    fireEvent.keyDown(cards()[1] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('with several selected, R turns them all down', async () => {
    serve([1, 2, 3].map((n) => proposal(n)));
    wrap(<Inbox />);
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.keyDown(cards()[0] as HTMLElement, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(cards()[0] as HTMLElement, { key: 'r' });
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(3));
    expect(new Set(mocked.post.mock.calls.map((c) => (c[1] as { decision: string }).decision))).toEqual(
      new Set(['reject']),
    );
  });

  it('one notice, one Undo: it puts every suggestion back, newest first', async () => {
    mocked.get.mockResolvedValue({ items: [], pending: 0 });
    mocked.post.mockResolvedValue({});
    const r = await decideMany(['a', 'b', 'c'], 'approve');
    expect(r.done).toEqual(['a', 'b', 'c']);
    const notes = useNotify.getState().history;
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe('Remembered 3 suggestions');
    mocked.post.mockClear();
    await act(async () => notes[0]?.undo?.());
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(3));
    expect(mocked.post.mock.calls.map((c) => [c[0], (c[1] as { decision: string }).decision])).toEqual([
      ['/memory/proposals/c', 'undo'],
      ['/memory/proposals/b', 'undo'],
      ['/memory/proposals/a', 'undo'],
    ]);
  });

  it('copes with 500 at once, and counts the ones that could not be changed', async () => {
    mocked.get.mockResolvedValue({ items: [], pending: 0 });
    const ids = Array.from({ length: 500 }, (_, i) => `mpr_${i}`);
    mocked.post.mockImplementation(async (p: string) => {
      if (p.endsWith('mpr_7')) throw new Error('already dealt with');
      return {};
    });
    const r = await decideMany(ids, 'reject');
    expect(r.done).toHaveLength(499);
    expect(r.left).toBe(1);
    const n = useNotify.getState().history[0];
    expect(n?.title).toBe('Turned down 499 suggestions');
    expect(n?.body).toContain('1 could not be changed');
  });
});
