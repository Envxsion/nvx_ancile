/**
 * Track G security, the Cockpit half: an MCP server that changed its tools
 * shows what moved and one "Approve new tool list" (by the fingerprint shown);
 * a step outside the approved plan is a grouped ask with Allow once, Add to
 * plan and Deny; "Reviewer offline, asking more often" is one quiet line,
 * dismissed per outage; and the scope editor says what had already left the
 * computer before a notebook became private.
 */
import type { McpToolApproval, ReviewerStatus, RunEvent, SharedBeforeLocal } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { BatchCard, ReviewerOffline } from '../src/auto/AutoCards';
import {
  batchTitle,
  onReviewerStatus,
  openBatch,
  REVIEWER_KEY,
  reviewerOfflineCopy,
  useAuto,
} from '../src/auto/store';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { ClaudeCodeChanges, ToolsChangedNote } from '../src/ops/McpServers';
import { diffWords } from '../src/ops/mcp';
import { sharedBeforeText } from '../src/scopes/api';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  useAuto.setState({ marks: {}, planRan: {}, batches: {}, planTick: {} });
  localStorage.clear();
});
afterEach(() => cleanup());

const at = '2026-10-12T09:00:00Z';

/* ---- MCP rug pull ---------------------------------------------------------- */

const CHANGED: McpToolApproval = {
  key: 'host:notes',
  origin: 'host',
  server: 'notes',
  state: 'changed',
  approved_fingerprint: 'a'.repeat(64),
  current_fingerprint: 'b'.repeat(64),
  approved_at: at,
  changed_at: at,
  diff: { added: ['send_notes'], removed: ['old'], changed: ['append'] },
  coverage: 'full',
};

describe('an MCP server that changed its tools', () => {
  it('says what moved', () => {
    expect(diffWords({ added: ['a'], changed: ['b', 'c'], removed: [] })).toBe('1 new, 2 changed');
  });

  it('lists the new, changed and removed tools, and approves by the fingerprint shown', async () => {
    mocked.post.mockResolvedValue({ ...CHANGED, state: 'approved', diff: null });
    wrap(<ToolsChangedNote approval={CHANGED} />);
    expect(
      screen.getByText(/New and changed tools are refused until you approve the new list/),
    ).toBeInTheDocument();
    expect(screen.getByText('send_notes')).toBeInTheDocument();
    expect(screen.getByText('append')).toBeInTheDocument();
    expect(screen.getByText('old')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve new tool list' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/mcp/approvals/host%3Anotes/approve', {
        fingerprint: 'b'.repeat(64),
      }),
    );
  });

  it("lists Claude Code's own servers that changed, and nothing when none did", async () => {
    mocked.get.mockResolvedValue({
      items: [
        CHANGED,
        { ...CHANGED, key: 'claude_code:github', origin: 'claude_code', server: 'github', coverage: 'names' },
      ],
    });
    wrap(<ClaudeCodeChanges />);
    expect(await screen.findByText("Claude Code's servers that changed")).toBeInTheDocument();
    expect(screen.getByLabelText('github, changed since approved')).toBeInTheDocument();
    expect(screen.queryByLabelText('notes, changed since approved')).toBeNull();
    expect(screen.getByText(/only reports tool names/)).toBeInTheDocument();
  });
});

/* ---- Out of plan ------------------------------------------------------------ */

describe('a step outside the approved plan', () => {
  function outOfPlan() {
    const note = useAuto.getState().note;
    note('thr_1', 'run_1', {
      seq: 1,
      at,
      type: 'approval.batched',
      batch_id: 'b1',
      call_id: 'c1',
      action: 'shell.exec',
      via: 'reviewer',
      reason: "The reviewer wasn't sure it fits the plan and the project",
      out_of_plan: true,
      plan_id: 'apl_1',
    } as RunEvent);
    note('thr_1', 'run_1', {
      seq: 2,
      at,
      type: 'approval.required',
      approval_id: 'apr_1',
      tool: 'Bash',
      action: 'shell.exec',
      resource: 'shell:git push origin fix',
      tier: 'gated',
      call_id: 'c1',
      suggestions: [],
    } as RunEvent);
    const b = openBatch(useAuto.getState().batches, 'thr_1');
    if (!b) throw new Error('a single out-of-plan ask should be shown');
    return b;
  }

  it('is one grouped ask, even alone: "1 step outside your plan", with the reason and the action', () => {
    wrap(<BatchCard batch={outOfPlan()} />);
    expect(screen.getByText('1 step outside your plan')).toBeInTheDocument();
    expect(screen.getByText('Outside your plan')).toBeInTheDocument();
    expect(screen.getByText(/wasn't sure it fits the plan/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Allow shell.exec on git push origin fix once' }),
    ).toHaveTextContent('Allow once');
    expect(
      screen.getByRole('button', { name: 'Deny shell.exec on git push origin fix' }),
    ).toBeInTheDocument();
    expect(batchTitle([{ outOfPlan: true }, { outOfPlan: false }])).toBe('2 steps need you');
  });

  it('Add to plan adds the step to the approved plan, then allows this call once', async () => {
    mocked.post.mockResolvedValue({ ok: true });
    wrap(<BatchCard batch={outOfPlan()} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add shell.exec on git push origin fix to the plan and allow it' }),
    );
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
    expect(mocked.post.mock.calls[0]?.[0]).toBe('/auto/plans/apl_1/steps');
    expect(mocked.post.mock.calls[0]?.[1]).toMatchObject({
      action: 'shell.exec',
      resource: 'shell:git push origin fix',
    });
    expect(mocked.post.mock.calls[1]).toEqual(['/approvals/apr_1', { decision: 'approve', scope: 'once' }]);
  });
});

/* ---- Reviewer offline ------------------------------------------------------- */

const OFFLINE: ReviewerStatus = {
  status: 'offline',
  outage_id: 'rvo_1',
  reason: 'network',
  local_only: false,
  since: at,
};

describe('reviewer offline', () => {
  it('is one quiet line with the reason and a way to fix it, dismissed for this outage only', () => {
    wrap(<ReviewerOffline status={OFFLINE} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reviewer offline, asking more often.');
    expect(screen.getByRole('status')).toHaveTextContent("The reviewer can't be reached");
    expect(screen.getByText('Open health')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the reviewer notice' }));
    expect(screen.queryByRole('status')).toBeNull();
    // A new outage shows again.
    cleanup();
    wrap(<ReviewerOffline status={{ ...OFFLINE, outage_id: 'rvo_2', reason: 'no_key' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('No reviewer key is saved');
  });

  it('says nothing while online, and names a fix for every reason', () => {
    wrap(<ReviewerOffline status={{ ...OFFLINE, status: 'online', outage_id: null, reason: null }} />);
    expect(screen.queryByRole('status')).toBeNull();
    for (const reason of ['no_key', 'key_rejected', 'network', 'model_not_pulled'] as const) {
      const c = reviewerOfflineCopy({ reason, local_only: false });
      expect(c.why.length).toBeGreaterThan(0);
      expect(c.fix.label.length).toBeGreaterThan(0);
    }
    expect(reviewerOfflineCopy({ reason: 'model_not_pulled', local_only: true }).why).toMatch(
      /Only a local reviewer/,
    );
  });

  it('auto.reviewer events update the status without asking Core', () => {
    onReviewerStatus(
      {
        seq: 1,
        at,
        type: 'auto.reviewer',
        status: 'offline',
        outage_id: 'rvo_9',
        reason: 'no_key',
        local_only: false,
      },
      queryClient,
    );
    expect(queryClient.getQueryData<ReviewerStatus>(REVIEWER_KEY)).toMatchObject({
      status: 'offline',
      outage_id: 'rvo_9',
    });
  });
});

/* ---- Sent before it became private --------------------------------------------- */

describe('what had left the computer before it became private', () => {
  const rec: SharedBeforeLocal = {
    id: 'ssh_1',
    level: 'notebook',
    ref_id: 'nb_1',
    change: 'private',
    changed_at: '2026-10-12T08:00:00Z',
    turns: 14,
    first_at: '2026-10-01T09:00:00Z',
    last_at: '2026-10-09T09:00:00Z',
    destinations: [
      { destination: 'anthropic', turns: 10 },
      { destination: 'claude_code', turns: 4 },
    ],
  };

  it('names engines, answers and dates, and is honest that it cannot be recalled', () => {
    const t = sharedBeforeText(rec);
    expect(t.lede).toBe(
      'Before this notebook became private on 12 Oct 2026, 14 answers came from models off this computer: Anthropic (10), Claude Code (4), from 1 Oct 2026 to 9 Oct 2026.',
    );
    expect(t.detail).toMatch(/can't be recalled/);
    expect(`${t.lede}${t.detail}`).not.toMatch(/—/);
  });

  it('says plainly when nothing had left', () => {
    expect(
      sharedBeforeText({ ...rec, level: 'thread', change: 'local_only', turns: 0, destinations: [] }),
    ).toEqual({
      lede: 'Nothing had left this computer before this thread was set to keep everything on this computer on 12 Oct 2026.',
      detail: null,
    });
  });
});
