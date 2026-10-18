/**
 * PV3: first run keeps its short list of providers; the rest sit behind one
 * "More providers" disclosure and use the same row, with a region where a
 * key has one.
 */
import type { ProviderInfo } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('../src/state/notify', () => ({ notify: vi.fn() }));
vi.mock('../src/telemetry/ShareStats', () => ({ ShareStatsCard: () => null }));

import { ApiCallError, api, localError } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { SetupScreen } from '../src/routes/Setup';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;

const info = (p: Partial<ProviderInfo> & Pick<ProviderInfo, 'id' | 'name'>): ProviderInfo => ({
  regions: null,
  default_region: null,
  key_hint: 'starts with sk-',
  docs_url: `https://example.test/${p.id}`,
  has_models_list: true,
  credential_id: p.id as ProviderInfo['credential_id'],
  needs_key: true,
  ...p,
});

const PROVIDERS: ProviderInfo[] = [
  info({ id: 'anthropic', name: 'Anthropic' }),
  info({ id: 'openai', name: 'OpenAI' }),
  info({ id: 'google', name: 'Google' }),
  info({ id: 'openrouter', name: 'OpenRouter', key_hint: 'starts with sk-or-v1-' }),
  info({ id: 'xai', name: 'xAI (Grok)', key_hint: 'starts with xai-' }),
  info({
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    regions: [
      { id: 'global', label: 'International (platform.kimi.ai)' },
      { id: 'china', label: 'China (platform.moonshot.cn)' },
    ],
    default_region: 'global',
  }),
  info({ id: 'deepseek', name: 'DeepSeek' }),
  info({ id: 'groq', name: 'Groq', credential_id: null }),
];

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const toModels = async () => {
  wrap(<SetupScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
  await screen.findByRole('heading', { name: 'Connect your models' });
};

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
  mocked.get.mockImplementation(async (path: string) =>
    path === '/providers'
      ? { items: PROVIDERS }
      : { complete: false, preset: null, providers: [], offline_model: true },
  );
});

describe('first run providers', () => {
  it('shows the original four and keeps the rest behind one disclosure', async () => {
    await toModels();
    for (const name of ['Anthropic', 'OpenAI', 'Google', 'OpenRouter'])
      expect(screen.getByLabelText(`${name} API key`)).toBeInTheDocument();
    const more = await screen.findByRole('button', { name: 'More providers' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('DeepSeek API key')).toBeNull();

    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'More providers' });
    // A to Z, and only providers with a key row.
    const names = [...group.querySelectorAll('.provider__name')]
      .map((n) => n.textContent?.replace(' API key', ''))
      .filter((n) => ['DeepSeek', 'Moonshot (Kimi)', 'xAI (Grok)', 'Groq'].includes(n ?? ''));
    expect(names).toEqual(['DeepSeek', 'Moonshot (Kimi)', 'xAI (Grok)']);
    expect(within(group).getByText('Your key starts with xai-.')).toBeInTheDocument();
    fireEvent.click(more);
    expect(screen.queryByLabelText('DeepSeek API key')).toBeNull();
  });

  it('sends the region with a test, and nothing extra for a provider without one', async () => {
    mocked.post.mockResolvedValue({ latency_ms: 120, enabled: ['moonshot/kimi'] });
    await toModels();
    fireEvent.click(await screen.findByRole('button', { name: 'More providers' }));
    const select = screen.getByLabelText('Region') as HTMLSelectElement;
    expect(select.value).toBe('global');
    fireEvent.change(select, { target: { value: 'china' } });
    fireEvent.change(screen.getByLabelText('Moonshot (Kimi) API key'), {
      target: { value: 'sk-abcdefghij' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test Moonshot (Kimi) key' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/setup/providers/test', {
        provider: 'moonshot',
        key: 'sk-abcdefghij',
        region: 'china',
      }),
    );

    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'sk-proj-abcdefghij' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test OpenAI key' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/setup/providers/test', {
        provider: 'openai',
        key: 'sk-proj-abcdefghij',
      }),
    );
  });

  it('offers the other region after a wrong-region failure', async () => {
    mocked.post
      .mockRejectedValueOnce(
        new ApiCallError(502, {
          error: {
            ...localError(
              'provider.wrong_region',
              'Moonshot (Kimi) says this key is for another region',
              'Try China (platform.moonshot.cn).',
              't',
            ).error,
            context: {},
          },
        }),
      )
      .mockResolvedValueOnce({ latency_ms: 90, enabled: [] });
    await toModels();
    fireEvent.click(await screen.findByRole('button', { name: 'More providers' }));
    fireEvent.change(screen.getByLabelText('Moonshot (Kimi) API key'), {
      target: { value: 'sk-abcdefghij' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test Moonshot (Kimi) key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try China (platform.moonshot.cn)' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenLastCalledWith('/setup/providers/test', {
        provider: 'moonshot',
        key: 'sk-abcdefghij',
        region: 'china',
      }),
    );
  });

  it('says an account is out of credit in words, and suggests the right row for a pasted key', async () => {
    mocked.post.mockRejectedValue(
      new ApiCallError(502, {
        error: {
          ...localError('provider.no_credit', 'DeepSeek says your account is out of credit', 'Top up.', 't')
            .error,
          context: {},
        },
      }),
    );
    await toModels();
    fireEvent.click(await screen.findByRole('button', { name: 'More providers' }));
    const key = screen.getByLabelText('DeepSeek API key');
    fireEvent.change(key, { target: { value: 'sk-or-v1-abcdefghijkl' } });
    expect(screen.getByText(/This looks like an OpenRouter key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test DeepSeek key' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Test DeepSeek key' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'DeepSeek says your account is out of credit. Top up there, or use another model.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move it there' }));
    expect((screen.getByLabelText('OpenRouter API key') as HTMLInputElement).value).toBe(
      'sk-or-v1-abcdefghijkl',
    );
    expect((key as HTMLInputElement).value).toBe('');
  });
});
