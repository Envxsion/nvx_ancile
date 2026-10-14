/**
 * CH1: with Slash and @ menus off, typing / or @ says why nothing opens,
 * with a way to turn them back on; Esc puts the line away for the draft,
 * and nothing is said with menus on or for text that is not a trigger.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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

import { queryClient } from '../src/lib/query';
import { usePrefs } from '../src/state/prefs';
import { Composer } from '../src/thread/Composer';

const HINT = 'Slash and @ menus are off, so / and @ are plain text.';

function composer() {
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <Composer threadId="thr_1" parentId="m1" onSend={vi.fn().mockResolvedValue(true)} notebookId={null} />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
  return screen.getByLabelText('Message') as HTMLTextAreaElement;
}

const menus = (on: boolean) => usePrefs.getState().set('composer', { menus: on });

beforeEach(() => {
  queryClient.clear();
  menus(true);
});

describe('when Slash and @ menus are off', () => {
  it('says so when you type / at the start or an @, and turns them back on', () => {
    menus(false);
    const input = composer();
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.getByText(HINT)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'ask @no' } });
    expect(screen.getByText(HINT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn menus on' }));
    expect(usePrefs.getState().prefs.composer.menus).toBe(true);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('says nothing for text that is no trigger: a slash later on, an email address, a finished mention', () => {
    menus(false);
    const input = composer();
    for (const value of ['and/or', 'mail me@example.com', 'see @notes then', '/model gpt']) {
      fireEvent.change(input, { target: { value } });
      expect(screen.queryByText(HINT)).toBeNull();
    }
  });

  it('goes away with Esc for that draft, and comes back on the next edit', () => {
    menus(false);
    const input = composer();
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText(HINT)).toBeNull();
    fireEvent.change(input, { target: { value: '/f' } });
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it('is never shown while menus are on', () => {
    const input = composer();
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
