/**
 * M1, M2, M3, M8, M9, MT1 in the Cockpit: where a learning is kept when it is approved,
 * why it was learned and the turn to open, a watch item with its uncertainty, the
 * "Saved to memory" note with Undo, the hindsight pass, and Tidy storage.
 */
import type { MemoryProposal, MemoryProposalList } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { runHindsight } from '../src/memory/api';
import { Inbox } from '../src/memory/Inbox';
import { notebookBlocker } from '../src/memory/KeepIn';
import { TidyStorage } from '../src/ops/TidyStorage';
import { useNotify } from '../src/state/notify';
import { SavedNote } from '../src/thread/SavedNote';

const mocked = api as unknown as Record<'get' | 'post' | 'patch', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const proposal = (over: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: 'mpr_1',
  kind: 'preference',
  target_path: 'USER.md',
  op: 'add',
  section: 'Preferences',
  text: 'Wants budgets in a table.',
  target_key: null,
  target_text: null,
  rationale: 'You corrected the last answer.',
  confidence: 0.85,
  provenance: 'user_message',
  evidence: [{ thread_id: 'thr_1', message_id: 'msg_9', quote: 'put it in a table' }],
  status: 'proposed',
  commit_sha: null,
  created_at: '2026-10-19T00:00:00.000Z',
  decided_at: null,
  source: {
    thread_id: 'thr_1',
    thread_title: 'Grant budget',
    thread_deleted: false,
    message_id: 'msg_9',
    notebook: { id: 'nbk_1', title: 'Grant' },
  },
  ...over,
});

function serve(items: MemoryProposal[]) {
  mocked.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/memory/proposals'))
      return {
        items,
        pending: items.filter((p) => p.status === 'proposed').length,
      } satisfies MemoryProposalList;
    if (path === '/memory/files')
      return {
        head: 'abc',
        items: ['AGENTS.md', 'USER.md', 'PROJECTS/grant.md', 'PROJECTS/README.md'].map((p) => ({
          path: p,
          kind: 'other',
          title: p,
          version: 'v',
          updated_at: '2026-10-19T00:00:00.000Z',
          bytes: 1,
          entries: 1,
          auto: false,
        })),
      };
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  queryClient.clear();
  navigate.mockReset();
  for (const m of Object.values(mocked)) m.mockReset();
  useNotify.setState({ toasts: [], history: [] });
});

describe('M1: where to keep it', () => {
  it('sends the scope that was picked when it is approved', async () => {
    serve([proposal()]);
    mocked.post.mockResolvedValue(proposal({ status: 'applied' }));
    wrap(<Inbox />);
    await screen.findByText('Wants budgets in a table.');

    const you = screen.getByRole('radio', { name: 'You' });
    expect(you).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Everywhere' }));
    expect(screen.getByRole('radio', { name: 'Everywhere' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Remember/ }));

    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/memory/proposals/mpr_1', {
        decision: 'approve',
        scope: 'everywhere',
      }),
    );
  });

  it('sends the notebook scope, or a chosen file instead of a scope', async () => {
    serve([proposal(), proposal({ id: 'mpr_2', text: 'Cites APA.' })]);
    mocked.post.mockResolvedValue(proposal({ status: 'applied' }));
    wrap(<Inbox />);
    await screen.findByText('Wants budgets in a table.');
    const cards = screen.getAllByRole('listitem').filter((li) => li.classList.contains('mem-card'));

    fireEvent.click(within(cards[0] as HTMLElement).getByRole('radio', { name: 'This notebook' }));
    fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: /Remember/ }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/memory/proposals/mpr_1', {
        decision: 'approve',
        scope: 'notebook',
      }),
    );

    const select = within(cards[1] as HTMLElement).getByRole('combobox', { name: 'Or choose a file' });
    // Guide files are not offered.
    expect(within(select).queryByRole('option', { name: 'PROJECTS/README.md' })).toBeNull();
    fireEvent.change(select, { target: { value: 'PROJECTS/grant.md' } });
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: /Remember/ }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/memory/proposals/mpr_2', {
        decision: 'approve',
        path: 'PROJECTS/grant.md',
      }),
    );
  });

  it('turns This notebook off, and says why, when there is no notebook to keep it in', async () => {
    const loose = proposal({
      source: {
        thread_id: 'thr_1',
        thread_title: 'Chat',
        thread_deleted: false,
        message_id: 'msg_9',
        notebook: null,
      },
    });
    serve([loose]);
    wrap(<Inbox />);
    await screen.findByText('Wants budgets in a table.');
    const nb = screen.getByRole('radio', { name: 'This notebook' });
    expect(nb).toBeDisabled();
    expect(screen.getByText('It was not learned in a notebook')).toBeInTheDocument();
  });

  it('names every reason a notebook cannot be chosen', () => {
    const base = { target_path: 'USER.md' };
    const src = (over: object) => ({
      thread_id: 't',
      thread_title: 'x',
      thread_deleted: false,
      message_id: null,
      notebook: { id: 'n', title: 'N' },
      ...over,
    });
    expect(notebookBlocker({ ...base, source: null })).toBe('Not learned in a thread');
    expect(notebookBlocker({ ...base, source: src({ thread_deleted: true, notebook: null }) })).toBe(
      'The thread it came from was deleted',
    );
    expect(notebookBlocker({ ...base, source: src({ notebook: null }) })).toBe(
      'It was not learned in a notebook',
    );
    expect(notebookBlocker({ ...base, source: src({ notebook: { id: 'n', title: null } }) })).toBe(
      'That notebook was deleted',
    );
    expect(notebookBlocker({ ...base, source: src({}) })).toBeNull();
    // Already aimed at a notebook file: nothing to resolve.
    expect(notebookBlocker({ target_path: 'PROJECTS/grant.md', source: null })).toBeNull();
  });
});

describe('M3: why it was learned', () => {
  it('shows the confidence, the words, the thread, and opens the turn', async () => {
    serve([proposal()]);
    mocked.patch.mockResolvedValue({});
    wrap(<Inbox />);
    await screen.findByText('Wants budgets in a table.');
    expect(screen.getByText('85% sure')).toBeInTheDocument();
    expect(screen.getByText('put it in a table')).toBeInTheDocument();
    expect(screen.getByText('Learned in “Grant budget”')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open this turn' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/t/$threadId',
        params: { threadId: 'thr_1' },
        hash: 'msg_9',
      }),
    );
    // Looking at where it was learned never moves the thread's current branch.
    expect(mocked.patch).not.toHaveBeenCalledWith('/threads/thr_1', expect.anything());
  });

  it('says so, and offers no link, when the thread was deleted', async () => {
    serve([
      proposal({
        source: {
          thread_id: 'thr_1',
          thread_title: null,
          thread_deleted: true,
          message_id: 'msg_9',
          notebook: null,
        },
      }),
    ]);
    wrap(<Inbox />);
    await screen.findByText('Wants budgets in a table.');
    expect(screen.getByText('Learned from a thread that was deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open this turn' })).toBeNull();
    // The words it learned from are still there.
    expect(screen.getByText('put it in a table')).toBeInTheDocument();
  });
});

describe('M8: watch items', () => {
  it('waits under Watching with its uncertainty and when it lapses, and can be trusted early', async () => {
    const watch = proposal({
      id: 'mpr_w',
      kind: 'failure_lesson',
      target_path: 'FAILURES/exports.md',
      status: 'watching',
      text: '**Exports stall.** Cause: Unclear.',
      uncertainty: 'Seen once. The cause is not clear, so it may be a coincidence.',
      expires_at: '2027-01-17T00:00:00.000Z',
      sightings: 1,
      provenance: 'run_outcome',
    });
    serve([watch]);
    mocked.post.mockResolvedValue(proposal({ status: 'applied' }));
    wrap(<Inbox />);
    const section = await screen.findByRole('region', { name: 'Watching' });
    expect(within(section).getByText(/Seen once. The cause is not clear/)).toBeInTheDocument();
    expect(within(section).getByText(/Lapses 17 Jan 2027/)).toBeInTheDocument();
    // A lesson is kept by topic: a file, not a scope.
    expect(within(section).queryByRole('radiogroup')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: /Trust it now/ }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/memory/proposals/mpr_w', { decision: 'approve' }),
    );
  });

  it('shows a lapsed one as not seen again', async () => {
    serve([proposal({ id: 'mpr_x', status: 'expired', decided_at: '2027-01-17T00:00:00.000Z' })]);
    wrap(<Inbox />);
    expect(await screen.findByText('Not seen again')).toBeInTheDocument();
  });
});

describe('M2: Saved to memory, with Undo', () => {
  it('shows the note under the message it came from, and Undo reverts it', async () => {
    const saved = proposal({
      id: 'mpr_s',
      status: 'auto_applied',
      text: 'Never add a summary.',
      evidence: [{ thread_id: 'thr_1', message_id: 'msg_7' }],
    });
    serve([
      saved,
      proposal({ id: 'mpr_o', status: 'auto_applied', evidence: [{ message_id: 'msg_other' }] }),
    ]);
    mocked.post.mockResolvedValue({ ...saved, status: 'undone' });
    wrap(<SavedNote messageId="msg_7" />);
    expect(await screen.findByText('Saved to memory')).toBeInTheDocument();
    expect(screen.getByText('Never add a summary.')).toBeInTheDocument();
    expect(screen.getAllByText('Saved to memory')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/memory/proposals/mpr_s', { decision: 'undo' }),
    );
  });

  it('shows nothing under a message that saved nothing, or one still being sent', async () => {
    serve([proposal({ status: 'auto_applied', evidence: [{ message_id: 'msg_7' }] })]);
    const { container } = wrap(<SavedNote messageId="local-1" />);
    expect(container).toBeEmptyDOMElement();
    expect(mocked.get).not.toHaveBeenCalled();
  });

  it('does not claim a suggestion that is still waiting', async () => {
    serve([proposal({ status: 'proposed', evidence: [{ message_id: 'msg_7' }] })]);
    const { container } = wrap(<SavedNote messageId="msg_7" />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('M9: Hindsight pass', () => {
  it('asks Core to review the thread and points to the inbox', async () => {
    mocked.post.mockResolvedValue({
      nothing_worth_keeping: false,
      note: 'A retry fixed a path.',
      proposals: [proposal(), proposal({ id: 'mpr_2' })],
      turns_reviewed: 4,
      summarised: false,
    });
    const go = vi.fn();
    await runHindsight('thr_1', go);
    expect(mocked.post).toHaveBeenCalledWith('/threads/thr_1/hindsight', {});
    const n = useNotify.getState().history[0];
    expect(n?.title).toBe('2 things to consider');
    expect(n?.body).toContain('A retry fixed a path.');
    n?.action?.run();
    expect(go).toHaveBeenCalledWith('/admin/memory');
  });

  it('"Nothing worth keeping" is an answer, not an error', async () => {
    mocked.post.mockResolvedValue({
      nothing_worth_keeping: true,
      note: 'Nothing in this session is worth keeping.',
      proposals: [],
      turns_reviewed: 1,
      summarised: false,
    });
    await runHindsight('thr_1', vi.fn());
    const n = useNotify.getState().history[0];
    expect(n).toMatchObject({ level: 'success', title: 'Nothing worth keeping' });
  });
});

describe('MT1: Tidy storage', () => {
  it('previews first, then tidies, and shows what Core says', async () => {
    mocked.post.mockResolvedValueOnce({
      dry_run: true,
      summary: 'Would remove 4 duplicate chunks; would share 1 identical old version.',
    });
    mocked.post.mockResolvedValueOnce({
      dry_run: false,
      summary: 'Removed 4 duplicate chunks. A backup was taken first (b.dump).',
    });
    wrap(<TidyStorage />);
    fireEvent.click(screen.getByRole('button', { name: 'See what would change' }));
    expect(await screen.findByText(/Would remove 4 duplicate chunks/)).toBeInTheDocument();
    expect(mocked.post).toHaveBeenLastCalledWith('/system/tidy', { dry_run: true });
    fireEvent.click(screen.getByRole('button', { name: 'Tidy storage' }));
    expect(await screen.findByText(/A backup was taken first/)).toBeInTheDocument();
    expect(mocked.post).toHaveBeenLastCalledWith('/system/tidy', { dry_run: false });
  });

  it('says why in words when Core refuses, and shows no result', async () => {
    const { ApiCallError } = await import('../src/lib/api');
    mocked.post.mockRejectedValue(
      new ApiCallError(409, {
        error: {
          code: 'maintenance.busy',
          title: "Storage can't be tidied while something is running",
          hint: 'Wait until it finishes, then try again. Nothing was changed.',
          retryable: true,
          error_class: 'transient',
          trace_id: 't',
        },
      } as never),
    );
    wrap(<TidyStorage />);
    fireEvent.click(screen.getByRole('button', { name: 'Tidy storage' }));
    await waitFor(() =>
      expect(useNotify.getState().history[0]?.title).toBe(
        "Storage can't be tidied while something is running",
      ),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});
