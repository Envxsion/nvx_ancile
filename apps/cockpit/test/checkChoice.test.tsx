/**
 * Mission-critical fact-checks in the Cockpit (TR3): a check that could not pick two independent
 * checkers shows every ready model to choose from, and runs on the ones picked; and a model's tier is
 * said quietly, in words.
 */
import type { FactcheckNeedsChoice } from '@nvx/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/sse', () => ({ openStream: vi.fn(() => () => undefined) }));

import { CheckChoice } from '../src/drawer/EvidencePanel';
import { api } from '../src/lib/api';
import { startFactcheck, useCheckChoice } from '../src/lib/factcheck';
import { TIER_SOURCE_WORDS, TIER_WORDS, tierTitle } from '../src/models/tier';

const post = vi.mocked(api.post);

const choice: FactcheckNeedsChoice = {
  needs_choice: {
    code: 'factcheck.needs_choice',
    title: 'Choose the models to check this with',
    hint: 'This is marked critical, and two independent standard or frontier models are not both ready.',
    floor: 'balanced',
    models: [
      {
        id: 'anthropic/opus',
        name: 'Claude Opus',
        provider: 'anthropic',
        family: 'anthropic',
        tier: 'best',
        same_family_as_writer: true,
        suitable: true,
      },
      {
        id: 'openai/nano',
        name: 'GPT nano',
        provider: 'openai',
        family: 'openai',
        tier: 'tiny',
        same_family_as_writer: false,
        suitable: false,
      },
    ],
    suggested: ['anthropic/opus'],
  },
};

beforeEach(() => post.mockReset());
afterEach(() => useCheckChoice.getState().set('m_1', null));

describe('choosing the checkers', () => {
  it('keeps the choice when a critical check cannot start, and shows nothing else', async () => {
    post.mockResolvedValue(choice);
    await startFactcheck('m_1', { critical: true });
    expect(post).toHaveBeenCalledWith('/messages/m_1/factcheck', { critical: true });
    expect(useCheckChoice.getState().byMessage.m_1?.models).toHaveLength(2);
  });

  it('lists every ready model, the writer’s provider included, with the suggested one ticked', () => {
    useCheckChoice.getState().set('m_1', choice.needs_choice);
    render(<CheckChoice messageId="m_1" />);
    expect(screen.getByText('Choose the models to check this with')).toBeInTheDocument();
    expect(screen.getByText(/same provider as the writer/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Claude Opus/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /GPT nano/ })).not.toBeChecked();
  });

  it('runs the check on the models picked', async () => {
    post.mockResolvedValue({
      factcheck_id: 'fck_1',
      run_id: 'run_1',
      stream_url: '/s',
      web: { used: false, note: null },
    });
    useCheckChoice.getState().set('m_1', choice.needs_choice);
    render(<CheckChoice messageId="m_1" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /GPT nano/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Check with these' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/messages/m_1/factcheck', {
        critical: true,
        models: ['anthropic/opus', 'openai/nano'],
      }),
    );
    await waitFor(() => expect(useCheckChoice.getState().byMessage.m_1).toBeUndefined());
  });

  it('cannot check with nothing picked', () => {
    useCheckChoice.getState().set('m_1', { ...choice.needs_choice, suggested: [] });
    render(<CheckChoice messageId="m_1" />);
    expect(screen.getByRole('button', { name: 'Check with these' })).toBeDisabled();
  });
});

describe('tiers in words', () => {
  it('uses the plain words people read', () => {
    expect(TIER_WORDS).toEqual({ best: 'Frontier', balanced: 'Standard', fast: 'Small', tiny: 'Tiny' });
    expect(tierTitle('fast', 'size')).toBe(`Small tier. ${TIER_SOURCE_WORDS.size}`);
    expect(tierTitle('best', 'override')).toBe('Frontier tier. Set by you');
  });
});
