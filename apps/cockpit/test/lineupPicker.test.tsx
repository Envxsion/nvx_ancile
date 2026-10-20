/**
 * ------------------------------------------------------------------
 *  Title    |  The lineup in pickers (MD2)
 *  Ref      |  apps/cockpit/src/models/lineup.ts · docs/models.md
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  A provider ships each line's current model and the one
 *           |  before it. Pickers show the current ones, grouped by
 *           |  provider (and by company inside OpenRouter), and fold
 *           |  the previous generation under one quiet "Older" row.
 *           |  The model in use is never folded away.
 * ------------------------------------------------------------------
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelGroups } from '../src/engines/api';
import { ModelMenu } from '../src/engines/ModelMenu';
import { toModelView } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import type { ModelView } from '../src/lib/types';
import { groupedBy, groupLabel, splitOlder } from '../src/models/lineup';
import { groupModels } from '../src/routes/admin/modelBlocks';

afterEach(cleanup);

const m = (id: string, name: string, p: Partial<ModelView> = {}): ModelView => ({
  id,
  name,
  provider: 'Anthropic',
  hue: 'coral',
  via: 'direct',
  contextWindow: 1_000_000,
  status: 'ready',
  chat: true,
  billing: { kind: 'key', payer: 'anthropic' },
  price: { in: 2, out: 10 },
  ...p,
});

const SONNET_ALIAS = m('anthropic/sonnet:latest', 'Claude Sonnet', {
  aliasOf: 'anthropic/claude-sonnet-5-5',
  lineId: 'anthropic/sonnet',
});
const SONNET_NOW = m('anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5', { lineId: 'anthropic/sonnet' });
const SONNET_OLD = m('anthropic/claude-sonnet-5', 'Claude Sonnet 5', {
  lineId: 'anthropic/sonnet',
  older: true,
});
const OR = { provider: 'OpenRouter', billing: { kind: 'key', payer: 'openrouter' } } as const;
const LLAMA_ALIAS = m('openrouter/meta-llama-large:latest', 'Llama large', {
  ...OR,
  company: 'Meta',
  aliasOf: 'openrouter/meta-llama__llama-4-maverick',
  lineId: 'openrouter/meta-llama-large',
});
const LLAMA_NOW = m('openrouter/meta-llama__llama-4-maverick', 'Meta: Llama 4 Maverick', {
  ...OR,
  company: 'Meta',
  lineId: 'openrouter/meta-llama-large',
});
const LLAMA_OLD = m('openrouter/meta-llama__llama-3.3-70b-instruct', 'Meta: Llama 3.3 70B Instruct', {
  ...OR,
  company: 'Meta',
  lineId: 'openrouter/meta-llama-large',
  older: true,
});
const MISTRAL = m('openrouter/mistralai__mistral-large-2512', 'Mistral: Mistral Large 3', {
  ...OR,
  company: 'Mistral',
});
const ALL = [SONNET_ALIAS, SONNET_NOW, SONNET_OLD, LLAMA_ALIAS, LLAMA_NOW, LLAMA_OLD, MISTRAL];

const groups = (currentId: string | null = null, models = ALL) =>
  modelGroups({ models, engines: undefined, scope: undefined, session: null, currentId });

describe('the lineup helpers', () => {
  it('splitOlder folds previous generations and never the selected one', () => {
    const items = [{ id: 'a' }, { id: 'b', older: true }, { id: 'c', older: true }];
    expect(splitOlder(items).current.map((x) => x.id)).toEqual(['a']);
    expect(splitOlder(items).older.map((x) => x.id)).toEqual(['b', 'c']);
    expect(splitOlder(items, ['c']).current.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('groupLabel names the provider, and the company inside OpenRouter', () => {
    expect(groupLabel('Anthropic')).toBe('Anthropic');
    expect(groupLabel('OpenRouter', 'Meta')).toBe('OpenRouter · Meta');
  });

  it('groupedBy keeps first-seen order and puts unlabelled items together', () => {
    const out = groupedBy(['x1', 'y1', 'x2', 'z'], (s) => (s === 'z' ? null : s[0]));
    expect(out).toEqual([
      { label: 'x', items: ['x1', 'x2'] },
      { label: 'y', items: ['y1'] },
      { label: null, items: ['z'] },
    ]);
  });

  it("Core's company and older reach the view", () => {
    const view = toModelView({
      id: 'openrouter/meta-llama__llama-3.3-70b-instruct',
      display_name: 'Meta: Llama 3.3 70B Instruct',
      provider: 'openrouter',
      family: 'meta-llama',
      via: 'direct',
      context_window: 131072,
      max_output: 16384,
      capabilities: ['tools'],
      price: { input_per_mtok: 0.1, output_per_mtok: 0.32 },
      status: 'ready',
      billing: { kind: 'key', payer: 'openrouter' },
      secret: 'OPENROUTER_API_KEY',
      offline: false,
      company: 'Meta',
      older: true,
    } as never);
    expect(view).toMatchObject({ company: 'Meta', older: true });
  });
});

describe('the composer menu', () => {
  it('marks previous generations older and gives each cloud model its group', () => {
    const e = groups().flatMap((g) => g.items);
    const by = (id: string) => e.find((x) => x.id === id);
    expect(by('anthropic/claude-sonnet-5')).toMatchObject({ older: true, group: 'Anthropic' });
    expect(by('openrouter/meta-llama__llama-3.3-70b-instruct')).toMatchObject({
      older: true,
      group: 'OpenRouter · Meta',
    });
    expect(by('openrouter/mistralai__mistral-large-2512')?.group).toBe('OpenRouter · Mistral');
    // The line shows once; the model it answers with now is not listed beside it.
    expect(by('anthropic/sonnet:latest')?.tag).toBe('Latest');
    expect(by('anthropic/claude-sonnet-5-5')).toBeUndefined();
  });

  it('shows current models under their company, and the previous generation behind one Older row', async () => {
    const onPick = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <ModelMenu open groups={groups()} onPick={onPick} trigger={<button type="button">Model</button>} />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Anthropic')).toBeInTheDocument();
    expect(within(menu).getByText('OpenRouter · Meta')).toBeInTheDocument();
    expect(within(menu).getByText('OpenRouter · Mistral')).toBeInTheDocument();
    expect(within(menu).getByText('Claude Sonnet')).toBeInTheDocument();
    expect(within(menu).getByText('Llama large')).toBeInTheDocument();
    // The previous generations are not in the list; one row stands for both.
    expect(within(menu).queryByText('Claude Sonnet 5')).toBeNull();
    expect(within(menu).queryByText('Meta: Llama 3.3 70B Instruct')).toBeNull();
    const older = within(menu).getByText('Older').closest('[role="menuitem"]') as HTMLElement;
    expect(older).toHaveTextContent('Older (2)');
    fireEvent.keyDown(older, { key: 'ArrowRight' });
    const sub = (await screen.findAllByRole('menu')).at(-1) as HTMLElement;
    expect(within(sub).getByText('Claude Sonnet 5')).toBeInTheDocument();
    expect(within(sub).getByText('Meta: Llama 3.3 70B Instruct')).toBeInTheDocument();
  });

  it('keeps the model in use in the main list even when it is a previous generation', () => {
    const e = groups('anthropic/claude-sonnet-5').flatMap((g) => g.items);
    const { current, older } = splitOlder(e, ['anthropic/claude-sonnet-5']);
    expect(current.map((x) => x.id)).toContain('anthropic/claude-sonnet-5');
    expect(older.map((x) => x.id)).toEqual(['openrouter/meta-llama__llama-3.3-70b-instruct']);
  });
});

describe('Admin → Models', () => {
  it('keeps every model of a key in its block, with company and older available to fold', () => {
    const { keys } = groupModels(ALL);
    const or = keys.find((k) => k.payer === 'openrouter');
    expect(or?.models.map((x) => x.company)).toEqual(['Meta', 'Meta', 'Meta', 'Mistral']);
    expect(splitOlder(or?.models ?? []).older.map((x) => x.id)).toEqual([
      'openrouter/meta-llama__llama-3.3-70b-instruct',
    ]);
  });
});
