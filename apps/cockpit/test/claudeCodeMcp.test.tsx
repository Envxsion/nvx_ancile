/**
 * Plugins → From Claude Code: your Claude Code MCP servers, read-only,
 * grouped by where they are set up, connected first, with nothing to
 * switch, edit or remove.
 */
import type { ClaudeCodeMcpServers } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { ClaudeCodeMcpSection, displayName } from '../src/ops/ClaudeCodeMcp';

const get = (api as unknown as { get: ReturnType<typeof vi.fn> }).get;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const LIST: ClaudeCodeMcpServers = {
  servers: [
    { name: 'claude.ai Vercel', source: 'claudeai', status: 'connected', tools: 238 },
    { name: 'claude.ai Supabase', source: 'claudeai', status: 'connected', tools: 28 },
    { name: 'claude.ai Adobe', source: 'claudeai', status: 'needs-auth', tools: null },
    { name: 'magic', source: 'user', status: 'pending', tools: null },
    { name: 'plugin:bio-research:pubmed', source: 'plugin', status: 'connected', tools: 7 },
  ],
  from: 'status',
  updated_at: new Date().toISOString(),
  can_refresh: true,
};

beforeEach(() => {
  queryClient.clear();
  get.mockReset();
});
afterEach(cleanup);

describe('From Claude Code', () => {
  it('lists them by where they are set up, connected first, and says they are managed in Claude Code', async () => {
    get.mockResolvedValue(LIST);
    wrap(<ClaudeCodeMcpSection />);
    expect(await screen.findByText('Vercel')).toBeInTheDocument();
    expect(screen.getByText('Supabase')).toBeInTheDocument();
    expect(screen.getByText('claude.ai connectors')).toBeInTheDocument();
    expect(screen.getByText('Claude Code plugins')).toBeInTheDocument();
    expect(
      screen.getByText(/managed in Claude Code and are available to Claude Code threads/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Adobe')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Show 1 not connected/ })[0] as HTMLElement);
    expect(screen.getByText('Adobe')).toBeInTheDocument();
    // Read-only: nothing to switch, edit or remove.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove|Edit/ })).toBeNull();
    get.mockResolvedValue(LIST);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(get).toHaveBeenCalledWith('/claude-code/mcp-servers?refresh=1');
  });

  it('says how to see them when Claude Code is not set up', async () => {
    get.mockResolvedValue({ servers: [], from: null, updated_at: null, can_refresh: false });
    wrap(<ClaudeCodeMcpSection />);
    expect(await screen.findByText(/Install and sign in to Claude Code/)).toBeInTheDocument();
  });

  it('names a connector and a plugin server plainly', () => {
    expect(displayName({ name: 'claude.ai Vercel', source: 'claudeai', status: null, tools: null })).toEqual({
      name: 'Vercel',
      from: null,
    });
    expect(
      displayName({ name: 'plugin:design:linear', source: 'plugin', status: null, tools: null }),
    ).toEqual({ name: 'linear', from: 'design plugin' });
  });
});
