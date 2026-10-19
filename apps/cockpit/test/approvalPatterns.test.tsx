/**
 * The approval dialog's patterns and its queue: every help example does
 * what it says with Core's own matcher, the live check, the (i) panel that
 * stays inside the dialog, several waiting requests answered from one
 * place, and each waiting step opening its own decision.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    to: _to,
    params: _p,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
  }) => (
    <a href="#link" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ApprovalDialog } from '../src/approvals/ApprovalDialog';
import { describePattern, PATTERN_EXAMPLES, patternCovers } from '../src/approvals/patterns';
import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import { fold, type LiveTurn } from '../src/lib/run';
import type { PendingApproval } from '../src/lib/types';
import { useUi } from '../src/state/ui';
import { ToolStep } from '../src/thread/ToolStepCards';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const pending = (p: Partial<PendingApproval> & Pick<PendingApproval, 'id'>): PendingApproval => ({
  runId: 'run_1',
  threadId: 'thr_1',
  tool: 'WebSearch',
  action: 'web.search',
  resource: 'web:search/tutoring centre',
  tier: 'gated',
  argsPreview: 'query: tutoring centre',
  suggestions: ['web:search/tutoring centre', 'web:search', 'web:*'],
  reason: 'The agent wants to search the web.',
  ...p,
});
const search = pending({ id: 'apr_s' });
const g2 = pending({
  id: 'apr_g2',
  tool: 'WebFetch',
  action: 'web.fetch',
  resource: 'http:https://ai.g2.com/reviews',
  suggestions: ['http:https://ai.g2.com/reviews', 'http:https://ai.g2.com/**'],
});
const aiera = pending({
  id: 'apr_ai',
  tool: 'WebFetch',
  action: 'web.fetch',
  resource: 'http:https://aiera.blog/',
  suggestions: ['http:https://aiera.blog/'],
});

beforeEach(() => {
  mocked.get.mockReset();
  mocked.post.mockReset();
  queryClient.clear();
  useUi.setState({ approvalOpen: true, approvalFocus: 'apr_s', demo: false });
});
afterEach(cleanup);

describe('pattern examples', () => {
  it.each(PATTERN_EXAMPLES.map((x) => [x.pattern, x] as const))('%s does what the help says', (_, x) => {
    expect(patternCovers(x.pattern, x.covers)).toBe(true);
    expect(patternCovers(x.pattern, x.misses)).toBe(false);
  });

  it('covers the whole help list asked for', () => {
    const patterns = PATTERN_EXAMPLES.map((x) => x.pattern);
    for (const p of [
      'web:search',
      'web:fetch',
      'web:*',
      'web:example.com',
      'web:*.example.com',
      'web:example.com/docs/**',
      'fs:/workspace/notes/**',
      'shell:git status*',
      'mcp:github/*',
    ])
      expect(patterns).toContain(p);
  });

  it('never lets a site rule cover a request that is not a search or a fetch', () => {
    expect(patternCovers('web:*', { action: 'http.post', resource: 'http:https://x.io/' })).toBe(false);
  });

  it('describes suggestions by what they are', () => {
    expect(describePattern('web:search/q', 0, 'web:search/q')).toBe('This search only');
    expect(describePattern('web:search', 1, 'web:search/q')).toBe('Every web search');
    expect(describePattern('web:*', 2, 'web:search/q')).toBe('Every web search and every website');
    expect(describePattern('fs:/w/a.md', 0, 'fs:/w/a.md')).toBe('This file only');
    expect(describePattern('fs:/w/**', 1, 'fs:/w/a.md')).toBe('Anything under /w/');
  });
});

describe('a pattern of my own', () => {
  it('opens the help inside the dialog, fills the field from an example, and checks it live', () => {
    queryClient.setQueryData(keys.approvals, [search]);
    wrap(<ApprovalDialog approval={search} />);
    fireEvent.click(screen.getByRole('radio', { name: /A pattern of my own/ }));
    const field = screen.getByLabelText('Custom pattern');
    fireEvent.change(field, { target: { value: 'web:example.com' } });
    expect(screen.getByText(/matches the current request: no/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'How patterns work' }));
    expect(screen.getByRole('region', { name: 'How patterns work' })).toBeInTheDocument();
    expect(useUi.getState().approvalOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /All websites and all searches/ }));
    expect(field).toHaveValue('web:*');
    expect(screen.getByText(/matches the current request: yes/)).toBeInTheDocument();
    // Still open, still on the same request.
    expect(useUi.getState().approvalOpen).toBe(true);
  });
});

describe('several requests waiting', () => {
  it('lists the others with a count, answers one in place, and opens another', async () => {
    queryClient.setQueryData(keys.approvals, [g2, search, aiera]);
    mocked.post.mockResolvedValue(undefined);
    mocked.get.mockImplementation(async () => ({
      items: (mocked.post.mock.calls.length ? [search, aiera] : [g2, search, aiera]).map(apiShape),
    }));
    wrap(<ApprovalDialog approval={search} />);
    expect(screen.getByText('3 waiting')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Other requests waiting' })).toHaveTextContent('ai.g2.com');
    fireEvent.click(screen.getAllByRole('button', { name: 'Allow once' })[0] as HTMLElement);
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/approvals/apr_g2', { decision: 'approve', scope: 'once' }),
    );
    await waitFor(() => expect(screen.queryByText('2 waiting')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTitle('Open this request')[0] as HTMLElement);
    expect(useUi.getState().approvalFocus).toBe('apr_ai');
  });

  it('allow all with a remembered pattern: this one first, then the rest once', async () => {
    queryClient.setQueryData(keys.approvals, [g2, search, aiera]);
    mocked.post.mockResolvedValue(undefined);
    // After the remembered answer, Core settled g2; aiera is left.
    mocked.get.mockImplementation(async () => {
      const posts = mocked.post.mock.calls.length;
      return { items: (posts === 0 ? [g2, search, aiera] : posts === 1 ? [aiera] : []).map(apiShape) };
    });
    wrap(<ApprovalDialog approval={search} />);
    fireEvent.click(screen.getByRole('radio', { name: 'In this thread' }));
    fireEvent.click(screen.getByRole('radio', { name: /Every web search and every website/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow all 3' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
    expect(mocked.post.mock.calls[0]).toEqual([
      '/approvals/apr_s',
      { decision: 'approve', scope: 'thread', pattern: 'web:*' },
    ]);
    expect(mocked.post.mock.calls[1]).toEqual([
      '/approvals/batch',
      { approval_ids: ['apr_ai'], decision: 'approve' },
    ]);
    await waitFor(() => expect(useUi.getState().approvalOpen).toBe(false));
  });

  it('deny all answers every one once', async () => {
    queryClient.setQueryData(keys.approvals, [g2, search, aiera]);
    mocked.post.mockResolvedValue(undefined);
    mocked.get.mockResolvedValue({ items: [] });
    wrap(<ApprovalDialog approval={search} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline all 3' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/approvals/batch', {
        approval_ids: ['apr_s', 'apr_g2', 'apr_ai'],
        decision: 'deny',
      }),
    );
  });
});

describe('waiting steps', () => {
  const turn = (): LiveTurn => ({
    runId: 'run_1',
    threadId: 'thr_1',
    messageId: 'msg_1',
    parts: [],
    status: 'running',
    modelId: null,
    modelName: null,
    fallback: null,
    waking: null,
    approvalId: null,
    approvals: {},
    error: null,
    done: false,
    lastSeq: 0,
  });
  const required = (seq: number, approval_id: string, call_id: string) =>
    ({
      type: 'approval.required',
      seq,
      at: '2026-10-13T00:00:00Z',
      approval_id,
      call_id,
      tool: 'WebFetch',
      action: 'web.fetch',
      resource: 'http:https://x/',
      tier: 'gated',
      args_preview: {},
      suggestions: [],
    }) as unknown as Parameters<typeof fold>[1];

  it('keeps every open approval by its call, and the latest still open', () => {
    let t = turn();
    t = fold(t, required(1, 'a1', 'c1'));
    t = fold(t, required(2, 'a2', 'c2'));
    t = fold(t, required(3, 'a3', 'c3'));
    expect(t.approvals).toEqual({ c1: 'a1', c2: 'a2', c3: 'a3' });
    t = fold(t, {
      type: 'approval.resolved',
      seq: 4,
      at: 'x',
      approval_id: 'a3',
      decision: 'approved',
    } as never);
    expect(t.approvals).toEqual({ c1: 'a1', c2: 'a2' });
    expect(t.approvalId).toBe('a2');
    t = fold(t, {
      type: 'approval.resolved',
      seq: 5,
      at: 'x',
      approval_id: 'a1',
      decision: 'approved',
    } as never);
    expect(t.approvalId).toBe('a2');
  });

  it('opens its own decision from "Waiting for your decision"', () => {
    useUi.setState({ approvalOpen: false, approvalFocus: null });
    render(
      <ToolStep
        call={{ type: 'tool_call', call_id: 'c2', tool: 'WebFetch', args: { url: 'https://aiera.blog/' } }}
        result={undefined}
        waiting
        approvalId="a2"
        folded={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Waiting for your decision' }));
    expect(useUi.getState()).toMatchObject({ approvalOpen: true, approvalFocus: 'a2' });
  });
});

/** The wire shape of a pending approval, for the mocked GET /approvals. */
function apiShape(a: PendingApproval) {
  return {
    id: a.id,
    run_id: a.runId,
    thread_id: a.threadId,
    tool: a.tool,
    action: a.action,
    resource: a.resource,
    tier: a.tier,
    args_preview: a.argsPreview,
    suggestions: a.suggestions,
    status: 'pending',
    created_at: '2026-10-13T00:00:00Z',
    expires_at: null,
  };
}
