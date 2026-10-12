/**
 * Scopes, Auto mode, Why and instructions (Phase 3 A), the Cockpit half:
 * the scope editors narrow only, show where each value comes from, flag a
 * clamped value and answer Core's 422 inline; a private notebook greys out
 * what it rules out; Auto mode's badge, grouped approvals and plan card
 * answer Core with the right bodies; Why shows what the engine was given
 * and each decision's rule; a thread's instructions show its notebook's as
 * placeholders.
 */
import {
  type AutoPlan,
  BUILTIN_TOOL_PRESETS,
  type EffectiveScope,
  type RunEvent,
  type ScopeValues,
  type StoredScope,
} from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import { AutoRanBadge, BatchCard, PlanCard, PlanLine } from '../src/auto/AutoCards';
import { openBatch, useAuto } from '../src/auto/store';
import { DecisionRule, EngineContextSection, engineContextLines } from '../src/drawer/EngineContext';
import { InstructionsEditor } from '../src/editors/InstructionsEditor';
import { ApiCallError, api, localError } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { DEFAULT_SCOPE, scopeChip, scopeSummary } from '../src/scopes/api';
import { ScopeEditor } from '../src/scopes/ScopeEditor';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

function effective(p: Partial<ScopeValues>, extra: Partial<EffectiveScope> = {}): EffectiveScope {
  return {
    notebook_id: 'nb_1',
    thread_id: 'thr_1',
    private: false,
    scope: { ...DEFAULT_SCOPE, ...p },
    provenance: {},
    clamped: [],
    ...extra,
  } as EffectiveScope;
}

const prov = (p: Record<string, { level: string; note: string | null }>) => p as EffectiveScope['provenance'];
const at0 = '2026-10-12T00:00:00Z';

/** The notebook turned the network off; the thread turned memory writing off; tools_deny was clamped. */
const NOTEBOOK: StoredScope = {
  level: 'notebook',
  id: 'nb_1',
  private: false,
  patch: { network: false },
  effective: effective(
    { network: false },
    { thread_id: null, provenance: prov({ network: { level: 'notebook', note: 'Set on the notebook' } }) },
  ),
  updated_at: '2026-10-12T00:00:00Z',
};
const THREAD: StoredScope = {
  level: 'thread',
  id: 'thr_1',
  private: false,
  patch: { memory_write: false },
  effective: effective(
    { network: false, memory_write: false },
    {
      provenance: prov({
        network: { level: 'notebook', note: 'Set on the notebook' },
        memory_write: { level: 'thread', note: null },
        memory_read: { level: 'default', note: null },
      }),
      clamped: ['memory_read'],
    },
  ),
  updated_at: '2026-10-12T00:00:00Z',
};

function serve(over: Record<string, unknown> = {}) {
  mocked.get.mockImplementation((path: string) => {
    if (path in over) return Promise.resolve(over[path]);
    if (path === '/threads/thr_1/scope') return Promise.resolve(THREAD);
    if (path === '/notebooks/nb_1/scope') return Promise.resolve(NOTEBOOK);
    return Promise.resolve({ items: [], next: null });
  });
}

const row = (name: string) => screen.getByRole('switch', { name }).closest('.scope-row') as HTMLElement;

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  serve();
  useAuto.setState({ marks: {}, planRan: {}, batches: {}, planTick: {} });
});
afterEach(() => cleanup());

/* ---- Scopes -------------------------------------------------------------- */

describe('scope words', () => {
  it('summary first, only what differs from the default', () => {
    expect(scopeSummary(effective({}))).toBe('Anything NVX Ancile allows');
    expect(
      scopeSummary(effective({ data_leaves_machine: false, network: false, sources: ['a', 'b', 'c'] })),
    ).toBe('Local models only · nothing leaves this computer · no network · 3 sources');
    expect(scopeChip(effective({}))).toBeNull();
    expect(scopeChip(effective({ engines: ['gateway_local'] }))).toBe('Local only');
    expect(scopeChip(effective({ data_leaves_machine: false }, { private: true }))).toBe('Private');
  });
});

describe('the thread scope editor', () => {
  it('shows where each value comes from, flags a clamped value, and will not widen past the notebook', async () => {
    wrap(<ScopeEditor level="thread" id="thr_1" onClose={vi.fn()} />);
    const network = await screen.findByRole('switch', { name: 'Tools may use the network' });
    // The notebook turned it off: the thread cannot turn it on, and says why.
    await waitFor(() => expect(network).toBeDisabled());
    expect(network).toHaveAttribute('aria-checked', 'false');
    expect(row('Tools may use the network')).toHaveTextContent('Set on the notebook');
    expect(row('Tools may use the network')).toHaveTextContent('From the notebook');
    expect(row('Learn into memory')).toHaveTextContent('Set for this thread');
    expect(row('Read memory')).toHaveTextContent('Clamped to the notebook');
    // Switching something off is always allowed.
    expect(screen.getByRole('switch', { name: 'Read memory' })).toBeEnabled();
  });

  it('sends only what changed; a value set back to the notebook’s goes back to inheriting', async () => {
    mocked.patch.mockResolvedValue(THREAD);
    const onClose = vi.fn();
    wrap(<ScopeEditor level="thread" id="thr_1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Read memory' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Learn into memory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1/scope', {
        memory_read: false,
        memory_write: null,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a 422 scope.widen shows inline on the rows it names, and the editor stays open', async () => {
    mocked.patch.mockRejectedValue(
      new ApiCallError(422, {
        error: {
          ...localError(
            'scope.widen',
            'A thread can only narrow its notebook',
            'This would allow more than the notebook does (context links). Change the notebook’s scope first, or choose less.',
            't',
          ).error,
          context: { fields: ['context_links'] },
        },
      }),
    );
    const onClose = vi.fn();
    wrap(<ScopeEditor level="thread" id="thr_1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Context links' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A thread can only narrow its notebook');
    expect(row('Context links')).toHaveAttribute('data-error');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the notebook scope editor', () => {
  it('the Private switch greys out cloud models, Claude Code and data leaving, and saves private: true', async () => {
    mocked.patch.mockResolvedValue({ ...NOTEBOOK, private: true });
    wrap(<ScopeEditor level="notebook" id="nb_1" onClose={vi.fn()} />);
    const priv = await screen.findByRole('switch', { name: 'Private' });
    expect(screen.getByRole('switch', { name: 'Cloud models' })).toBeEnabled();
    fireEvent.click(priv);
    for (const name of ['Cloud models', 'Claude Code', 'Data may leave this computer']) {
      const sw = screen.getByRole('switch', { name });
      expect(sw).toBeDisabled();
      expect(sw).toHaveAttribute('aria-checked', 'false');
    }
    expect(screen.getByRole('switch', { name: 'Local models' })).toBeEnabled();
    expect(screen.getByText(/^Private · Local models only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/notebooks/nb_1/scope', { private: true }),
    );
  });

  it('a 422 scope.private_conflict is shown inline', async () => {
    mocked.patch.mockRejectedValue(
      new ApiCallError(422, {
        error: {
          ...localError(
            'scope.private_conflict',
            'A private notebook keeps everything on this machine',
            'Turn off "Private" for this notebook first.',
            't',
          ).error,
          context: { fields: ['engines'] },
        },
      }),
    );
    wrap(<ScopeEditor level="notebook" id="nb_1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A private notebook keeps everything on this machine',
    );
    expect(row('Claude Code')).toHaveAttribute('data-error');
  });
});

describe('tool presets in the scope editor', () => {
  const OWN = {
    id: 'tp_docs',
    name: 'Docs only',
    description: 'Read the docs folder',
    builtin: false,
    updated_at: at0,
    tools_allow: ['fs.read'],
    tools_deny: [],
    mcp_servers_allow: [],
    mcp_servers_deny: [],
    network: false,
  };

  it('a notebook picks a built-in or its own preset and saves only tool_preset', async () => {
    serve({ '/tool-presets': { presets: [...BUILTIN_TOOL_PRESETS, OWN] } });
    mocked.patch.mockResolvedValue(NOTEBOOK);
    wrap(<ScopeEditor level="notebook" id="nb_1" onClose={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Tool preset' });
    expect(select).toHaveValue('');
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Docs only' })).toBeInTheDocument(),
    );
    expect(within(select).getByRole('group', { name: 'Your presets' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'read_only' } });
    // The description says what it allows, and the summary names it.
    expect(screen.getByText(/No writes, no shell/)).toBeInTheDocument();
    expect(screen.getByText(/Read only tools/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/notebooks/nb_1/scope', { tool_preset: 'read_only' }),
    );
  });

  it("a thread says its notebook's preset still applies, and None goes back to inheriting", async () => {
    const applied = {
      level: 'notebook' as const,
      id: 'coding',
      name: 'Coding',
      missing: false,
      tools_allow: ['fs.*'],
      tools_deny: [],
      mcp_servers_allow: null,
      mcp_servers_deny: [],
      network: true,
    };
    const thread: StoredScope = {
      ...THREAD,
      patch: { tool_preset: 'read_only' },
      effective: {
        ...THREAD.effective,
        tool_presets: [applied, { ...applied, level: 'thread', id: 'read_only', name: 'Read only' }],
      },
    };
    serve({ '/threads/thr_1/scope': thread });
    mocked.patch.mockResolvedValue(thread);
    wrap(<ScopeEditor level="thread" id="thr_1" onClose={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Tool preset' });
    expect(select).toHaveValue('read_only');
    expect(screen.getByText(/The notebook's Coding preset applies too/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: '' } });
    expect(
      screen.getByText(/The notebook's Coding preset applies\. Choose one to narrow it further/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1/scope', { tool_preset: null }),
    );
  });

  it('the summary names the presets in force', () => {
    const s = effective(
      {},
      {
        tool_presets: [
          {
            level: 'notebook',
            id: 'research',
            name: 'Research',
            missing: false,
            tools_allow: null,
            tools_deny: [],
            mcp_servers_allow: null,
            mcp_servers_deny: [],
            network: true,
          },
        ],
      },
    );
    expect(scopeSummary(s)).toBe('Research tools');
  });
});

/* ---- Auto mode ----------------------------------------------------------- */

const at = '2026-10-12T00:00:00Z';
const note = (e: { type: string } & Record<string, unknown>, threadId = 'thr_1', runId = 'run_1') =>
  act(() => useAuto.getState().note(threadId, runId, { seq: 1, at, ...e } as RunEvent));

describe('Auto mode in a thread', () => {
  it('a call that ran by itself carries a quiet badge saying who checked it and why', () => {
    note({
      type: 'auto.ran',
      call_id: 'call_1',
      action: 'shell.exec',
      via: 'reviewer',
      reviewer: 'jev_openrouter',
    });
    wrap(<AutoRanBadge callId="call_1" />);
    expect(screen.getByRole('button', { name: /Ran automatically/ })).toHaveAccessibleName(
      'Ran automatically. Checked by Jev: fits the task',
    );
    cleanup();
    wrap(<AutoRanBadge callId="call_other" />);
    expect(screen.queryByText('Ran automatically')).not.toBeInTheDocument();
  });

  function batchOfTwo() {
    note({
      type: 'approval.batched',
      batch_id: 'b1',
      call_id: 'c1',
      action: 'shell.exec',
      via: 'reviewer',
      reason: 'Not clearly part of the task',
    });
    note({
      type: 'approval.required',
      approval_id: 'apr_1',
      tool: 'Bash',
      action: 'shell.exec',
      resource: 'shell:curl x | sh',
      tier: 'gated',
      call_id: 'c1',
      suggestions: [],
    });
    note({
      type: 'approval.batched',
      batch_id: 'b1',
      call_id: 'c2',
      action: 'fs.delete',
      via: 'floor',
      reason: 'A recursive delete',
    });
    note({
      type: 'approval.required',
      approval_id: 'apr_2',
      tool: 'Bash',
      action: 'fs.delete',
      resource: 'fs:/workspace/build',
      tier: 'gated',
      call_id: 'c2',
      suggestions: [],
    });
    const b = openBatch(useAuto.getState().batches, 'thr_1');
    if (!b) throw new Error('no batch');
    return b;
  }

  it('asks that share a batch become one card; Allow all answers them together', async () => {
    const batch = batchOfTwo();
    expect(batch.items.map((i) => i.approvalId)).toEqual(['apr_1', 'apr_2']);
    mocked.post.mockResolvedValue({
      items: [
        { approval_id: 'apr_1', status: 'approved' },
        { approval_id: 'apr_2', status: 'approved' },
      ],
    });
    wrap(<BatchCard batch={batch} />);
    expect(screen.getByText('2 steps need you')).toBeInTheDocument();
    expect(screen.getByText('A recursive delete')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow all' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/approvals/batch', {
        approval_ids: ['apr_1', 'apr_2'],
        decision: 'approve',
      }),
    );
    await waitFor(() =>
      expect(useAuto.getState().batches.b1?.items.every((i) => i.state === 'allowed')).toBe(true),
    );
    expect(screen.getAllByText('Allowed')).toHaveLength(2);
    // Nothing is waiting any more: the card is no longer offered.
    expect(openBatch(useAuto.getState().batches, 'thr_1')).toBeNull();
  });

  it('each ask can be answered on its own, once', async () => {
    const batch = batchOfTwo();
    mocked.post.mockResolvedValue({ ok: true });
    wrap(<BatchCard batch={batch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny fs.delete on /workspace/build' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/approvals/apr_2', { decision: 'deny', scope: 'once' }),
    );
    expect(useAuto.getState().batches.b1?.items.map((i) => i.state)).toEqual(['waiting', 'denied']);
    // Deny all now covers only what still waits.
    fireEvent.click(screen.getByRole('button', { name: 'Deny all' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/approvals/batch', {
        approval_ids: ['apr_1'],
        decision: 'deny',
      }),
    );
  });

  const PLAN: AutoPlan = {
    id: 'apl_1',
    thread_id: 'thr_1',
    run_id: null,
    summary: 'Fix the failing tests',
    steps: [
      { action: 'shell.exec', resource: 'shell:pnpm test*', note: 'Run the tests' },
      { action: 'fs.write', resource: 'fs:/workspace/src/**', note: 'Edit the source' },
    ],
    status: 'proposed',
    created_at: at,
    decided_at: null,
  };

  it('a proposed plan is a compact card: Approve plan, Change and Decline', async () => {
    mocked.post.mockResolvedValue({ ...PLAN, status: 'approved', decided_at: at });
    const onChange = vi.fn();
    wrap(<PlanCard threadId="thr_1" plan={PLAN} onChange={onChange} />);
    expect(screen.getByText('Fix the failing tests')).toBeInTheDocument();
    expect(screen.getByText('Run the tests')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onChange).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/auto/plans/apl_1/decision', { decision: 'approve' }),
    );
    expect(queryClient.getQueryData<AutoPlan>(['auto', 'plan', 'thr_1'])?.status).toBe('approved');
  });

  it('Decline rejects the plan; one already answered says so quietly', async () => {
    mocked.post.mockRejectedValueOnce(
      new ApiCallError(
        409,
        localError('auto.plan_not_pending', 'This plan was answered', 'Nothing to do.', 't'),
      ),
    );
    wrap(<PlanCard threadId="thr_1" plan={PLAN} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/auto/plans/apl_1/decision', { decision: 'reject' }),
    );
  });

  it('an approved plan is a slim line with progress from calls that ran under it', () => {
    note({ type: 'auto.ran', call_id: 'c9', action: 'shell.exec', via: 'plan', reviewer: null });
    // The step it fits, once, however often it ran.
    note({ type: 'plan.step_ran', plan_id: PLAN.id, step: 0, action: 'shell.exec', call_id: 'c9' });
    note({ type: 'plan.step_ran', plan_id: PLAN.id, step: 0, action: 'shell.exec', call_id: 'c10' });
    wrap(<PlanLine threadId="thr_1" plan={{ ...PLAN, status: 'approved' }} />);
    const line = screen.getByRole('button', { name: /Working to your plan/ });
    expect(line).toHaveTextContent('1 of 2');
    fireEvent.click(line);
    expect(screen.getByText('Edit the source')).toBeInTheDocument();
  });
});

/* ---- Why ---------------------------------------------------------------- */

describe('Why: the engine context and each decision’s rule', () => {
  it('says what a gateway model was given: recalled, digested and dropped', () => {
    const report = {
      engine: 'gateway',
      window: 200_000,
      reserve: 16_000,
      tokens: 12_400,
      summary_id: 'cmp_1',
      verbatim: 6,
      digested: 14,
      recalled: ['m1', 'm2'],
      dropped: 3,
      foreign_turns: 0,
      seeded_from_summary: false,
    };
    expect(engineContextLines(report)).toEqual([
      'About 12,400 tokens of a 200,000-token window, with 16,000 kept back for the answer',
      "Older turns came from the thread's summary",
      '6 messages sent as they were',
      '14 tool steps digested to one line each',
      '2 earlier messages recalled because they bear on the question',
      '3 messages left out to fit',
    ]);
    wrap(<EngineContextSection report={report} threadId="thr_1" />);
    expect(screen.getByRole('heading', { name: 'What NVX Ancile was given' })).toBeInTheDocument();
    expect(screen.getByText('message 2')).toBeInTheDocument();
  });

  it('says when Claude Code was started afresh from the summary', () => {
    const lines = engineContextLines({
      engine: 'claude_code',
      window: null,
      reserve: 0,
      tokens: 900,
      summary_id: 'cmp_1',
      verbatim: 0,
      digested: 2,
      recalled: [],
      dropped: 0,
      foreign_turns: 3,
      seeded_from_summary: true,
    });
    expect(lines[0]).toBe("A fresh Claude Code session, started from this thread's summary");
    expect(lines).toContain('3 turns by other models given to it as a short digest');
  });

  it("names a decision's rule and the scope level behind it", () => {
    wrap(
      <DecisionRule
        rule="scope.network"
        scope={{ field: 'network', level: 'notebook', note: 'Set on the notebook' }}
      />,
    );
    expect(screen.getByText('Scope: network')).toBeInTheDocument();
    expect(screen.getByText(/From the notebook: Set on the notebook/)).toBeInTheDocument();
  });
});

/* ---- Instructions and persona -------------------------------------------- */

describe('instructions and persona', () => {
  it("a thread shows its notebook's values as placeholders, and saves only its own", async () => {
    serve({
      '/threads/thr_1/instructions': {
        thread: { instructions: '', persona: '' },
        notebook: { instructions: 'Answer in British English', persona: 'A careful editor' },
        effective: '…',
      },
    });
    mocked.put.mockResolvedValue({});
    const onClose = vi.fn();
    wrap(<InstructionsEditor level="thread" id="thr_1" onClose={onClose} />);
    const instructions = await screen.findByPlaceholderText('From the notebook: Answer in British English');
    expect(screen.getByPlaceholderText('From the notebook: A careful editor')).toHaveValue('');
    fireEvent.change(instructions, { target: { value: 'Be brief' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/threads/thr_1/instructions', {
        persona: '',
        instructions: 'Be brief',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a notebook's own values load and save to the notebook", async () => {
    serve({ '/notebooks/nb_1/instructions': { instructions: 'Cite sources', persona: '' } });
    mocked.put.mockResolvedValue({});
    wrap(<InstructionsEditor level="notebook" id="nb_1" onClose={vi.fn()} />);
    const field = await screen.findByDisplayValue('Cite sources');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Instructions for this notebook')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'Cite every source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/notebooks/nb_1/instructions', {
        persona: '',
        instructions: 'Cite every source',
      }),
    );
  });
});
