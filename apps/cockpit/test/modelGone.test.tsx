/**
 * ------------------------------------------------------------------
 *  Title    |  A model that is gone
 *  Ref      |  docs/errors.md (model.gone)
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: regenerating after the model was removed
 *           |  gave a generic error. Now the error names the model and
 *           |  offers a picker, preset to Core's suggestion, that sends
 *           |  the same regenerate again with the model picked.
 * ------------------------------------------------------------------
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/run')>();
  return { ...real, attachRun: vi.fn() };
});

import { ApiCallError, api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import { regenerate } from '../src/lib/turns';
import type { MessageView, ModelView } from '../src/lib/types';
import { ModelGoneNotice } from '../src/thread/ModelGoneNotice';
import { useModelGoneStore } from '../src/thread/model-gone-store';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;

const model = (id: string, name: string): ModelView =>
  ({
    id,
    name,
    provider: 'x',
    hue: 'violet',
    via: 'direct',
    contextWindow: 8_000,
    status: 'ready',
    chat: true,
  }) as unknown as ModelView;

const reply = {
  id: 'msg_a',
  parentId: 'msg_u',
  role: 'assistant',
  parts: [],
  blocks: [],
} as unknown as MessageView;

beforeEach(() => {
  mocked.get.mockReset();
  mocked.post.mockReset();
  useModelGoneStore.setState({ byThread: {} });
  queryClient.clear();
  queryClient.setQueryData(keys.models, [model('openai/gpt', 'GPT'), model('ollama/qwen', 'Qwen')]);
});
afterEach(() => cleanup());

describe('a model that is gone', () => {
  it('names the model and resends with the one picked, preset to the suggestion', async () => {
    mocked.post.mockRejectedValueOnce(
      new ApiCallError(409, {
        error: {
          code: 'model.gone',
          title: 'node/old is no longer available',
          hint: 'It was removed or renamed. Pick another model and send again.',
          retryable: false,
          trace_id: 't',
          attempts: [],
          context: { model_id: 'node/old', suggested_model: 'ollama/qwen' },
        },
      }),
    );
    expect(await regenerate('thr_1', reply)).toBe(false);
    expect(useModelGoneStore.getState().byThread.thr_1?.modelId).toBe('node/old');

    render(
      <QueryClientProvider client={queryClient}>
        <ModelGoneNotice threadId="thr_1" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/node\/old is no longer available/)).toBeTruthy();
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('ollama/qwen');

    mocked.post.mockResolvedValueOnce({
      run_id: 'run_2',
      user_message_id: 'msg_u',
      assistant_message_id: 'a2',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send with this model' }));
    await waitFor(() => expect(useModelGoneStore.getState().byThread.thr_1).toBeUndefined());
    expect(mocked.post.mock.calls[1]).toEqual(['/messages/msg_a/regenerate', { model: 'ollama/qwen' }]);
  });
});
