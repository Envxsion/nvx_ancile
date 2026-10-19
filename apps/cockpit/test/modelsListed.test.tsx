/**
 * Settings → Models lists only what is real: a model Core says is not
 * listed (no key, not pulled, no node) stays out, and the lede says how to
 * bring a provider's models in.
 */
import type { ModelInfo } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { LiveModels } from '../src/routes/admin/live';

const mocked = vi.mocked(api);

const info = (p: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'display_name'>): ModelInfo => ({
  provider: 'anthropic',
  family: 'claude',
  via: 'direct',
  context_window: 200_000,
  max_output: 8_192,
  capabilities: ['tools'],
  price: { input_per_mtok: 1, output_per_mtok: 5 },
  status: 'ready',
  billing: { kind: 'key', payer: 'anthropic' },
  secret: null,
  offline: false,
  ...p,
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
});

describe('Settings → Models', () => {
  it('leaves out models with nothing real behind them', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/models'
        ? {
            items: [
              info({ id: 'claude-code/opus', display_name: 'Opus (Claude Code)', provider: 'claude-code' }),
              info({
                id: 'anthropic/claude-sonnet-5-5',
                display_name: 'Claude Sonnet 5.5',
                status: 'needs_key',
                listed: false,
              }),
              info({
                id: 'ollama/qwen3-14b',
                display_name: 'Qwen3 14B (Ollama)',
                provider: 'ollama',
                status: 'not_pulled',
                listed: false,
              }),
            ],
          }
        : {},
    );
    wrap(<LiveModels />);
    expect(await screen.findByText('Opus (Claude Code)')).toBeInTheDocument();
    expect(screen.queryByText('Claude Sonnet 5.5')).toBeNull();
    expect(screen.queryByText('Qwen3 14B (Ollama)')).toBeNull();
    expect(screen.getByText(/Add a key in Settings → API keys/)).toBeInTheDocument();
  });

  it('MD2: offers models beyond the starter three under "Add more models"', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/models'
        ? {
            items: [
              info({ id: 'anthropic/claude-opus-5-5', display_name: 'Claude Opus 5.5', listed: true }),
              info({
                id: 'anthropic/claude-sonnet-4-5',
                display_name: 'Claude Sonnet 4.5',
                listed: false,
                unlisted_reason: 'more',
              }),
            ],
          }
        : null,
    );
    mocked.post.mockResolvedValue({});
    wrap(<LiveModels />);
    expect(await screen.findByText('Claude Opus 5.5')).toBeInTheDocument();
    expect(screen.queryByText('Claude Sonnet 4.5')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add more models/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show Claude Sonnet 4.5' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/models/shown', {
        id: 'anthropic/claude-sonnet-4-5',
        shown: true,
      }),
    );
  });
});
