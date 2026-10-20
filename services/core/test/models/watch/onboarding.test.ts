/**
 * Model onboarding: the first check after a key is saved (F3a), starter models
 * and the one-token test that marks a refused model unavailable (F3c), and
 * abilities for models whose list names none (F3d).
 */
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { familyCapabilities } from '../../../src/models/watch/caps';
import { parseGoogle } from '../../../src/models/watch/listers';
import { MANUAL_MIN_GAP_MS } from '../../../src/models/watch/service';
import { modelRefusal } from '../../../src/models/watch/testcall';
import { switchedOnByKey } from '../../../src/setup/key-check';
import { world } from './world';

const KEY = 'GOOGLE_GENERATIVE_AI_API_KEY';
const gemini = (
  id: string,
  pm: string,
  price: [number, number],
  over: Partial<ModelConfig> = {},
): ModelConfig => ({
  id: `google/${id}`,
  provider: 'google',
  provider_model: pm,
  display_name: id,
  via: 'direct',
  family: 'google',
  context_window: 1_048_576,
  max_output: 65_536,
  capabilities: ['tools', 'vision', 'reasoning', 'json'],
  price: { input_per_mtok: price[0], output_per_mtok: price[1] },
  enabled: true,
  secret: KEY,
  ...over,
});
const GOOGLE = [
  gemini('gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', [0.3, 2.5]),
  gemini('gemini-3.8-flash', 'gemini-3.8-flash', [0.75, 3.75]),
  gemini('gemini-3-pro', 'gemini-3.1-pro-preview', [1.25, 10]),
];
const listed = (name: string, extra: Record<string, unknown> = {}) => ({
  name: `models/${name}`,
  displayName: name,
  inputTokenLimit: 1_048_576,
  outputTokenLimit: 65_536,
  supportedGenerationMethods: ['generateContent'],
  ...extra,
});
const googleWorld = async () => {
  const w = await world({
    models: GOOGLE,
    keys: [KEY],
    taskClasses: { 'chat.default': ['google/gemini-3.8-flash'] },
  });
  w.google = GOOGLE.map((m) => listed(m.provider_model));
  return w;
};
const fire = (w: Awaited<ReturnType<typeof world>>) => {
  const t = w.timers.timeouts.filter((x) => !x.cleared && x.ms === 2_000);
  for (const x of t) x.fn();
  return t.length;
};

describe('a key was saved (F3a)', () => {
  it('checks that provider at once, once for two quick saves, and not again within a minute', async () => {
    const w = await googleWorld();
    w.watch.keySaved('google');
    w.watch.keySaved('google');
    expect(fire(w)).toBe(1);
    await w.watch.idle();
    const report = await w.watch.report();
    expect(report.providers[0]).toMatchObject({ provider: 'google', ok: true, models: 3 });
    expect(report.providers[0]?.checked_at).not.toBeNull();
    const calls = w.calls.length;
    w.watch.keySaved('google');
    fire(w);
    await w.watch.idle();
    expect(w.calls.length).toBe(calls);
    w.clock.advance(MANUAL_MIN_GAP_MS + 1);
    w.watch.keySaved('google');
    fire(w);
    await w.watch.idle();
    expect(w.calls.length).toBeGreaterThan(calls);
  });

  it('never throws: a provider without a key, or a list that fails, is only logged', async () => {
    const w = await googleWorld();
    w.watch.keySaved('openai');
    fire(w);
    await w.watch.idle();
    expect(w.calls).toEqual([]);
  });

  it('tests each cheap starter once with one token, and never the preview or a dear model', async () => {
    const w = await googleWorld();
    w.watch.keySaved('google');
    fire(w);
    await w.watch.idle();
    expect(w.tested.map((m) => m.id).sort()).toEqual([
      'google/gemini-3.5-flash-lite',
      'google/gemini-3.8-flash',
    ]);
  });
});

describe('a model the provider refuses (F3c)', () => {
  const refuse = (w: Awaited<ReturnType<typeof world>>, id: string) => {
    w.testFor = (m) =>
      m.id === id
        ? { ok: false, detail: 'did not answer', refused: 'models/x is no longer available to new users.' }
        : undefined;
  };

  it('marks a refused starter unavailable with the provider reason, and a new key clears it', async () => {
    const w = await googleWorld();
    refuse(w, 'google/gemini-3.5-flash-lite');
    w.watch.keySaved('google');
    fire(w);
    await w.watch.idle();
    const info = w.registry.info().find((m) => m.id === 'google/gemini-3.5-flash-lite');
    expect(info).toMatchObject({
      status: 'unavailable',
      unavailable_reason: 'models/x is no longer available to new users.',
    });
    expect(w.registry.info().find((m) => m.id === 'google/gemini-3.8-flash')?.status).toBe('ready');
    // The refusal survives a refresh, and a fresh key forgets it.
    await w.registry.refresh();
    expect(w.registry.info().find((m) => m.id === 'google/gemini-3.5-flash-lite')?.status).toBe(
      'unavailable',
    );
    w.testFor = undefined;
    w.clock.advance(MANUAL_MIN_GAP_MS + 1);
    w.watch.keySaved('google');
    fire(w);
    await w.watch.idle();
    expect(w.registry.info().find((m) => m.id === 'google/gemini-3.5-flash-lite')?.status).toBe('ready');
  });

  it('a transient failure (no refusal) leaves the model ready', async () => {
    const w = await googleWorld();
    w.testResult = { ok: false, detail: 'rate limited' };
    w.watch.keySaved('google');
    fire(w);
    await w.watch.idle();
    expect(w.registry.info().find((m) => m.id === 'google/gemini-3.8-flash')?.status).toBe('ready');
  });

  it('tests a model right after it is added, when it is cheap', async () => {
    const w = await googleWorld();
    w.google = [...w.google, listed('gemini-2.5-flash-lite')];
    await w.watch.check('google');
    refuse(w, 'google/gemini-2.5-flash-lite');
    await w.watch.add('google/gemini-2.5-flash-lite');
    await w.watch.idle();
    expect(w.registry.info().find((m) => m.id === 'google/gemini-2.5-flash-lite')?.status).toBe(
      'unavailable',
    );
  });

  it('does not test a dear model on its own', async () => {
    const w = await googleWorld();
    w.google = [...w.google, listed('gemini-9-pro')];
    await w.watch.check('google');
    w.tested.length = 0;
    await w.watch.add('google/gemini-9-pro');
    await w.watch.idle();
    expect(w.tested).toEqual([]);
  });
});

describe('modelRefusal', () => {
  const chain = (attempt: Record<string, unknown>) => ({ attempts: [attempt] });
  it('reads the provider words of a permanent, model-shaped failure', () => {
    expect(
      modelRefusal(
        chain({ errorClass: 'permanent', detail: 'This model is no longer available to new users.' }),
      ),
    ).toBe('This model is no longer available to new users.');
    expect(
      modelRefusal(chain({ errorClass: 'permanent', code: 'provider.model_not_permitted', detail: 'x' })),
    ).toBe('x');
  });
  it('says nothing about the model for a key, credit or rate problem', () => {
    expect(
      modelRefusal(chain({ errorClass: 'permanent', code: 'provider.auth_failed', detail: 'bad key' })),
    ).toBeNull();
    expect(modelRefusal(chain({ errorClass: 'transient', detail: 'model not found' }))).toBeNull();
    expect(modelRefusal(new Error('boom'))).toBeNull();
  });
});

describe('abilities (F3d)', () => {
  it('Google lists carry a family table: Flash-Lite sees images, Gemma 3 sees images but has no tools', () => {
    const { models } = parseGoogle({
      models: [
        listed('gemini-3.5-flash-lite'),
        listed('gemma-3-27b-it'),
        listed('gemma-3-1b-it'),
        listed('mystery-model'),
      ],
    });
    const by = Object.fromEntries(models.map((m) => [m.provider_model, m]));
    expect(by['gemini-3.5-flash-lite']?.capabilities).toEqual(['tools', 'vision', 'reasoning', 'json']);
    expect(by['gemma-3-27b-it']).toMatchObject({ capabilities: ['vision'], capsKnown: true });
    expect(by['gemma-3-1b-it']).toMatchObject({ capabilities: [], capsKnown: true });
    expect(by['mystery-model']).toMatchObject({ capabilities: [], capsKnown: false });
    expect(familyCapabilities('openai', 'gpt-5.5')).toBeNull();
  });

  it('a model added from the watch keeps what the list says, and claims no tools on a guess', async () => {
    const w = await googleWorld();
    w.google = [...w.google, listed('gemma-3-27b-it'), listed('mystery-model')];
    await w.watch.check('google');
    await w.watch.add('google/gemma-3-27b-it');
    await w.watch.add('google/mystery-model');
    await w.watch.idle();
    const caps = (id: string) => w.registry.getExact(id)?.capabilities;
    expect(caps('google/gemma-3-27b-it')).toEqual(['vision']);
    expect(caps('google/mystery-model')).toEqual([]);
  });
});

describe('what a first key switches on', () => {
  it("switches on each line's models; a preview comes on only when its line has nothing stable", async () => {
    const w = await googleWorld();
    // Pro exists only as a preview, so it is its line's lineup; the two stable Flash models come with it.
    expect(switchedOnByKey(w.registry, 'google', GOOGLE).map((m) => m.id)).toEqual([
      'google/gemini-3.5-flash-lite',
      'google/gemini-3.8-flash',
      'google/gemini-3-pro',
    ]);
    // Offered only a preview, it still comes on.
    expect(switchedOnByKey(w.registry, 'google', [GOOGLE[2] as ModelConfig]).map((m) => m.id)).toEqual([
      'google/gemini-3-pro',
    ]);
  });

  it('a preview beside a stable model of its own line stays off', async () => {
    const models = [
      gemini('flash', 'gemini-3.8-flash', [0.75, 3.75]),
      gemini('flash-next', 'gemini-4.0-flash-preview-1001', [0.75, 3.75]),
    ];
    const w = await world({ models, keys: [KEY] });
    expect(switchedOnByKey(w.registry, 'google', models).map((m) => m.id)).toEqual(['google/flash']);
  });
});
