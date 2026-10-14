/**
 * X1: a permission request that cannot be seen cannot be answered. While
 * the visibility check fails, every answer waits and the dialog says why;
 * once it passes they come back.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let visible = false;
vi.mock('../src/app/protected', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/app/protected')>();
  return { ...real, useVisibilityCheck: () => visible };
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...real,
    api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

import { ApprovalDialog } from '../src/approvals/ApprovalDialog';
import { queryClient } from '../src/lib/query';
import type { PendingApproval } from '../src/lib/types';
import { useUi } from '../src/state/ui';

const approval: PendingApproval = {
  id: 'apr_1',
  runId: 'run_1',
  threadId: 'thr_1',
  tool: 'fs_write',
  action: 'fs.write',
  resource: 'fs:/workspace/a.md',
  tier: 'gated',
  argsPreview: 'path: a.md',
  suggestions: ['fs:/workspace/a.md'],
  reason: 'The agent wants to write a file.',
};
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

beforeEach(() => {
  queryClient.clear();
  useUi.setState({ approvalOpen: true, approvalFocus: 'apr_1', demo: false });
});

describe('a request that cannot be seen', () => {
  it('pauses every answer and says why', () => {
    visible = false;
    wrap(<ApprovalDialog approval={approval} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something is covering this request');
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
  });

  it('can be answered once it can be seen', () => {
    visible = true;
    wrap(<ApprovalDialog approval={approval} />);
    expect(screen.queryByText(/Something is covering this request/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
  });
});
