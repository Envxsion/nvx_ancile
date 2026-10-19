/**
 * LB2 /init in Settings: the draft is shown first, saving goes through the
 * ordinary file save only on the click, and an existing AGENTS.md is shown as
 * a diff with nothing to write.
 */
import type { LabInitDraft } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { InitAgents } from '../src/lab/InitAgents';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'post' | 'put', ReturnType<typeof vi.fn>>;
const draft = (p: Partial<LabInitDraft> = {}): LabInitDraft => ({
  path: '/r/AGENTS.md',
  content: '# web\n',
  exists: false,
  existing_sha256: null,
  diff: null,
  ...p,
});

const show = async () => {
  mocked.get.mockResolvedValue({ items: [{ id: 'rep_1', name: 'web' }] });
  render(
    <QueryClientProvider client={queryClient}>
      <InitAgents />
    </QueryClientProvider>,
  );
  await screen.findByRole('option', { name: 'web' });
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'rep_1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Draft AGENTS.md' }));
};

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
});

describe('write an AGENTS.md', () => {
  it('shows the draft and writes nothing until the click, through the ordinary save', async () => {
    mocked.post.mockResolvedValue(draft());
    mocked.put.mockResolvedValue({ path: '/r/AGENTS.md', bytes: 6, sha256: 'x', modified_at: '' });
    await show();
    await screen.findByText('# web');
    expect(mocked.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Write AGENTS.md' }));
    await waitFor(() => expect(mocked.put).toHaveBeenCalledTimes(1));
    expect(mocked.put).toHaveBeenCalledWith('/files', {
      path: '/r/AGENTS.md',
      content: '# web\n',
      base_sha256: null,
      confirmed: true,
    });
  });

  it('shows a diff and offers no write when the file already exists', async () => {
    mocked.post.mockResolvedValue(draft({ exists: true, existing_sha256: 'abc', diff: '-old\n+new' }));
    await show();
    await screen.findByText(/already has an AGENTS.md/);
    expect(screen.queryByRole('button', { name: 'Write AGENTS.md' })).toBeNull();
    expect(mocked.put).not.toHaveBeenCalled();
  });
});
