/**
 * CC6, the Cockpit half: a Claude Code send asks Core to wait when the
 * session is busy (queue_if_busy) and treats a queued answer as sent; the
 * waiting messages show above the composer with what each waits for, a
 * failed one with Try again, Send as a branch now and Remove; Open in
 * terminal copies the resume command.
 */
import type { ClaudeCodeBinding, ClaudeCodeLiveState, QueuedTurn } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { CcLiveLine, CcNotices } from '../src/claudecode/LiveBar';
import { sendClaudeCode } from '../src/claudecode/live';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'post' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const item = (p: Partial<QueuedTurn>): QueuedTurn => ({
  id: 'q_1',
  text: 'Run the tests',
  queued_at: '2026-10-16T05:00:00.000Z',
  waiting_for: 'terminal',
  host: 'pc',
  error: null,
  ...p,
});

const live = (p: Partial<ClaudeCodeLiveState> = {}): ClaudeCodeLiveState => ({
  state: 'ready',
  locked_elsewhere: false,
  model: null,
  effort: null,
  permission_mode: null,
  cwd: 'C:\\code\\app',
  context: null,
  queue: [],
  resume: null,
  synced_at: null,
  ...p,
});

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
  mocked.del.mockReset();
});

describe('one writer at a time, in the Cockpit', () => {
  it('asks Core to wait when busy, and a queued answer counts as sent', async () => {
    mocked.post.mockResolvedValue({ queued: item({}), position: 1 });
    mocked.get.mockResolvedValue(live());
    const ok = await sendClaudeCode({ threadId: 't1', parentId: 'm9', text: 'Run the tests' });
    expect(ok).toBe(true);
    expect(mocked.post).toHaveBeenCalledWith(
      '/threads/t1/turns',
      expect.objectContaining({ queue_if_busy: true }),
    );
  });

  it('never asks a branch to wait', async () => {
    mocked.post.mockResolvedValue({
      run_id: 'r',
      user_message_id: 'u',
      assistant_message_id: null, // no stream to open in a test
      engine: 'claude_code',
      model_id: null,
      context_notice: null,
    });
    await sendClaudeCode({ threadId: 't1', parentId: 'm9', text: 'x', asBranch: true });
    expect(mocked.post.mock.calls[0]?.[1]).not.toHaveProperty('queue_if_busy');
  });

  it('shows what each message waits for, and acts on one', async () => {
    mocked.get.mockResolvedValue(
      live({
        locked_elsewhere: true,
        open_in_terminal: true,
        queue: [
          item({}),
          item({ id: 'q_2', text: 'Then commit', waiting_for: 'turn' }),
          item({
            id: 'q_3',
            text: 'Broken',
            error: { title: 'The folder is gone', hint: 'Point it at its new folder.' },
          }),
        ],
      }),
    );
    mocked.del.mockResolvedValue({ items: [] });
    mocked.post.mockResolvedValue({ items: [] });
    wrap(<CcNotices threadId="t1" />);
    expect(await screen.findByText('Sends when the terminal closes')).toBeInTheDocument();
    expect(screen.getByText('Sends when this turn ends')).toBeInTheDocument();
    expect(screen.getByText('The folder is gone')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/claude-code/threads/t1/queue/q_3/retry', {}),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove this waiting message' })[1] as HTMLElement);
    await waitFor(() => expect(mocked.del).toHaveBeenCalledWith('/claude-code/threads/t1/queue/q_2'));
  });

  it('Open in terminal copies the resume command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocked.get.mockResolvedValue(
      live({
        resume: {
          cli: 'claude-code',
          cwd: 'C:\\code\\app',
          command: 'claude --resume s1',
          shell: 'cd "C:\\code\\app"; claude --resume s1',
        },
      }),
    );
    const binding = {
      session_id: 's1',
      cwd: 'C:\\code\\app',
      last_uuid: null,
      synced_at: '',
    } as ClaudeCodeBinding;
    const { useClaudeCodeLive } = await import('../src/claudecode/live');
    function Line() {
      const l = useClaudeCodeLive('t1').data;
      return <CcLiveLine threadId="t1" binding={binding} live={l} last={undefined} />;
    }
    wrap(<Line />);
    fireEvent.click(await screen.findByRole('button', { name: /Open in terminal/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('cd "C:\\code\\app"; claude --resume s1'));
  });
});
