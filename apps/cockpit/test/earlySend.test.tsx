/**
 * A message sent from Home before the app has loaded its models and notebooks is held, not dropped:
 * Enter shows a busy Send ("Sending when ready"), the message goes once the lists are in, and if they
 * fail to load, or no model is ready at all, the composer says so and keeps the text.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({
  models: { data: undefined as unknown, isPending: true, isError: false, refetch: () => undefined },
  notebooks: { data: undefined as unknown, isPending: true, isError: false, refetch: () => undefined },
  model: undefined as unknown,
}));

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
vi.mock('../src/lib/data', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/data')>();
  return { ...real, useModels: () => hold.models, useNotebooks: () => hold.notebooks };
});
vi.mock('../src/lib/models', () => ({ useCurrentModel: () => hold.model }));

import { queryClient } from '../src/lib/query';
import { Composer } from '../src/thread/Composer';

// The hooks are mocked, so a changed prop is what makes the memoised composer draw again.
const tree = (onSend: () => Promise<boolean>, n = 0) => (
  <QueryClientProvider client={queryClient}>
    <Tooltip.Provider>
      <Composer threadId="new" parentId={null} onSend={onSend} notebookId={null} placeholder={`Ask ${n}`} />
    </Tooltip.Provider>
  </QueryClientProvider>
);

const loaded = (over: Partial<typeof hold.models> = {}) => ({
  data: [{ id: 'm', name: 'M' }],
  isPending: false,
  isError: false,
  refetch: () => undefined,
  ...over,
});

beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  hold.models = { data: undefined, isPending: true, isError: false, refetch: () => undefined };
  hold.notebooks = { data: undefined, isPending: true, isError: false, refetch: () => undefined };
  hold.model = undefined;
});

describe('Enter before the app is ready', () => {
  it('holds the message, shows a busy Send, and sends once, when the lists arrive', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = render(tree(onSend));
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    const send = screen.getByRole('button', { name: 'Sending when ready' });
    expect(send).toHaveAttribute('aria-busy', 'true');
    expect(input.value).toBe('hello');

    // A second Enter while it waits does not queue a second send.
    fireEvent.keyDown(input, { key: 'Enter' });

    hold.models = loaded();
    hold.notebooks = loaded({ data: [] });
    hold.model = { id: 'm', name: 'M' };
    await act(async () => {
      view.rerender(tree(onSend, 1));
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe('hello');
    expect(screen.queryByRole('button', { name: 'Sending when ready' })).toBeNull();
  });

  it('says what to do when the lists fail to load, and keeps the text', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = render(tree(onSend));
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    hold.models = { data: undefined, isPending: false, isError: true, refetch: () => undefined };
    await act(async () => {
      view.rerender(tree(onSend, 1));
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/did not load.*try again.*text is kept/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(input.value).toBe('hello');
  });

  it('says plainly when no model is available at all', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    hold.models = loaded({ data: [] });
    hold.notebooks = loaded({ data: [] });
    render(tree(onSend));
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/No model is ready/);
    expect(input.value).toBe('hello');
  });

  it('sends at once when everything is already loaded', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    hold.models = loaded();
    hold.notebooks = loaded({ data: [] });
    hold.model = { id: 'm', name: 'M' };
    render(tree(onSend));
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
