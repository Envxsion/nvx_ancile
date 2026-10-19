/**
 * FL1: when a router that learns from your choices acted, or a shadow flow
 * answered, it says so: in the receipt's "why this model" line, in a chip on
 * the router's step in the Teamwork fold, and with a Shadow answer link.
 */
import type { FlowProvenance, RunEvent, ShadowOutcome } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ShadowAnswerLink } from '../src/flows/ShadowAnswer';
import { ApiCallError, api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { learnedWords, whyThisModel } from '../src/receipt/figures';
import { foldTeam, type TeamState, teamFromProvenance } from '../src/thread/teamworkState';

const mocked = vi.mocked(api);

const base = { name: 'Qwen3', attempts: [], claudeCodeSession: false, flowName: 'Support triage' };

describe("the receipt's why-this-model line", () => {
  it('says the learned router chose, and how sure it was', () => {
    expect(whyThisModel({ ...base, learned: { label: 'billing', confidence: 0.82, taken: true } })).toBe(
      'The Support triage flow routed it. The learned router chose billing (82% sure).',
    );
  });

  it('says a suggest-only router only suggested, so nobody thinks it decided', () => {
    expect(
      whyThisModel({ ...base, learned: { label: 'billing', confidence: 0.61, taken: false } }),
    ).toContain('would have chosen billing (61% sure), but it only suggests for now');
  });

  it('says nothing about it when no learned router took part', () => {
    expect(whyThisModel(base)).toBe('The Support triage flow routed it.');
    expect(learnedWords(null)).toBe('');
  });

  it('says which effort auto effort or the notebook chose (EN1), and stays quiet for your own choice', () => {
    const plain = { name: 'Qwen3', attempts: [], claudeCodeSession: false };
    expect(
      whyThisModel({ ...plain, effort: { level: 'high', from: 'auto', reason: 'a multi-step proof.' } }),
    ).toContain('Effort high, chosen by auto effort (a multi-step proof).');
    expect(whyThisModel({ ...plain, effort: { level: 'low', from: 'notebook' } })).toContain(
      "Effort low, this notebook's default.",
    );
    expect(whyThisModel({ ...plain, effort: { level: 'low', from: 'thread' } })).not.toContain('Effort');
  });
});

describe('the Teamwork fold keeps what the learned router did', () => {
  const learned = { label: 'billing', confidence: 0.82, taken: true };

  it('live, from the decision event', () => {
    const e = {
      type: 'flow.decision',
      seq: 1,
      at: '2026-10-19T00:00:00Z',
      message_id: 'm1',
      node_id: 'router',
      chose: ['billing'],
      reason: 'Learned from your choices.',
      confidence: 0.82,
      learned,
    } as unknown as RunEvent;
    const t = foldTeam(undefined as TeamState | undefined, e as never);
    expect(t?.decisions.router?.learned).toEqual(learned);
  });

  it('after a reload, from the saved record', () => {
    const p = {
      flow_id: 'f',
      name: 'Support triage',
      version: 1,
      scope: 'workspace',
      path: ['router'],
      decisions: [{ node_id: 'router', chose: ['billing'], reason: 'r', confidence: 0.82, learned }],
      steps: [],
      cost_usd: 0,
    } as unknown as FlowProvenance;
    expect(teamFromProvenance(p).decisions.router?.learned).toEqual(learned);
  });
});

describe('Shadow answer link', () => {
  const wrap = (ui: ReactNode) =>
    render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>{ui}</Tooltip.Provider>
      </QueryClientProvider>,
    );
  const licence = (unlocked: boolean) => ({ features: [{ id: 'flow_lab', unlocked }] });
  const shadow = (over: Partial<ShadowOutcome> = {}): ShadowOutcome => ({
    status: 'answered',
    result_id: 'r1',
    flow_id: 'f2',
    flow_name: 'Cheaper triage',
    answer: 'The shadow flow wrote this.',
    error: null,
    at: '2026-10-19T00:00:00Z',
    ...over,
  });
  const route = (lic: boolean, s: unknown) =>
    mocked.get.mockImplementation(async (path: string) => {
      if (path === '/license/details') return licence(lic);
      if (path === '/pro/messages/m1/shadow') {
        if (s instanceof Error) throw s;
        return s;
      }
      return {};
    });

  beforeEach(() => {
    queryClient.clear();
    mocked.get.mockReset();
  });

  it('opens what the shadow flow wrote, apart from the live answer', async () => {
    route(true, shadow());
    wrap(<ShadowAnswerLink messageId="m1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Shadow answer' }));
    expect(await screen.findByText('The shadow flow wrote this.')).toBeInTheDocument();
    expect(screen.getByText(/answered the same question off the record/)).toBeInTheDocument();
  });

  it('says a failed shadow failed, and that the live answer is not affected', async () => {
    route(true, shadow({ status: 'failed', answer: null, error: 'The model timed out.' }));
    wrap(<ShadowAnswerLink messageId="m1" />);
    expect(await screen.findByText(/Shadow flow failed\. This answer is not affected/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shadow answer' })).toBeNull();
  });

  it('shows nothing when none ran (404), and never asks in the free build', async () => {
    route(
      true,
      new ApiCallError(404, { error: { code: 'request.not_found', title: 'x', hint: 'y' } } as never),
    );
    const a = wrap(<ShadowAnswerLink messageId="m1" />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalledWith('/pro/messages/m1/shadow'));
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    queryClient.clear();
    mocked.get.mockClear();
    route(false, shadow());
    const b = wrap(<ShadowAnswerLink messageId="m1" />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalledWith('/license/details'));
    expect(mocked.get).not.toHaveBeenCalledWith('/pro/messages/m1/shadow');
    expect(b.container).toBeEmptyDOMElement();
  });
});
