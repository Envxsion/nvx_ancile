/**
 * A model, while a flow answers (DESIGN.md §16.3): picking a model in a
 * thread a flow answers asks first instead of quietly changing a setting
 * the flow would ignore; "just the next message" is handed to the
 * composer once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chooseModel } from '../src/lib/models';
import { queryClient } from '../src/lib/query';
import type { ModelView } from '../src/lib/types';
import { flowKeys } from '../src/thread/flowActions';
import { useModelChoice } from '../src/thread/ModelChoice';

const opus: ModelView = {
  id: 'anthropic/claude-opus-5-5',
  name: 'Claude Opus 5.5',
  provider: 'Anthropic',
  hue: 'chalk',
  via: 'direct',
  contextWindow: 200_000,
  status: 'ready',
};

afterEach(() => {
  queryClient.clear();
  useModelChoice.setState({ ask: null, next: {} });
});

describe('choosing a model while a flow answers', () => {
  it('asks how the model should take part, naming the flow and where it comes from', async () => {
    queryClient.setQueryData(flowKeys.resolve('thr_1'), {
      flow: { id: 'flw_1', name: 'Jev' },
      from: 'notebook',
    });
    await chooseModel(opus, 'thr_1');
    expect(useModelChoice.getState().ask).toMatchObject({
      threadId: 'thr_1',
      model: { id: opus.id },
      flow: { id: 'flw_1', name: 'Jev', from: 'notebook' },
    });
  });

  it('hands "just the next message" to the composer once', () => {
    useModelChoice.setState({ next: { thr_1: opus } });
    expect(useModelChoice.getState().takeNext('thr_1')?.id).toBe(opus.id);
    expect(useModelChoice.getState().takeNext('thr_1')).toBeUndefined();
  });
});
