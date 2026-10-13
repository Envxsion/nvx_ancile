/**
 * The local Auto reviewer: the utility chain's local model, else a small
 * Ollama model you pulled. Never a cloud model, a GPU node, an embedding
 * model, a large model or one Ollama does not have.
 */
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { paramsOf, reviewerModel } from '../../src/permissions/auto/wire';

const m = (id: string, over: Partial<ModelConfig> = {}): ModelConfig => ({
  id,
  provider: id.split('/')[0] as string,
  provider_model: id.split('/')[1] as string,
  display_name: id,
  via: 'direct',
  family: 'x',
  context_window: 8192,
  max_output: 1024,
  capabilities: [],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
  ...over,
});

const registry = (models: ModelConfig[], utility: ModelConfig[] = [], notReady: string[] = []) => ({
  chain: () => utility,
  all: () => models,
  status: (x: ModelConfig) => (notReady.includes(x.id) ? ('not_pulled' as const) : ('ready' as const)),
});

describe('the local reviewer model', () => {
  it('reads sizes from names', () => {
    expect(paramsOf('llama3.2:3b')).toBe(3);
    expect(paramsOf('qwen3-14b')).toBe(14);
    expect(paramsOf('gemma3:1.5b-instruct')).toBe(1.5);
    expect(paramsOf('mistral')).toBeNull();
  });

  it("uses the utility chain's local model first", () => {
    const u = m('ollama/phi4:14b');
    expect(reviewerModel(registry([u], [m('openai/gpt-5'), u]))?.id).toBe('ollama/phi4:14b');
  });

  it('else the smallest ready local chat model, up to 14B', () => {
    const models = [
      m('openai/gpt-5-mini'),
      m('ollama/qwen3:32b'),
      m('ollama/qwen3:4b'),
      m('ollama/llama3.2:1b'),
      m('ollama/nomic-embed:0.1b', { capabilities: ['embeddings'] }),
      m('ollama/gemma3:2b', { via: 'controller' }),
    ];
    expect(reviewerModel(registry(models, [], ['ollama/llama3.2:1b']))?.id).toBe('ollama/qwen3:4b');
    expect(reviewerModel(registry([m('ollama/qwen3:32b'), m('openai/gpt-5')]))).toBeNull();
  });
});
