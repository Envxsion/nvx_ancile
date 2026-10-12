/**
 * The Activity panel, the Cockpit half: rows grouped and worded, the empty
 * state, a row opening its thread at its message, the status bar's count
 * from `activity.changed`, the import progress line (folder, paused) and the
 * typing hint that goes only while an import runs.
 */
import type { ActivityItem, ActivityResponse } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...real, useNavigate: () => navigate };
});
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ActivityPanel, ActivitySegment, ImportSegment } from '../src/activity/ActivityPanel';
import {
  ACTIVITY_KEY,
  grouped,
  noteTyping,
  onActivityChanged,
  resetTypingHint,
  since,
  stateLabel,
  TYPING_EVERY_MS,
  useActivityPanel,
} from '../src/activity/api';
import { demoActivity } from '../src/activity/demo';
import { importLine, onClaudeCodeChanged, useImportProgress } from '../src/claudecode/api';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { useUi } from '../src/state/ui';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

function item(p: Partial<ActivityItem> & Pick<ActivityItem, 'id' | 'kind' | 'title'>): ActivityItem {
  return {
    detail: null,
    state: 'running',
    started_at: new Date(Date.now() - 65_000).toISOString(),
    updated_at: null,
    finished_at: null,
    thread_id: null,
    thread_title: null,
    message_id: null,
    run_kind: null,
    run_status: null,
    progress: null,
    session_id: null,
    project: null,
    held: null,
    ...p,
  };
}

const response = (items: ActivityItem[], extra: Partial<ActivityResponse> = {}): ActivityResponse => ({
  items,
  running: items.filter((i) => i.state === 'running' || i.state === 'waiting').length,
  import: null,
  at: new Date().toISOString(),
  ...extra,
});

beforeEach(() => {
  useUi.setState({ demo: false });
  useActivityPanel.setState({ open: false, running: 0 });
  useImportProgress.getState().setProgress(null);
  resetTypingHint();
  navigate.mockReset();
  mocked.get.mockReset();
  mocked.post.mockReset();
  mocked.post.mockResolvedValue(undefined);
});
afterEach(() => {
  queryClient.clear();
});

describe('words and groups', () => {
  it('groups rows in the panel order and words their state', () => {
    const rows = [
      item({ id: 'shell:1', kind: 'shell', title: 'pnpm dev' }),
      item({
        id: 'run:1',
        kind: 'run',
        title: 'Fact-check',
        run_status: 'waiting_approval',
        state: 'waiting',
      }),
      item({ id: 'cc:1', kind: 'claude_session', title: 'Fix it', held: 'terminal' }),
      item({ id: 'agent:1', kind: 'subagent', title: 'Explore' }),
    ];
    expect(grouped(rows).map((g) => g.group)).toEqual(['ancile', 'elsewhere', 'subagents', 'shells']);
    expect(rows.map(stateLabel)).toEqual(['Running', 'Needs you', 'Open', 'Running']);
    expect(stateLabel(item({ id: 'x', kind: 'shell', title: 'x', state: 'failed' }))).toBe('Failed');
    const now = Date.UTC(2026, 9, 12, 9, 0, 0);
    expect(since(new Date(now - 12_000).toISOString(), now)).toBe('12 s');
    expect(since(new Date(now - 4 * 60_000).toISOString(), now)).toBe('4 min');
    expect(since(new Date(now - 125 * 60_000).toISOString(), now)).toBe('2 h 5 min');
    expect(since(null, now)).toBeNull();
  });

  it('words an import with its folder, and says when it waits for you', () => {
    expect(importLine({ done: 12, total: 40, project: 'nvx_ancile', paused: false })).toBe(
      'Bringing in 12 of 40 sessions (nvx_ancile)',
    );
    expect(importLine({ done: 12, total: 40, project: 'nvx_ancile', paused: true })).toBe(
      'Paused while you type: 12 of 40 sessions brought in',
    );
    expect(importLine({ done: 0, total: 1, project: null, paused: false })).toBe(
      'Bringing in 0 of 1 session',
    );
  });
});

describe('the panel', () => {
  it('says "Nothing running" when nothing is', async () => {
    mocked.get.mockResolvedValue(response([]));
    useActivityPanel.setState({ open: true });
    wrap(<ActivityPanel />);
    expect(await screen.findByText('Nothing running')).toBeTruthy();
    expect(mocked.get).toHaveBeenCalledWith('/activity');
  });

  it('lists rows by group and opens a row’s thread at its message', async () => {
    mocked.get.mockResolvedValue(
      response([
        item({
          id: 'run:1',
          kind: 'run',
          title: 'Fact-check',
          detail: 'Checking claims',
          run_kind: 'factcheck',
          run_status: 'running',
          progress: { done: 3, total: 7 },
          thread_id: 'thr_1',
          thread_title: 'Pricing notes',
          message_id: 'msg_9',
        }),
        item({
          id: 'shell:s:1',
          kind: 'shell',
          title: 'pnpm test',
          state: 'finished',
          finished_at: new Date().toISOString(),
        }),
      ]),
    );
    useActivityPanel.setState({ open: true });
    wrap(<ActivityPanel />);
    const dialog = await screen.findByRole('dialog', { name: 'Activity' });
    expect(await within(dialog).findByRole('heading', { name: /In NVX Ancile/ })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: /Background shells/ })).toBeTruthy();
    expect(within(dialog).getByText('3/7')).toBeTruthy();
    // A shell with no thread is not a link.
    expect(within(dialog).queryByRole('button', { name: /pnpm test/ })).toBeNull();
    fireEvent.click(
      within(dialog).getByRole('button', { name: /Fact-check: Running\. Open the thread Pricing notes/ }),
    );
    expect(navigate).toHaveBeenCalledWith({
      to: '/t/$threadId',
      params: { threadId: 'thr_1' },
      hash: 'msg_9',
    });
    expect(useActivityPanel.getState().open).toBe(false);
  });

  it('shows the import in progress, with its folder', async () => {
    mocked.get.mockResolvedValue(
      response([], { import: { done: 3, total: 900, project: 'cyberfolio', paused: false } }),
    );
    useActivityPanel.setState({ open: true });
    wrap(<ActivityPanel />);
    expect(await screen.findByText('Bringing in 3 of 900 sessions (cyberfolio)')).toBeTruthy();
  });

  it('has sample rows on demo data, all closed shapes', () => {
    const d = demoActivity(Date.UTC(2026, 9, 12));
    expect(d.running).toBe(5);
    expect(new Set(d.items.map((i) => i.kind))).toEqual(
      new Set(['run', 'claude_session', 'subagent', 'shell']),
    );
  });
});

describe('the status bar', () => {
  it('shows a count only while something runs, moved by activity.changed', async () => {
    mocked.get.mockResolvedValue(response([]));
    wrap(<ActivitySegment />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /running/ })).toBeNull();
    mocked.get.mockResolvedValue(
      response([
        item({ id: 'run:a', kind: 'run', title: 'Answer' }),
        item({ id: 'run:b', kind: 'run', title: 'Research' }),
      ]),
    );
    act(() => onActivityChanged({ type: 'activity.changed', seq: 1, at: '', running: 2 }, queryClient));
    const seg = await screen.findByRole('button', { name: '2 running. Show activity' });
    fireEvent.click(seg);
    expect(useActivityPanel.getState().open).toBe(true);
    expect(queryClient.getQueryCache().find({ queryKey: ACTIVITY_KEY, exact: false })).toBeTruthy();
  });

  it('shows a quiet import line for a large import, from claude_code.changed progress', () => {
    wrap(<ImportSegment />);
    act(() =>
      onClaudeCodeChanged(
        {
          type: 'claude_code.changed',
          seq: 1,
          at: '',
          what: 'sessions',
          detail: 'importing:2/3',
          progress: { done: 2, total: 3, project: 'app', paused: false },
        },
        queryClient,
      ),
    );
    expect(screen.queryByRole('button', { name: /Importing/ })).toBeNull(); // small: no line
    act(() =>
      onClaudeCodeChanged(
        {
          type: 'claude_code.changed',
          seq: 2,
          at: '',
          what: 'sessions',
          detail: 'importing:120/2400',
          progress: { done: 120, total: 2400, project: 'app', paused: true },
        },
        queryClient,
      ),
    );
    expect(screen.getByRole('button', { name: /Import paused while you type: 120 of 2400/ })).toBeTruthy();
    act(() =>
      onClaudeCodeChanged(
        {
          type: 'claude_code.changed',
          seq: 3,
          at: '',
          what: 'sessions',
          detail: 'imported:2400',
          progress: null,
        },
        queryClient,
      ),
    );
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull();
    expect(useImportProgress.getState().line).toBeNull();
  });
});

describe('typing hints', () => {
  it('go only while an import runs, at most once a moment, and never say what was typed', () => {
    noteTyping(1_000);
    expect(mocked.post).not.toHaveBeenCalled();
    useImportProgress.getState().setProgress({ done: 1, total: 50, project: null, paused: false });
    noteTyping(2_000);
    noteTyping(2_100);
    expect(mocked.post).toHaveBeenCalledTimes(1);
    expect(mocked.post).toHaveBeenCalledWith('/activity/typing', { ms: 2_500 });
    noteTyping(2_000 + TYPING_EVERY_MS);
    expect(mocked.post).toHaveBeenCalledTimes(2);
  });
});
