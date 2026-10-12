/**
 * ------------------------------------------------------------------
 *  Title    |  Scopes inside a flow
 *  Ref      |  docs/scopes.md (Where scopes are enforced) · docs/flows.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A flow's steps obey the thread's scope as it is at each
 *           |  step: models the scope refuses are never called, a step
 *           |  left with none stops with the scope's error, and searches
 *           |  read only the sources (and linked notebooks) it allows.
 * ------------------------------------------------------------------
 */

import type { EffectiveScope, ModelConfig, SearchResponse } from '@nvx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { FlowsService, makeTurnRuntime, type TurnHooks } from '../../src/flows/turn';
import type { ModelRequest } from '../../src/gateway/types';
import type { LinkedNotebook } from '../../src/links/service';
import { getEffectiveScope, MemoryScopeStore } from '../../src/scopes';

const model = (id: string, provider: string): ModelConfig =>
  ({
    id,
    provider,
    provider_model: id.split('/')[1],
    display_name: id,
    via: 'direct',
    family: 'x',
    context_window: 8_000,
    max_output: 1_000,
    capabilities: [],
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    enabled: true,
  }) as ModelConfig;

const claude = model('claude-code/haiku', 'claude_code');
const qwen = model('ollama/qwen2.5-1.5b', 'ollama');

const hit = (source: string, nb: string) => ({
  chunk_id: `${nb}-${source}-c1`,
  source_id: source,
  source_title: source,
  text: `passage from ${source}`,
  heading_path: [],
  page: null,
  char_start: 0,
  char_end: 20,
  score: 0.9,
  rerank_score: null,
  ranks: { vector: 1, text: 1 },
  kind: 'chunk' as const,
});

function setup(scope: () => Promise<EffectiveScope | null>, linked: LinkedNotebook[] = []) {
  const searches: { notebookId: string; sourceIds?: string[] }[] = [];
  const retriever = {
    search: vi.fn(async (q: { notebookId: string; sourceIds?: string[] }) => {
      searches.push({ notebookId: q.notebookId, ...(q.sourceIds && { sourceIds: q.sourceIds }) });
      return {
        hits: [hit(q.sourceIds?.[0] ?? 'any', q.notebookId)],
        mode: 'hybrid',
        embedder: null,
        ms: 1,
      } as unknown as SearchResponse;
    }),
  };
  const flows = new FlowsService({
    retriever,
    registry: { get: () => undefined, status: () => 'ready' },
  } as never);
  const calls: string[][] = [];
  const events: Record<string, unknown>[] = [];
  const hooks: TurnHooks = {
    flows,
    input: {
      text: 'What is the budget?',
      threadId: 'th1',
      notebookId: 'nb1',
      notebookTitle: null,
      workspaceId: 'ws',
      messageId: 'm2',
      userMessageId: 'm1',
      hasAttachment: false,
      branchDepth: 1,
    },
    signal: new AbortController().signal,
    messages: async () => [],
    compaction: null,
    groundingBlock: '',
    memory: async () => '',
    emit: async (e) => {
      events.push(e as Record<string, unknown>);
    },
    call: async (chain) => {
      calls.push(chain.map((m) => m.id));
      return {
        text: 'ok',
        reasoning: '',
        modelId: chain[0]?.id ?? '',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
      };
    },
    speak: () => undefined,
    setAnswer: async () => undefined,
    save: async () => undefined,
    scope,
    linked: async () => linked,
  };
  return { rt: makeTurnRuntime(hooks), calls, events, searches };
}

const req: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('scopes inside a flow', () => {
  it('skips a model the scope refuses and says why', async () => {
    const store = new MemoryScopeStore();
    await store.setPrivate('nb1', true);
    const { rt, calls, events } = setup(() => getEffectiveScope(store, { notebookId: 'nb1' }));
    await rt.call([claude, qwen], req, () => undefined, {});
    expect(calls).toEqual([['ollama/qwen2.5-1.5b']]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'fallback', from_model: 'claude-code/haiku', to_model: qwen.id }),
    );
  });

  it('stops a step with the scope error when no model may answer, and calls nothing', async () => {
    const store = new MemoryScopeStore();
    await store.setPrivate('nb1', true);
    const { rt, calls } = setup(() => getEffectiveScope(store, { notebookId: 'nb1' }));
    await expect(rt.call([claude], req, () => undefined, {})).rejects.toMatchObject({
      code: 'scope.private_notebook',
    });
    expect(calls).toEqual([]);
  });

  it('applies a scope narrowed mid-flow to the very next step', async () => {
    const store = new MemoryScopeStore();
    const { rt, calls } = setup(() => getEffectiveScope(store, { notebookId: 'nb1' }));
    await rt.call([claude], req, () => undefined, {});
    await store.mergePatch('notebook', 'nb1', { data_leaves_machine: false });
    await expect(rt.call([claude], req, () => undefined, {})).rejects.toMatchObject({
      code: 'scope.data_stays_local',
    });
    expect(calls).toEqual([['claude-code/haiku']]);
  });

  it('searches only the sources the scope allows', async () => {
    const store = new MemoryScopeStore();
    await store.mergePatch('notebook', 'nb1', { sources: ['src_a'] });
    const { rt, searches } = setup(() => getEffectiveScope(store, { notebookId: 'nb1' }));
    // A named source outside the scope: nothing is searched.
    expect(await rt.retrieve?.({ query: 'budget', k: 4, sourceIds: ['src_b'], rerank: false })).toBe('');
    // No sources named: only the scope's.
    expect(await rt.retrieve?.({ query: 'budget', k: 4, rerank: false })).toContain('passage from src_a');
    expect(searches).toEqual([{ notebookId: 'nb1', sourceIds: ['src_a'] }]);
    const ctx = rt.contextFor(qwen);
    expect(await ctx.sources({ mode: 'named', source_ids: ['src_b'] })).toBe('');
  });

  it('reads linked notebooks the links service allows', async () => {
    const store = new MemoryScopeStore();
    const linked: LinkedNotebook[] = [
      {
        linkId: 'lnk1',
        source: 'link',
        via: 'thread',
        notebookId: 'nb2',
        title: 'Budget notes',
        sourceIds: undefined,
      },
    ];
    const { rt, searches } = setup(() => getEffectiveScope(store, { notebookId: 'nb1' }), linked);
    const block = await rt.retrieve?.({ query: 'budget', k: 4, rerank: false });
    expect(searches.map((s) => s.notebookId).sort()).toEqual(['nb1', 'nb2']);
    expect(block).toContain('passage from any');
  });

  it('leaves everything as it was where no scope is read', async () => {
    const { rt, calls } = setup(async () => null);
    await rt.call([claude, qwen], req, () => undefined, {});
    expect(calls).toEqual([['claude-code/haiku', 'ollama/qwen2.5-1.5b']]);
  });
});
