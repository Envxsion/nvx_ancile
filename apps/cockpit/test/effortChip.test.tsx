/**
 * EN1: the effort chip beside the model chip appears for a model that takes
 * a reasoning effort and for no other, in a model thread and not in a Claude
 * Code thread (which has its own), saves the choice on the thread, and /effort
 * takes the same words as Claude Code's /effort.
 */
import type { ModelInfo } from '@nvx/contracts';
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
  return {
    ...real,
    api: {
      get: vi.fn().mockResolvedValue([]),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      del: vi.fn().mockResolvedValue({}),
    },
  };
});

import { EFFORTS } from '../src/claudecode/store';
import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { toModelView } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import type { ModelView, ThreadView } from '../src/lib/types';
import { useUi } from '../src/state/ui';
import { Composer } from '../src/thread/Composer';

const mocked = api as unknown as Record<'get' | 'patch', ReturnType<typeof vi.fn>>;

const model = (p: Partial<ModelView> = {}): ModelView => ({
  id: 'anthropic/sonnet',
  name: 'Sonnet',
  provider: 'Anthropic',
  hue: 'coral',
  via: 'direct',
  contextWindow: 200_000,
  status: 'ready',
  ...p,
});

function seed(models: ModelView[], effort: ThreadView['effort'] = null) {
  queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
    id: 'thr_1',
    title: 'Pumps',
    notebookId: null,
    model: models[0]?.id ?? null,
    messages: [],
    activeRun: null,
    claudeCode: null,
    effort,
    headId: null,
    total: 0,
    cursor: null,
    hasMore: false,
  } as ThreadView);
  queryClient.setQueryData(keys.models, models);
}

function composer(threadId = 'thr_1', claudeCode?: boolean) {
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <Composer
          threadId={threadId}
          parentId={null}
          onSend={vi.fn()}
          claudeCode={
            claudeCode
              ? { commands: [], act: vi.fn(), bar: <span />, working: false, onStop: vi.fn() }
              : undefined
          }
        />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

const chip = () => screen.queryByRole('button', { name: /^Thinking effort/ });

beforeEach(() => {
  queryClient.clear();
  useUi.setState({ demo: false });
  mocked.patch.mockClear();
  mocked.get.mockResolvedValue([]);
});

describe('the effort chip', () => {
  it('shows for a model that takes an effort, saying what is set', async () => {
    seed([model({ effortLevels: ['low', 'medium', 'high'] })], 'medium');
    composer();
    const c = await screen.findByRole('button', { name: 'Thinking effort: medium. Change' });
    expect(c).toHaveTextContent(/Effort: Medium/);
  });

  it('says the model default when none is chosen', async () => {
    seed([model({ effortLevels: ['low', 'medium', 'high'] })]);
    composer();
    expect(
      await screen.findByRole('button', { name: 'Thinking effort: model default. Change' }),
    ).toBeInTheDocument();
  });

  it('is not there for a model that ignores effort', async () => {
    seed([model()]);
    composer();
    await screen.findByRole('button', { name: /Change model/ });
    expect(chip()).toBeNull();
  });

  it('is not there in a Claude Code thread, which has its own effort picker, nor before a thread exists', async () => {
    seed([model({ effortLevels: ['low', 'medium', 'high'] })]);
    composer('thr_1', true);
    expect(chip()).toBeNull();
    composer('new');
    await new Promise((r) => setTimeout(r, 50));
    expect(chip()).toBeNull();
  });

  it('offers the model’s levels and saves the one chosen on the thread', async () => {
    seed([model({ effortLevels: ['low', 'high'] })]);
    composer();
    const c = await screen.findByRole('button', { name: /^Thinking effort/ });
    fireEvent.keyDown(c, { key: 'Enter' });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Model default', 'Low', 'High']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { effort: 'high' }));
    await waitFor(() => expect(chip()).toHaveTextContent('Effort: High'));
  });
});

describe('what Core lists', () => {
  const info = (extra: Partial<ModelInfo> = {}): ModelInfo =>
    ({
      id: 'anthropic/sonnet',
      display_name: 'Sonnet',
      provider: 'anthropic',
      family: 'claude',
      via: 'direct',
      context_window: 200_000,
      max_output: 8_000,
      capabilities: ['tools', 'reasoning'],
      price: { input_per_mtok: 3, output_per_mtok: 15 },
      status: 'ready',
      billing: { kind: 'api_key' },
      secret: null,
      offline: false,
      ...extra,
    }) as ModelInfo;

  it('reaches the model view, and is absent when Core lists none', () => {
    expect(toModelView(info({ effort_levels: ['low', 'medium', 'high'] })).effortLevels).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(toModelView(info()).effortLevels).toBeUndefined();
  });
});

describe('parity with Claude Code’s /effort', () => {
  it('takes the same words for the levels both have, and auto for the model’s own default', () => {
    for (const level of ['low', 'medium', 'high']) expect(EFFORTS).toContain(level);
    expect(EFFORTS).toContain('auto');
  });
});
