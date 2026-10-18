/**
 * A small world for the model watch tests: an Anthropic key, three Claude
 * models in the catalogue, a list the test can change, a clock it can move
 * and timers it can fire.
 */
import type { ModelConfig } from '@nvx/contracts';
import { ModelRegistry } from '../../../src/gateway/registry';
import { ModelWatch, type TestCall, type Timers } from '../../../src/models/watch/service';
import { MemoryWatchStore } from '../../../src/models/watch/store';
import { MemorySecretStore, SecretBox } from '../../../src/secrets';
import { MemorySettings } from '../../../src/settings';

export const claude = (id: string, pm: string, over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: `anthropic/${id}`,
  provider: 'anthropic',
  provider_model: pm,
  display_name: id,
  via: 'direct',
  family: 'anthropic',
  context_window: 200_000,
  max_output: 64_000,
  capabilities: ['tools', 'vision', 'reasoning', 'json'],
  price: { input_per_mtok: 2, output_per_mtok: 10 },
  enabled: true,
  secret: 'ANTHROPIC_API_KEY',
  ...over,
});

export const CATALOGUE = [
  claude('claude-opus-5-5', 'claude-opus-5-5'),
  claude('claude-sonnet-5-5', 'claude-sonnet-5-5'),
  claude('claude-haiku-4-5', 'claude-haiku-4-5-20251001'),
];

export const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  display_name: id,
  max_input_tokens: 200_000,
  max_tokens: 64_000,
  capabilities: {
    image_input: { supported: true },
    structured_outputs: { supported: true },
    thinking: { supported: true },
  },
  ...over,
});

export class FakeClock {
  t = Date.parse('2026-10-18T10:00:00.000Z');
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeTimers implements Timers {
  timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
  setTimeout(fn: () => void, ms: number) {
    const h = { fn, ms, cleared: false };
    this.timeouts.push(h);
    return h;
  }
  clearTimeout(h: unknown) {
    (h as { cleared: boolean }).cleared = true;
  }
  setInterval(fn: () => void, ms: number) {
    const h = { fn, ms, cleared: false };
    this.intervals.push(h);
    return h;
  }
  clearInterval(h: unknown) {
    (h as { cleared: boolean }).cleared = true;
  }
}

export interface World {
  registry: ModelRegistry;
  watch: ModelWatch;
  store: MemoryWatchStore;
  settings: MemorySettings;
  secrets: MemorySecretStore;
  clock: FakeClock;
  timers: FakeTimers;
  events: { type: string; what: string; unseen: number }[];
  /** The Anthropic list the fake provider answers with. */
  anthropic: { data: Record<string, unknown>[]; fail?: number };
  /** URLs and headers of every list call. */
  calls: { url: string; headers: Record<string, string> }[];
  /** OpenRouter's public list. */
  openrouter: { data: Record<string, unknown>[]; fail?: boolean };
  tested: ModelConfig[];
  testResult: { ok: boolean; detail: string | null };
}

export async function world(
  opts: { models?: ModelConfig[]; taskClasses?: Record<string, string[]>; keys?: string[] } = {},
): Promise<World> {
  const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
  for (const k of opts.keys ?? ['ANTHROPIC_API_KEY']) await secrets.set(k, 'sk-test-secret');
  const settings = new MemorySettings();
  const registry = new ModelRegistry({
    models: opts.models ?? CATALOGUE,
    taskClasses: opts.taskClasses ?? { 'chat.default': ['anthropic/sonnet:latest'] },
    secrets,
    settings,
    offline: false,
  });
  await registry.refresh();
  const store = new MemoryWatchStore();
  const clock = new FakeClock();
  const timers = new FakeTimers();
  const w: World = {
    registry,
    store,
    settings,
    secrets,
    clock,
    timers,
    events: [],
    anthropic: { data: [] },
    calls: [],
    openrouter: { data: [] },
    tested: [],
    testResult: { ok: true, detail: null },
    watch: undefined as unknown as ModelWatch,
  };
  const testCall: TestCall = async (m) => {
    w.tested.push(m);
    return w.testResult;
  };
  let n = 0;
  w.watch = new ModelWatch({
    registry,
    store,
    settings,
    secrets,
    testCall,
    now: clock.now,
    timers,
    newId: () => `mchg_${String(++n).padStart(4, '0')}`,
    bundledPricesDate: '2026-10-16',
    publish: (e) => {
      w.events.push(e);
    },
    get: async (url, headers) => {
      w.calls.push({ url, headers });
      if (url.startsWith('https://openrouter.ai/')) {
        if (w.openrouter.fail) throw Object.assign(new Error('down'), { status: 503 });
        return { data: w.openrouter.data };
      }
      if (w.anthropic.fail) throw Object.assign(new Error('nope'), { status: w.anthropic.fail });
      return { data: w.anthropic.data, has_more: false };
    },
  });
  return w;
}
