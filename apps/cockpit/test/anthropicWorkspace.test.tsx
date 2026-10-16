/**
 * AK1: a personal Anthropic key (sk-ant-usr-) bills a workspace you name.
 * Pasting one opens a Workspace ID field, saving sends both, and the row
 * then says which workspace it bills. An organisation key never asks.
 */
import type { CredentialStatus } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ key: 'anthropic' }),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/state/notify', () => ({ notify: vi.fn() }));

import { ApiKeysGroup } from '../src/credentials/ApiKeys';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'put', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const anthropic = (p: Partial<CredentialStatus> = {}): CredentialStatus => ({
  id: 'anthropic',
  set: false,
  last4: null,
  source: null,
  env_var: 'ANTHROPIC_API_KEY',
  check: 'provider',
  available: true,
  unavailable_reason: null,
  workspace_id: null,
  ...p,
});

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.put.mockReset();
});

describe('Anthropic personal keys', () => {
  it('asks for the workspace once a personal key is pasted, and saves both', async () => {
    const saved = anthropic({
      set: true,
      source: 'saved',
      last4: 'wxyz',
      workspace_id: 'wrkspc_01ABCDEFGHJKMNPQ',
    });
    let stored = anthropic();
    mocked.get.mockImplementation(async () => ({ items: [stored] }));
    mocked.put.mockImplementation(async () => {
      stored = saved;
      return saved;
    });
    wrap(<ApiKeysGroup />);
    const key = await screen.findByLabelText('Anthropic API key');
    expect(screen.queryByLabelText('Workspace ID')).toBeNull();

    fireEvent.change(key, { target: { value: 'sk-ant-usr-01-abcdefghijklmnopwxyz' } });
    const ws = screen.getByLabelText('Workspace ID');
    const save = screen.getByRole('button', { name: 'Check and save' });
    expect(save).toBeDisabled();

    fireEvent.change(ws, { target: { value: 'wrkspc_01ABCDEFGHJKMNPQ' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/credentials/anthropic', {
        value: 'sk-ant-usr-01-abcdefghijklmnopwxyz',
        workspace_id: 'wrkspc_01ABCDEFGHJKMNPQ',
      }),
    );
    expect(await screen.findByText(/billing workspace/)).toBeInTheDocument();
  });

  it('never asks an organisation key for a workspace', async () => {
    mocked.get.mockResolvedValue({ items: [anthropic()] });
    wrap(<ApiKeysGroup />);
    const key = await screen.findByLabelText('Anthropic API key');
    fireEvent.change(key, { target: { value: 'sk-ant-api03-abcdefghijklmnop' } });
    expect(screen.queryByLabelText('Workspace ID')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check and save' })).toBeEnabled();
  });
});
