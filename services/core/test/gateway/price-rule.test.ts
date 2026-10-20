/**
 * "Same price or cheaper" for a pinned model's fallbacks (DESIGN.md §7.2), the
 * subscription-engine exception, how images reach a model that cannot see them,
 * and telling a removed model from one that never existed.
 */
import { CLAUDE_CODE_PROVIDER, type ModelConfig, type Part } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { RoutingClient, withoutImages } from '../../src/gateway/registry';
import { resolveChain } from '../../src/gateway/router';
import type { ModelRequest, StreamChunk } from '../../src/gateway/types';
import { fakeModel } from './fake-provider';

const at = (id: string, input: number, output: number, extra: Partial<ModelConfig> = {}): ModelConfig => ({
  ...fakeModel(id, 'echo'),
  price: { input_per_mtok: input, output_per_mtok: output },
  ...extra,
});
const map = (...ms: ModelConfig[]) => new Map(ms.map((m) => [m.id, m]));
const ids = (ms: ModelConfig[]) => ms.map((m) => m.id);

describe('a pinned model falls back to no dearer model', () => {
  const haiku = at('haiku', 1, 5);
  const sonnet = at('sonnet', 3, 15);
  const flash = at('flash', 0.3, 2.5);
  const llama = at('llama', 0.1, 0.3);
  const local = at('local', 0, 0, { provider: 'ollama' });
  const plan = at('plan', 0, 0, { provider: CLAUDE_CODE_PROVIDER });
  const all = map(haiku, sonnet, flash, llama, local, plan);
  const classes = { 'chat.default': [sonnet.id, flash.id, llama.id, local.id, plan.id] };

  it('keeps only models whose input and output are both no higher', () => {
    const chain = resolveChain({ taskClass: 'chat.default', explicit: haiku.id }, classes, all);
    expect(ids(chain)).toEqual([haiku.id, flash.id, llama.id, local.id]);
  });

  it('an unpinned turn keeps its whole chain', () => {
    const chain = resolveChain({ taskClass: 'chat.default' }, classes, all);
    expect(ids(chain)).toEqual([sonnet.id, flash.id, llama.id, local.id, plan.id]);
  });

  it('a model cheaper on input but dearer on output is not "no dearer"', () => {
    const lopsided = at('lopsided', 0.1, 20);
    const chain = resolveChain(
      { taskClass: 'chat.default', explicit: haiku.id },
      { 'chat.default': [lopsided.id] },
      map(haiku, lopsided),
    );
    expect(ids(chain)).toEqual([haiku.id]);
  });

  it('a subscription engine follows an API model only when your own chain names it', () => {
    const named = resolveChain(
      { taskClass: 'chat.default', explicit: haiku.id, namedByPerson: new Set([plan.id]) },
      classes,
      all,
    );
    expect(ids(named)).toContain(plan.id);
  });

  it('a pinned model with a single candidate stays alone when the rest are dearer', () => {
    const chain = resolveChain(
      { taskClass: 'chat.default', explicit: llama.id },
      { 'chat.default': [sonnet.id, haiku.id] },
      all,
    );
    expect(ids(chain)).toEqual([llama.id]);
  });
});

describe('images and a model that cannot see them', () => {
  const image: Part = { type: 'image', url: '/api/v1/images/i1', mime: 'image/png', alt: 'photo.png' };
  const req: ModelRequest = {
    messages: [
      { role: 'user', content: 'What is this?', parts: [{ type: 'text', text: 'What is this?' }, image] },
    ],
  };

  it('replaces the picture with a text placeholder that names it', () => {
    const r = withoutImages(req);
    expect(r.names).toEqual(['photo.png']);
    expect(r.req.messages[0]?.content).toContain('[image: photo.png, not shown to this model]');
    expect(r.req.messages[0]?.parts?.some((p) => p.type === 'image')).toBe(false);
  });

  it('leaves a request with no image as it was', () => {
    const plain: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] };
    expect(withoutImages(plain)).toEqual({ req: plain, names: [] });
  });

  it('warns once on the turn, and sends the placeholder to a model without vision', async () => {
    const seen: ModelRequest[] = [];
    const sdk = {
      async *stream(_m: ModelConfig, r: ModelRequest): AsyncIterable<StreamChunk> {
        seen.push(r);
        yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const client = new RoutingClient(sdk, sdk);
    const blind = at('blind', 1, 1, { provider: 'openai', capabilities: ['tools'] });
    const out: StreamChunk[] = [];
    for await (const c of client.stream(blind, req, new AbortController().signal)) out.push(c);
    expect(out[0]).toMatchObject({ type: 'warning', code: 'image.not_shown' });
    expect(seen[0]?.messages[0]?.content).toContain('not shown to this model');

    const sighted = at('sighted', 1, 1, { provider: 'openai', capabilities: ['tools', 'vision'] });
    const out2: StreamChunk[] = [];
    for await (const c of client.stream(sighted, req, new AbortController().signal)) out2.push(c);
    expect(out2.some((c) => c.type === 'warning')).toBe(false);
    expect(seen[1]?.messages[0]?.parts?.some((p) => p.type === 'image')).toBe(true);
  });
});
