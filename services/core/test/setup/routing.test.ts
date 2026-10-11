/**
 * Routing chains edited in Admin → Routing: a saved order wins over
 * config/routing.yaml in the gateway, reset goes back to the YAML, and
 * bad chains are refused with a code from docs/errors.md.
 */
import type { ModelConfig, RoutingChain, RoutingList } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRegistry } from '../../src/gateway/registry';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const a = fakeModel('a', 'echo', 'alpha');
const b = fakeModel('b', 'echo', 'beta');
const c = fakeModel('c', 'echo', 'gamma');
const embed: ModelConfig = { ...fakeModel('e', 'echo'), capabilities: ['embeddings'] };
const opts = {
  models: [a, b, c, embed],
  taskClasses: { 'chat.default': [a.id, b.id], utility: [b.id, 'controller/later'], embed: [embed.id] },
  offline: false,
};

type Err = { error: { code: string; title: string } };

describe('routing chains', () => {
  it('lists editable classes with their YAML default', async () => {
    h = await harness(opts);
    const items = (await h.call<RoutingList>('GET', '/routing')).body.items;
    expect(items.map((i) => i.task_class)).toEqual(['chat.default', 'chat.deep', 'utility']);
    expect(items[0]).toMatchObject({
      chain: [a.id, b.id],
      configured: [a.id, b.id],
      default: [a.id, b.id],
      custom: false,
      ok: true,
    });
  });

  it('saves an order that wins over the YAML, and resets back to it', async () => {
    h = await harness(opts);
    const put = await h.call<RoutingChain>('PUT', '/routing/chat.default', { chain: [c.id, a.id] });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ chain: [c.id, a.id], configured: [c.id, a.id], custom: true });
    expect(h.registry.chain('chat.default').map((m) => m.id)).toEqual([c.id, a.id]);

    const del = await h.call<RoutingChain>('DELETE', '/routing/chat.default');
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ chain: [a.id, b.id], custom: false });
    expect(h.registry.chain('chat.default').map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it('refuses an empty chain', async () => {
    h = await harness(opts);
    const r = await h.call<Err>('PUT', '/routing/utility', { chain: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('routing.chain_empty');
  });

  it('refuses an unknown model, and a model that cannot chat', async () => {
    h = await harness(opts);
    const r = await h.call<Err>('PUT', '/routing/utility', { chain: [a.id, 'nope/model'] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('routing.model_unknown');
    const e = await h.call<Err>('PUT', '/routing/utility', { chain: [embed.id] });
    expect(e.status).toBe(422);
    expect(e.body.error.code).toBe('model.not_chat');
    expect(h.registry.savedChain('utility')).toBeUndefined();
  });

  it('keeps an id the YAML lists even before that model exists', async () => {
    h = await harness(opts);
    const r = await h.call<RoutingChain>('PUT', '/routing/utility', { chain: ['controller/later', b.id] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: ['controller/later', b.id], chain: [b.id] });
  });

  it('refuses a task class that does not exist, and local ones', async () => {
    h = await harness(opts);
    const r = await h.call<Err>('PUT', '/routing/chat.nope', { chain: [a.id] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('routing.task_class_unknown');
    expect((await h.call<Err>('DELETE', '/routing/embed')).status).toBe(404);
  });
});

describe('registry chain()', () => {
  it('returns the saved chain over the YAML, from a fresh registry too', async () => {
    const settings = new MemorySettings();
    const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
    const make = () =>
      new ModelRegistry({
        models: [a, b, c],
        taskClasses: { 'factcheck.verify': { chain: [a.id, b.id], prefer_different_family: true } },
        secrets,
        settings,
        offline: false,
      });
    const first = make();
    await first.refresh();
    await first.saveChain('factcheck.verify', [c.id, a.id, b.id]);
    expect(first.chain('factcheck.verify').map((m) => m.id)).toEqual([c.id, a.id, b.id]);

    const second = make();
    await second.refresh();
    // The YAML's prefer_different_family still applies to the saved order.
    expect(second.chain('factcheck.verify', null, { generatorFamily: 'gamma' }).map((m) => m.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });
});
