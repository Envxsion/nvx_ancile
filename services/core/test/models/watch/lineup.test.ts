/**
 * The shipped lineup (MD2): every line's current model and the generation before it, what a saved key
 * switches on, how few one-token tests that costs, and what an install that saved its keys before the
 * lineup existed is given once. Offline: no model is called, the test call is a fake.
 */
import { fileURLToPath } from 'node:url';
import { type ModelConfig, ModelsFile } from '@nvx/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load';
import { ModelRegistry, secretFor } from '../../../src/gateway/registry';
import { resolveChain } from '../../../src/gateway/router';
import {
  isCheap,
  LINEUP_VERSION,
  TEST_CAP,
  TEST_CAP_OPENROUTER,
  UPGRADE_DELAY_MS,
} from '../../../src/models/watch/service';
import { MemorySecretStore, SecretBox } from '../../../src/secrets';
import { MemorySettings, SETTING } from '../../../src/settings';
import { world } from './world';

let shipped: ModelConfig[] = [];
let routing: Record<string, string[] | { chain: string[] }> = {};
beforeAll(async () => {
  const cfg = await loadConfig(fileURLToPath(new URL('../../../../../config', import.meta.url)));
  shipped = cfg.models?.models ?? [];
  routing = (cfg.routing?.task_classes ?? {}) as typeof routing;
});

const secretsOf = (models: ModelConfig[]) => [
  ...new Set(models.map((m) => secretFor(m)).filter((s): s is string => !!s)),
];

async function keyed(
  providers: string[],
  extra: Partial<ConstructorParameters<typeof ModelRegistry>[0]> = {},
) {
  const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
  const wanted = shipped.filter((m) => providers.includes(m.provider));
  for (const k of secretsOf(wanted)) await secrets.set(k, 'test-value');
  const settings = new MemorySettings();
  const registry = new ModelRegistry({
    models: shipped,
    taskClasses: routing as ConstructorParameters<typeof ModelRegistry>[0]['taskClasses'],
    secrets,
    settings,
    offline: false,
    ...extra,
  });
  await registry.refresh();
  return { registry, settings, secrets };
}

const idsOf = (ms: ModelConfig[]) => ms.map((m) => m.id);

describe('what the lineup ships', () => {
  it('Anthropic: Fable, Opus, Sonnet and Haiku, each current and previous', async () => {
    const { registry } = await keyed(['anthropic']);
    expect(idsOf(registry.lineup('anthropic')).sort()).toEqual(
      [
        'anthropic/claude-fable-5',
        'anthropic/claude-fable-5-1',
        'anthropic/claude-haiku-4-5',
        'anthropic/claude-haiku-5-5',
        'anthropic/claude-opus-5',
        'anthropic/claude-opus-5-5',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-sonnet-5-5',
      ].sort(),
    );
  });

  it('OpenAI: Astra, Sol and Luna; Google: Argon, Pro, Flash and Flash-Lite', async () => {
    const { registry } = await keyed(['openai', 'google']);
    expect(idsOf(registry.lineup('openai')).sort()).toEqual(
      [
        'openai/gpt-5.6-luna',
        'openai/gpt-6-astra',
        'openai/gpt-6-luna',
        'openai/gpt-6-sol',
        'openai/gpt-6.1-sol',
      ].sort(),
    );
    expect(idsOf(registry.lineup('google')).sort()).toEqual(
      [
        'google/gemini-3-pro',
        'google/gemini-3.1-flash-lite',
        'google/gemini-3.5-flash-lite',
        'google/gemini-3.6-flash',
        'google/gemini-3.8-flash',
        'google/gemini-4-argon',
      ].sort(),
    );
  });

  it('every line of every provider has at most a current and a previous generation on', async () => {
    const providers = [...new Set(shipped.filter((m) => secretFor(m)).map((m) => m.provider))];
    const { registry } = await keyed(providers);
    for (const p of providers) {
      const versions = new Map<string, Set<string>>();
      for (const m of registry.lineup(p)) {
        const line = registry.lineIdOf(m.id);
        if (!line) continue;
        const v = versions.get(line) ?? new Set<string>();
        v.add(registry.lineGroup(line)?.members.find((x) => x.id === m.id)?.version ?? '');
        versions.set(line, v);
      }
      for (const [line, set] of versions) expect(set.size, line).toBeLessThanOrEqual(2);
    }
  });

  it('OpenRouter ships every company as lines of current and previous models', async () => {
    const { registry } = await keyed(['openrouter']);
    const on = registry.lineup('openrouter');
    expect(on.length).toBeGreaterThan(50);
    const companies = new Set(
      registry
        .info()
        .filter((m) => m.listed && m.company)
        .map((m) => m.company),
    );
    for (const c of [
      'Anthropic',
      'OpenAI',
      'Google',
      'Meta',
      'Mistral',
      'DeepSeek',
      'Qwen',
      'xAI',
      'Moonshot',
      'Z.ai',
      'MiniMax',
      'Cohere',
      'NVIDIA',
    ])
      expect(companies, c).toContain(c);
    const info = new Map(registry.info().map((m) => [m.id, m]));
    // Llama 4 is current and Llama 3.3 is folded as older.
    expect(info.get('openrouter/meta-llama__llama-4-maverick')?.older).toBeUndefined();
    expect(info.get('openrouter/meta-llama__llama-3.3-70b-instruct')?.older).toBe(true);
    // Mistral Large 4 is a public preview: Large 3 answers and the preview stays off.
    expect(info.get('openrouter/mistralai__mistral-large-4-0')?.listed).toBe(false);
    expect(info.get('openrouter/mistralai__mistral-large-2512')?.listed).toBe(true);
    expect(registry.currentOfLine('openrouter/mistral-large')).toBe(
      'openrouter/mistralai__mistral-large-2512',
    );
  });

  it("a :latest alias answers with the line's current model, and agrees with what the picker shows", async () => {
    const { registry } = await keyed(['anthropic', 'openai', 'google', 'openrouter']);
    const cases: [string, string][] = [
      ['anthropic/haiku:latest', 'anthropic/claude-haiku-5-5'],
      ['anthropic/sonnet:latest', 'anthropic/claude-sonnet-5-5'],
      ['openai/sol:latest', 'openai/gpt-6.1-sol'],
      ['openai/luna:latest', 'openai/gpt-6-luna'],
      ['openai/astra:latest', 'openai/gpt-6-astra'],
      ['google/gemini-flash:latest', 'google/gemini-3.8-flash'],
      ['google/gemini-flash-lite:latest', 'google/gemini-3.5-flash-lite'],
      ['google/gemini-argon:latest', 'google/gemini-4-argon'],
    ];
    for (const [alias, model] of cases) expect(registry.get(alias)?.id, alias).toBe(model);
    const older = registry
      .info()
      .filter((m) => m.older)
      .map((m) => m.id);
    expect(older).toContain('anthropic/claude-haiku-4-5');
    expect(older).toContain('openai/gpt-6-sol');
    expect(older).toContain('google/gemini-3.1-flash-lite');
    // The model an alias answers with is never also flagged older.
    for (const [, model] of cases) expect(older).not.toContain(model);
  });

  it('the routing defaults still name real lines and are untouched by the larger lineup', async () => {
    const { registry } = await keyed(['anthropic', 'openai', 'google', 'openrouter']);
    const chain = (tc: string) => {
      const spec = routing[tc];
      return Array.isArray(spec) ? spec : (spec?.chain ?? []);
    };
    expect(chain('chat.default').slice(0, 2)).toEqual(['anthropic/sonnet:latest', 'openai/sol:latest']);
    expect(registry.chain('chat.default')[0]?.id).toBe('anthropic/claude-sonnet-5-5');
    expect(registry.chain('utility')[0]?.id).toBe('anthropic/claude-haiku-5-5');
  });

  it('a dear model is never a fallback for a cheaper pinned one', async () => {
    const { registry } = await keyed(['anthropic', 'openai', 'google', 'openrouter']);
    // Everything in the lineup is on and ready.
    await registry.setEnabled(Object.fromEntries(shipped.map((m) => [m.id, true])));
    const pinned = registry.get('anthropic/claude-haiku-5-5') as ModelConfig;
    const ready = new Map(
      registry
        .all()
        .filter((m) => registry.status(m) === 'ready')
        .map((m) => [m.id, m]),
    );
    const chain = resolveChain(
      { taskClass: 'chat.deep', explicit: pinned.id },
      {
        'chat.deep': [
          'anthropic/claude-opus-5-5',
          'anthropic/claude-fable-5-1',
          'openai/gpt-6-astra',
          'anthropic/claude-haiku-4-5',
        ],
      },
      ready,
    );
    for (const m of chain) {
      expect(m.price.input_per_mtok).toBeLessThanOrEqual(pinned.price.input_per_mtok);
      expect(m.price.output_per_mtok).toBeLessThanOrEqual(pinned.price.output_per_mtok);
    }
    expect(idsOf(chain)).not.toContain('anthropic/claude-fable-5-1');
    expect(idsOf(chain)).not.toContain('anthropic/claude-opus-5-5');
  });
});

describe('one-token tests after a key is saved', () => {
  it('picks at most one cheap model per line, never a dear one, and no more than the cap', async () => {
    const providers = [...new Set(shipped.filter((m) => secretFor(m)).map((m) => m.provider))];
    const { registry } = await keyed(providers);
    for (const p of providers) {
      const cap = p === 'openrouter' ? TEST_CAP_OPENROUTER : TEST_CAP;
      const picks = registry.testPicks(p, isCheap, cap);
      expect(picks.length, p).toBeLessThanOrEqual(cap);
      const lines = picks.map((m) => registry.lineIdOf(m.id) ?? m.id);
      expect(new Set(lines).size, p).toBe(lines.length);
      for (const m of picks) expect(isCheap(m), m.id).toBe(true);
    }
    // Anthropic's only cheap line is Haiku, and its current model is the one tried.
    expect(idsOf(registry.testPicks('anthropic', isCheap, TEST_CAP))).toEqual(['anthropic/claude-haiku-5-5']);
  });

  it('saving the OpenRouter key tries three models at most, all cheap', async () => {
    const w = await world({ models: shipped, keys: ['OPENROUTER_API_KEY'] });
    w.watch.keySaved('openrouter');
    for (const x of w.timers.timeouts.filter((t) => !t.cleared && t.ms === 2_000)) x.fn();
    await w.watch.idle();
    expect(w.tested.length).toBeGreaterThan(0);
    expect(w.tested.length).toBeLessThanOrEqual(TEST_CAP_OPENROUTER);
    for (const m of w.tested) expect(isCheap(m)).toBe(true);
  });

  it('saving the Anthropic key tries only Haiku', async () => {
    const w = await world({ models: shipped, keys: ['ANTHROPIC_API_KEY'] });
    w.watch.keySaved('anthropic');
    for (const x of w.timers.timeouts.filter((t) => !t.cleared && t.ms === 2_000)) x.fn();
    await w.watch.idle();
    expect(idsOf(w.tested)).toEqual(['anthropic/claude-haiku-5-5']);
  });
});

describe('an install that saved its keys before the lineup existed', () => {
  const customFlashLite25: ModelConfig = {
    id: 'google/gemini-2.5-flash-lite',
    provider: 'google',
    provider_model: 'gemini-2.5-flash-lite',
    display_name: 'Gemini 2.5 Flash-Lite',
    via: 'direct',
    family: 'google',
    context_window: 1_048_576,
    max_output: 65_536,
    capabilities: ['tools'],
    price: { input_per_mtok: 0.1, output_per_mtok: 0.4 },
    enabled: true,
    secret: 'GOOGLE_GENERATIVE_AI_API_KEY',
  };

  it('switches the lineup on once, leaves what you turned off, and turns nothing off', async () => {
    const w = await world({ models: shipped, keys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY'] });
    await w.registry.setEnabled({ 'google/gemini-3.6-flash': false, 'anthropic/claude-opus-5': true });
    await w.watch.upgradeLineup();
    const status = (id: string) => w.registry.info().find((m) => m.id === id)?.status;
    expect(status('google/gemini-4-argon')).toBe('ready');
    expect(status('google/gemini-3.8-flash')).toBe('ready');
    expect(status('anthropic/claude-fable-5-1')).toBe('ready');
    expect(status('anthropic/claude-haiku-4-5')).toBe('ready');
    expect(status('google/gemini-3.6-flash')).toBe('disabled'); // you turned it off
    expect(status('anthropic/claude-opus-5')).toBe('ready'); // you turned it on
    // A provider with no key gets nothing.
    expect(status('openai/gpt-6-astra')).toBe('disabled');
    expect(await w.settings.get(SETTING.lineupVersion)).toBe(LINEUP_VERSION);
  });

  it('tries each cheap model that is on and was never tried; never a dear one; and only once', async () => {
    const w = await world({ models: shipped, keys: ['GOOGLE_GENERATIVE_AI_API_KEY'] });
    await w.settings.set(SETTING.customModels, [customFlashLite25]);
    await w.registry.refresh();
    w.testFor = (m) =>
      m.id === 'google/gemini-2.5-flash-lite'
        ? {
            ok: false,
            detail: 'refused',
            refused: 'models/gemini-2.5-flash-lite is no longer available to new users.',
          }
        : undefined;
    await w.watch.upgradeLineup();
    const tried = idsOf(w.tested);
    expect(tried).toContain('google/gemini-2.5-flash-lite');
    expect(tried).toContain('google/gemini-3.5-flash-lite');
    for (const m of w.tested) expect(isCheap(m)).toBe(true);
    expect(tried).not.toContain('google/gemini-4-argon');
    expect(tried).not.toContain('google/gemini-3-pro');
    expect(w.registry.info().find((m) => m.id === 'google/gemini-2.5-flash-lite')).toMatchObject({
      status: 'unavailable',
      unavailable_reason: 'models/gemini-2.5-flash-lite is no longer available to new users.',
    });
    // The step ran for this lineup version: a second run does not call anything.
    const calls = w.tested.length;
    await w.watch.upgradeLineup();
    expect(w.tested.length).toBe(calls);
  });

  it('moves a line pinned to a model that turns out unavailable onto the newest one that answers', async () => {
    const w = await world({ models: shipped, keys: ['GOOGLE_GENERATIVE_AI_API_KEY'] });
    await w.settings.set(SETTING.customModels, [customFlashLite25]);
    await w.settings.set(SETTING.modelLines, {
      'google/gemini-flash-lite': {
        follow: false,
        current_id: 'google/gemini-2.5-flash-lite',
        previous_id: null,
        pending: null,
      },
    });
    await w.registry.refresh();
    expect(w.registry.get('google/gemini-flash-lite:latest')?.id).toBe('google/gemini-2.5-flash-lite');
    w.testFor = (m) =>
      m.id === 'google/gemini-2.5-flash-lite'
        ? { ok: false, detail: 'refused', refused: 'not available to new users' }
        : undefined;
    await w.watch.upgradeLineup();
    expect(w.registry.get('google/gemini-flash-lite:latest')?.id).toBe('google/gemini-3.5-flash-lite');
  });

  it('runs shortly after boot, not on the hourly tick, and again after a manual check', async () => {
    const w = await world({ models: shipped, keys: ['GOOGLE_GENERATIVE_AI_API_KEY'] });
    await w.settings.set(SETTING.customModels, [customFlashLite25]);
    await w.registry.refresh();
    w.testFor = (m) =>
      m.id === 'google/gemini-2.5-flash-lite'
        ? { ok: false, detail: 'refused', refused: 'no longer available to new users.' }
        : undefined;
    w.watch.start();
    const soon = w.timers.timeouts.find((t) => !t.cleared && t.ms === UPGRADE_DELAY_MS);
    expect(soon).toBeDefined();
    expect(UPGRADE_DELAY_MS).toBeLessThanOrEqual(2 * 60_000);
    soon?.fn();
    await w.watch.idle();
    for (let i = 0; i < 50 && (await w.settings.get(SETTING.lineupVersion)) === undefined; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await w.settings.get(SETTING.lineupVersion)).toBe(LINEUP_VERSION);
    expect(w.registry.info().find((m) => m.id === 'google/gemini-2.5-flash-lite')?.status).toBe(
      'unavailable',
    );
    w.watch.stop();
  });

  it('POST /models/watch/check also finishes an upgrade that has not run', async () => {
    const w = await world({ models: shipped, keys: ['GOOGLE_GENERATIVE_AI_API_KEY'] });
    await w.settings.set(SETTING.customModels, [customFlashLite25]);
    await w.registry.refresh();
    w.testFor = (m) =>
      m.id === 'google/gemini-2.5-flash-lite'
        ? { ok: false, detail: 'refused', refused: 'no longer available to new users.' }
        : undefined;
    await w.watch.check().catch(() => undefined);
    expect(await w.settings.get(SETTING.lineupVersion)).toBe(LINEUP_VERSION);
    expect(w.registry.info().find((m) => m.id === 'google/gemini-2.5-flash-lite')?.status).toBe(
      'unavailable',
    );
  });

  it('a try that could not be read (offline) is repeated on the next check, then given up on after three', async () => {
    const w = await world({ models: shipped, keys: ['ANTHROPIC_API_KEY'] });
    w.testResult = { ok: false, detail: 'rate limited' }; // no refusal: says nothing about the model
    await w.watch.upgradeLineup();
    expect(await w.settings.get(SETTING.lineupVersion)).toBeUndefined();
    await w.watch.upgradeLineup();
    await w.watch.upgradeLineup();
    expect(await w.settings.get(SETTING.lineupVersion)).toBe(LINEUP_VERSION);
  });
});

describe('a model you added that models.yaml now ships too', () => {
  const base = (over: Partial<ModelConfig> = {}): ModelConfig => ({
    id: 'google/gemini-3.5-flash-lite',
    provider: 'google',
    provider_model: 'gemini-3.5-flash-lite',
    display_name: 'Gemini 3.5 Flash-Lite',
    via: 'direct',
    family: 'google',
    context_window: 1_048_576,
    max_output: 65_536,
    capabilities: ['tools', 'vision', 'reasoning', 'json'],
    price: { input_per_mtok: 0.3, output_per_mtok: 2.5 },
    enabled: false,
    secret: 'GOOGLE_GENERATIVE_AI_API_KEY',
    ...over,
  });
  async function boot(yaml: ModelConfig, custom: ModelConfig, overrides?: Record<string, boolean>) {
    const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
    await secrets.set('GOOGLE_GENERATIVE_AI_API_KEY', 'test-value');
    const settings = new MemorySettings();
    await settings.set(SETTING.customModels, [custom]);
    await settings.set(SETTING.watchAdded, [custom.id]);
    if (overrides) await settings.set(SETTING.modelEnabled, overrides);
    const registry = new ModelRegistry({
      models: [yaml],
      taskClasses: { 'chat.default': [yaml.id] },
      secrets,
      settings,
      offline: false,
    });
    await registry.refresh();
    return { registry, settings };
  }

  it('boots without a crash, the shipped model wins, and your on state is kept', async () => {
    const { registry, settings } = await boot(
      base({ display_name: 'Shipped name' }),
      base({ display_name: 'My name', enabled: true }),
    );
    const info = registry.info().find((m) => m.id === 'google/gemini-3.5-flash-lite');
    expect(info).toMatchObject({ display_name: 'Shipped name', status: 'ready' });
    expect(info?.custom).toBeUndefined();
    expect(registry.all().filter((m) => m.id === 'google/gemini-3.5-flash-lite')).toHaveLength(1);
    // The redundant copy is dropped from what is saved, and the choice now lives in the on/off store.
    expect(await settings.get(SETTING.customModels)).toEqual([]);
    expect(await settings.get(SETTING.watchAdded)).toEqual([]);
    expect(await settings.get(SETTING.modelEnabled)).toEqual({ 'google/gemini-3.5-flash-lite': true });
    await registry.refresh(); // and a second boot finds nothing more to do
    expect(registry.info().find((m) => m.id === 'google/gemini-3.5-flash-lite')?.status).toBe('ready');
  });

  it('a choice already in the on/off store is never overwritten, and an off copy stays off', async () => {
    const a = await boot(base(), base({ enabled: true }), { 'google/gemini-3.5-flash-lite': false });
    expect(a.registry.info().find((m) => m.id === 'google/gemini-3.5-flash-lite')?.status).toBe('disabled');
    const b = await boot(base({ enabled: true }), base({ enabled: false }));
    expect(b.registry.info().find((m) => m.id === 'google/gemini-3.5-flash-lite')?.status).toBe('disabled');
  });
});

describe('models.yaml itself', () => {
  it('refuses an id listed twice and names which entry', () => {
    const m = shipped[0] as ModelConfig;
    const r = ModelsFile.safeParse({ version: 1, models: [m, { ...m, display_name: 'again' }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['models', 1, 'id']);
  });

  it('ships no id twice and no :free OpenRouter endpoint', () => {
    expect(new Set(shipped.map((m) => m.id)).size).toBe(shipped.length);
    expect(shipped.filter((m) => m.provider_model.endsWith(':free'))).toEqual([]);
  });
});
