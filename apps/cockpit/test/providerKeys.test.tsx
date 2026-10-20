/**
 * PV1, PV3, GW1: Settings → API keys lists the providers Core names, asks for
 * a region where a key has one, says what went wrong in plain words, and
 * notices a key pasted into the wrong row without ever blocking the save.
 */
import type { CredentialStatus, ProviderInfo } from '@nvx/contracts';
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

import { ApiKeysGroup } from '../src/credentials/ApiKeys';
import { friendlyProblem, notOfferedLine, recogniseKey } from '../src/credentials/providers';
import { ApiCallError, api, localError } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'put' | 'post', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

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
  info({ id: 'anthropic', name: 'Anthropic', key_hint: 'starts with sk-ant-' }),
  info({ id: 'openrouter', name: 'OpenRouter', key_hint: 'starts with sk-or-v1-' }),
  // Core lists them in its own order; the screen puts them A to Z.
  info({
    id: 'zai',
    name: 'Z.ai (GLM)',
    key_hint: 'two parts joined by a dot',
    regions: [
      { id: 'international', label: 'International (z.ai)' },
      { id: 'china', label: 'China (bigmodel.cn)' },
    ],
    default_region: 'international',
  }),
  info({ id: 'deepseek', name: 'DeepSeek' }),
  info({
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    regions: [
      { id: 'global', label: 'International (platform.kimi.ai)' },
      { id: 'china', label: 'China (platform.moonshot.cn)' },
    ],
    default_region: 'global',
  }),
  info({ id: 'groq', name: 'Groq', credential_id: null }),
];

const status = (id: CredentialStatus['id'], p: Partial<CredentialStatus> = {}): CredentialStatus => ({
  id,
  set: false,
  last4: null,
  source: null,
  env_var: `${id.toUpperCase()}_API_KEY`,
  check: 'provider',
  available: true,
  unavailable_reason: null,
  ...p,
});

const STATUSES = ['anthropic', 'openrouter', 'zai', 'deepseek', 'moonshot'].map((id) =>
  status(id as CredentialStatus['id']),
);

const failure = (code: string, title: string, hint: string, detail?: string) =>
  new ApiCallError(502, {
    error: { ...localError(code, title, hint, 't').error, context: {}, ...(detail && { detail }) },
  });

const row = (id: string) => within(document.getElementById(`credential-${id}`) as HTMLElement);
const openRow = async (id: string) => {
  await screen.findByText('Moonshot (Kimi)');
  // Both lists have arrived: Core's key page is linked, and the button is no longer waiting for the status.
  await waitFor(() => {
    expect(
      row(id)
        .getByRole('link', { name: /Get a key/ })
        .getAttribute('href'),
    ).toContain('example.test');
    expect(row(id).getByRole('button', { name: 'Add API key' })).toBeEnabled();
  });
  fireEvent.click(row(id).getByRole('button', { name: 'Add API key' }));
  return row(id);
};

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.put.mockReset();
  mocked.get.mockImplementation(async (path: string) =>
    path === '/providers' ? { items: PROVIDERS } : { items: STATUSES },
  );
});

describe('the list', () => {
  it('shows the first four, then the rest Core lists from A to Z, and skips ones with no key row', async () => {
    wrap(<ApiKeysGroup />);
    await screen.findByText('Moonshot (Kimi)');
    expect(screen.getByRole('heading', { name: 'More model providers' })).toBeInTheDocument();
    const names = () =>
      [...document.querySelectorAll('.credential .setting__label > span:first-child')].map(
        (n) => n.textContent,
      );
    // Until Core answers, the providers this build knows stand in; then Core's list replaces them.
    await waitFor(() => expect(names()).not.toContain('Mistral'));
    const all = names();
    expect(all.slice(0, 4)).toEqual(['Anthropic', 'OpenAI', 'Google', 'OpenRouter']);
    expect(all.slice(all.indexOf('DeepSeek'), all.indexOf('DeepSeek') + 3)).toEqual([
      'DeepSeek',
      'Moonshot (Kimi)',
      'Z.ai (GLM)',
    ]);
    expect(all).not.toContain('Groq');
  });

  it('links to the provider’s own key page and says how its keys look', async () => {
    wrap(<ApiKeysGroup />);
    const deepseek = await openRow('deepseek');
    const link = deepseek.getByRole('link', { name: /Get a key/ });
    expect(link).toHaveAttribute('href', 'https://example.test/deepseek');
    expect(link).toHaveAttribute('target', '_blank');
    expect(deepseek.getByText('Your key starts with sk-.')).toBeInTheDocument();
  });
});

describe('regions', () => {
  it('shows the region before saving, with the default chosen, and sends it', async () => {
    mocked.put.mockResolvedValue(
      status('moonshot', { set: true, source: 'saved', last4: 'wxyz', region: 'global' }),
    );
    wrap(<ApiKeysGroup />);
    const moonshot = await openRow('moonshot');
    const select = moonshot.getByLabelText('Region') as HTMLSelectElement;
    expect(select.value).toBe('global');
    fireEvent.change(moonshot.getByLabelText('Moonshot (Kimi) API key'), {
      target: { value: 'sk-abcdefghij' },
    });
    fireEvent.click(moonshot.getByRole('button', { name: 'Check and save' }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/credentials/moonshot', {
        value: 'sk-abcdefghij',
        region: 'global',
      }),
    );
  });

  it('sends the region you picked', async () => {
    mocked.put.mockResolvedValue(
      status('moonshot', { set: true, source: 'saved', last4: 'wxyz', region: 'china' }),
    );
    wrap(<ApiKeysGroup />);
    const moonshot = await openRow('moonshot');
    fireEvent.change(moonshot.getByLabelText('Region'), { target: { value: 'china' } });
    fireEvent.change(moonshot.getByLabelText('Moonshot (Kimi) API key'), {
      target: { value: 'sk-abcdefghij' },
    });
    fireEvent.click(moonshot.getByRole('button', { name: 'Check and save' }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/credentials/moonshot', {
        value: 'sk-abcdefghij',
        region: 'china',
      }),
    );
  });

  it('has no region for a provider with one endpoint', async () => {
    wrap(<ApiKeysGroup />);
    const deepseek = await openRow('deepseek');
    expect(deepseek.queryByLabelText('Region')).toBeNull();
    fireEvent.change(deepseek.getByLabelText('DeepSeek API key'), { target: { value: 'sk-abcdefghij' } });
    mocked.put.mockResolvedValue(status('deepseek', { set: true, source: 'saved', last4: 'ghij' }));
    fireEvent.click(deepseek.getByRole('button', { name: 'Check and save' }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/credentials/deepseek', { value: 'sk-abcdefghij' }),
    );
  });

  it('names the other region on a wrong-region failure and tries it in one click', async () => {
    mocked.put
      .mockRejectedValueOnce(
        failure(
          'provider.wrong_region',
          'Moonshot (Kimi) says this key is for another region',
          'Try China (platform.moonshot.cn): change the region beside the key.',
        ),
      )
      .mockResolvedValueOnce(
        status('moonshot', { set: true, source: 'saved', last4: 'ghij', region: 'china' }),
      );
    wrap(<ApiKeysGroup />);
    const moonshot = await openRow('moonshot');
    fireEvent.change(moonshot.getByLabelText('Moonshot (Kimi) API key'), {
      target: { value: 'sk-abcdefghij' },
    });
    fireEvent.click(moonshot.getByRole('button', { name: 'Check and save' }));
    const retry = await moonshot.findByRole('button', { name: 'Try China (platform.moonshot.cn)' });
    expect(moonshot.queryByRole('button', { name: /Try International/ })).toBeNull();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(mocked.put).toHaveBeenLastCalledWith('/credentials/moonshot', {
        value: 'sk-abcdefghij',
        region: 'china',
      }),
    );
  });
});

describe('a saved key in another region', () => {
  it('tests the saved key there without asking for it again, and says where it failed', async () => {
    mocked.post.mockReset();
    mocked.get.mockImplementation(async (path: string) =>
      path === '/providers'
        ? { items: PROVIDERS }
        : {
            items: STATUSES.map((x) =>
              x.id === 'moonshot' ? { ...x, set: true, source: 'saved', last4: 'ghij', region: 'global' } : x,
            ),
          },
    );
    mocked.post.mockRejectedValueOnce(
      failure(
        'provider.wrong_region',
        'Moonshot (Kimi) says this key is for another region',
        'Try the other one.',
      ),
    );
    wrap(<ApiKeysGroup />);
    await screen.findByText('Moonshot (Kimi)');
    const moonshot = row('moonshot');
    const select = await moonshot.findByLabelText('Region');
    fireEvent.change(select, { target: { value: 'china' } });
    await waitFor(() =>
      expect(mocked.post).toHaveBeenLastCalledWith('/setup/providers/test', {
        provider: 'moonshot',
        use_saved: true,
        region: 'china',
        save: true,
      }),
    );
    // It failed in China: the one to try is the other region, not China again.
    expect(
      await moonshot.findByRole('button', { name: 'Try International (platform.kimi.ai)' }),
    ).toBeTruthy();
  });
});

describe('what went wrong, in words', () => {
  const fail = async (id: string, label: string, err: unknown) => {
    mocked.put.mockRejectedValue(err);
    const r = await openRow(id);
    fireEvent.change(r.getByLabelText(`${label} API key`), { target: { value: 'sk-abcdefghij' } });
    fireEvent.click(r.getByRole('button', { name: 'Check and save' }));
    return r.findByRole('alert');
  };

  it('says an account is out of credit, not that the key is bad', async () => {
    wrap(<ApiKeysGroup />);
    const alert = await fail(
      'deepseek',
      'DeepSeek',
      failure(
        'provider.no_credit',
        'DeepSeek says your account is out of credit',
        'Top up at DeepSeek.',
        'Insufficient Balance',
      ),
    );
    expect(alert).toHaveTextContent(
      'DeepSeek says your account is out of credit. Top up there, or use another model.',
    );
    expect(alert).toHaveTextContent('DeepSeek said: Insufficient Balance');
    expect(alert).not.toHaveTextContent(/rejected|bad key/i);
  });

  it('says a provider is busy and the key may be fine', async () => {
    wrap(<ApiKeysGroup />);
    const alert = await fail(
      'deepseek',
      'DeepSeek',
      failure(
        'provider.unavailable',
        'DeepSeek is limiting requests right now',
        'The key may well be fine. Wait a minute.',
      ),
    );
    expect(alert).toHaveTextContent(
      'DeepSeek is busy right now. Your key may be fine; try again in a moment.',
    );
  });

  it('says which model a key may not use', async () => {
    wrap(<ApiKeysGroup />);
    const alert = await fail(
      'deepseek',
      'DeepSeek',
      failure(
        'provider.model_not_permitted',
        "DeepSeek says this key can't use DeepSeek V4.1 Flash",
        'Pick another model.',
      ),
    );
    expect(alert).toHaveTextContent("This key can't use DeepSeek V4.1 Flash.");
  });

  it('says whose key it looks like when Core says so', async () => {
    wrap(<ApiKeysGroup />);
    const alert = await fail(
      'deepseek',
      'DeepSeek',
      failure(
        'credentials.invalid',
        'That key is for OpenRouter, not DeepSeek',
        'Add this one under OpenRouter. Nothing was saved.',
      ),
    );
    expect(alert).toHaveTextContent('This looks like an OpenRouter key.');
  });

  it('keeps Core’s own words for anything else', () => {
    const p = friendlyProblem(
      { code: 'provider.auth_failed', title: 'DeepSeek rejected the API key', hint: 'Update it.' },
      { name: 'DeepSeek' },
    );
    expect(p.title).toBe('DeepSeek rejected the API key');
    expect(p.tryRegions).toEqual([]);
  });
});

describe('a key pasted into the wrong row', () => {
  it('suggests the right row, and never stops you saving', async () => {
    mocked.put.mockResolvedValue(status('deepseek', { set: true, source: 'saved', last4: 'wxyz' }));
    wrap(<ApiKeysGroup />);
    const deepseek = await openRow('deepseek');
    fireEvent.change(deepseek.getByLabelText('DeepSeek API key'), {
      target: { value: 'sk-or-v1-abcdefghijkl' },
    });
    expect(deepseek.getByRole('status')).toHaveTextContent('This looks like an OpenRouter key.');
    expect(deepseek.getByRole('button', { name: 'Check and save' })).toBeEnabled();
    fireEvent.click(deepseek.getByRole('button', { name: 'Check and save' }));
    await waitFor(() => expect(mocked.put).toHaveBeenCalledTimes(1));
  });

  it('moves it to that row, ready to check', async () => {
    wrap(<ApiKeysGroup />);
    const deepseek = await openRow('deepseek');
    fireEvent.change(deepseek.getByLabelText('DeepSeek API key'), {
      target: { value: 'sk-or-v1-abcdefghijkl' },
    });
    fireEvent.click(deepseek.getByRole('button', { name: 'Move it there' }));
    const openrouter = row('openrouter');
    await waitFor(() =>
      expect((openrouter.getByLabelText('OpenRouter API key') as HTMLInputElement).value).toBe(
        'sk-or-v1-abcdefghijkl',
      ),
    );
    expect(document.getElementById('credential-deepseek')?.querySelector('input')).toBeNull();
    expect(openrouter.getByRole('button', { name: 'Check and save' })).toBeEnabled();
  });

  it('says nothing for a key that fits, or one with no clear start', () => {
    const rows = [
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'openrouter', name: 'OpenRouter' },
      { id: 'xai', name: 'xAI (Grok)' },
    ];
    expect(recogniseKey('sk-ant-api03-abcdef', 'anthropic', rows)).toBeNull();
    expect(recogniseKey('sk-abcdefghijkl', 'anthropic', rows)).toBeNull();
    expect(recogniseKey('sk-or', 'anthropic', rows)).toBeNull();
    expect(recogniseKey('sk-ant-api03-abcdef', 'openrouter', rows)?.name).toBe('Anthropic');
    expect(recogniseKey('xai-abcdefgh', 'anthropic', rows)?.name).toBe('xAI (Grok)');
    // A provider with no row here cannot be offered.
    expect(recogniseKey('gsk_abcdefgh', 'anthropic', rows)).toBeNull();
  });
});

describe('models a key is not offered', () => {
  it('says nothing when every model is offered', () => {
    expect(notOfferedLine([])).toBeNull();
    expect(notOfferedLine(undefined)).toBeNull();
  });

  it('says in one quiet line which models stay off', () => {
    expect(notOfferedLine([{ display_name: 'Gemini 3 Pro' }])).toBe(
      "Gemini 3 Pro isn't offered to this key, so it stays off.",
    );
    expect(notOfferedLine([{ display_name: 'A' }, { display_name: 'B' }, { display_name: 'C' }])).toBe(
      "A, B and C aren't offered to this key, so they stay off.",
    );
  });
});
