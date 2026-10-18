/**
 * ------------------------------------------------------------------
 *  Title    |  Pickers list only real models
 *  Ref      |  docs/models.md (Which models a picker offers)
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Every picker offers only models that can answer now: a
 *           |  model that needs its key, is switched off or is not in
 *           |  Ollama is never offered, and Admin → Models still lists
 *           |  it with what it needs. The test models (no AI) follow
 *           |  the "Keep test models" setting, as before.
 * ------------------------------------------------------------------
 */

import type { RoutingChain } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { AddNode } from '../src/flows/AddNode';
import { ModelPicker } from '../src/flows/fields';
import type { FlowModel } from '../src/flows/models';
import { api } from '../src/lib/api';
import { canAnswer, keys, pickable, useModels } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import type { ModelView } from '../src/lib/types';
import { RoutingEditor } from '../src/routes/admin/RoutingEditor';
import { usePrefs } from '../src/state/prefs';

const mocked = api as unknown as Record<'get' | 'put', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const model = (p: Partial<ModelView> & Pick<ModelView, 'id' | 'name'>): ModelView => ({
  provider: 'x',
  hue: 'azure',
  via: 'direct',
  contextWindow: 100_000,
  status: 'ready',
  chat: true,
  ...p,
});

const SONNET = model({ id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', status: 'needs_key' });
const GEMINI = model({ id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', status: 'disabled' });
const QWEN = model({ id: 'ollama/qwen3-14b', name: 'Qwen3 14B (Ollama)', status: 'not_pulled' });
const LLAMA = model({ id: 'ollama/llama3.2', name: 'llama3.2 (Ollama)' });
const NODE = model({ id: 'node/qwen3-72b', name: 'qwen3-72b (your node)', via: 'controller' });
const OR = model({ id: 'openrouter/qwen__qwen3-coder', name: 'Qwen3 Coder' });
const EMBED = model({ id: 'ollama/nomic-embed-text', name: 'Embeddings', chat: false });
const TRYOUT = model({ id: 'offline/test', name: 'Offline test model', offline: true });
const ALL = [SONNET, GEMINI, QWEN, LLAMA, NODE, OR, EMBED, TRYOUT];

const setKeep = (keep: boolean) =>
  usePrefs.setState((s) => ({
    prefs: { ...s.prefs, advanced: { ...s.prefs.advanced, tryoutModels: keep } },
  }));

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.put.mockReset();
  setKeep(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('what a picker offers', () => {
  it('only models that can answer now; the test models leave once a real one is ready', () => {
    expect(pickable(ALL, false).map((m) => m.id)).toEqual([LLAMA.id, NODE.id, OR.id]);
    // "Keep test models (no AI) in pickers" keeps them.
    expect(pickable(ALL, true).map((m) => m.id)).toEqual([LLAMA.id, NODE.id, OR.id, TRYOUT.id]);
    // Nothing real can answer yet: the test models stay, so there is something to try.
    expect(pickable([SONNET, QWEN, TRYOUT], false).map((m) => m.id)).toEqual([TRYOUT.id]);
    expect(pickable([SONNET, GEMINI], false)).toEqual([]);
    // Demo data carries no status: it can answer.
    expect(canAnswer(model({ id: 'demo/m', name: 'Demo', status: undefined }))).toBe(true);
    expect(canAnswer(undefined)).toBe(false);
  });

  it('useModels() offers the pickable ones; useModels({ all: true }) keeps every model with its state', async () => {
    queryClient.setQueryData(keys.models, ALL);
    const seen: Record<string, string[]> = {};
    function Probe() {
      seen.picked = (useModels().data ?? []).map((m) => m.id);
      seen.all = (useModels({ all: true }).data ?? []).map((m) => m.id);
      return null;
    }
    wrap(<Probe />);
    await waitFor(() => expect(seen.picked).toEqual([LLAMA.id, NODE.id, OR.id]));
    expect(seen.all).toEqual(ALL.map((m) => m.id));
  });
});

describe('Admin → Routing', () => {
  const chain: RoutingChain = {
    task_class: 'chat.default',
    chain: [LLAMA.id],
    ok: true,
    configured: [SONNET.id, LLAMA.id],
    default: [SONNET.id, LLAMA.id],
    custom: false,
  };

  it('a link that cannot answer keeps its name; Add model offers only models that can answer', async () => {
    queryClient.setQueryData(keys.models, ALL);
    mocked.get.mockImplementation(async (path: string) =>
      path === '/routing' ? { items: [chain] } : { items: ALL },
    );
    wrap(<RoutingEditor />);
    const card = (await screen.findByRole('heading', { name: 'chat.default' })).closest(
      'section',
    ) as HTMLElement;
    // The YAML's first model needs its key: listed by name, and skipped.
    expect(within(card).getByText('Claude Sonnet 5.5')).toBeInTheDocument();
    expect(within(card).queryByText('Not one of your models yet')).toBeNull();

    const add = within(card).getByRole('button', { name: /Add model/ });
    add.focus();
    fireEvent.keyDown(add, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const offered = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent?.trim());
    expect(offered).toEqual(['qwen3-72b (your node)', 'Qwen3 Coder']);
  });
});

describe('the flow model picker', () => {
  const flow = (p: Partial<FlowModel> & Pick<FlowModel, 'id' | 'name'>): FlowModel => ({
    provider: 'anthropic',
    family: 'anthropic',
    hue: 'coral',
    via: 'direct',
    window: 200_000,
    maxOutput: 64_000,
    priceIn: 3,
    priceOut: 15,
    status: 'ready',
    billing: { kind: 'key', payer: 'anthropic' },
    offline: false,
    awake: null,
    nodeName: null,
    chat: true,
    ...p,
  });

  it('shows the current choice whatever its state, and offers only models that can answer', async () => {
    // cmdk measures its list; jsdom has no ResizeObserver or scrollIntoView.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView ??= () => {};
    const models = [
      flow({ id: SONNET.id, name: SONNET.name, status: 'needs_key' }),
      flow({ id: GEMINI.id, name: GEMINI.name, provider: 'google', status: 'disabled' }),
      flow({ id: QWEN.id, name: QWEN.name, provider: 'ollama', status: 'not_pulled' }),
      flow({ id: LLAMA.id, name: LLAMA.name, provider: 'ollama' }),
      flow({ id: EMBED.id, name: EMBED.name, provider: 'ollama', chat: false }),
    ];
    const onChange = vi.fn();
    wrap(<ModelPicker label="Model" value={SONNET.id} models={models} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Model' });
    expect(trigger).toHaveTextContent('Claude Sonnet 5.5');
    expect(trigger).toHaveTextContent('needs a key');
    fireEvent.click(trigger);
    const list = await screen.findByRole('listbox');
    const options = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    expect(options.some((o) => o.includes('llama3.2 (Ollama)'))).toBe(true);
    for (const gone of ['Claude Sonnet 5.5', 'Gemini 3 Pro', 'Qwen3 14B (Ollama)', 'Embeddings'])
      expect(options.some((o) => o.includes(gone))).toBe(false);
  });

  it("the flow editor's Add a node lists only models that can answer", () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView ??= () => {};
    const models = [
      flow({ id: SONNET.id, name: SONNET.name, status: 'needs_key' }),
      flow({ id: QWEN.id, name: QWEN.name, provider: 'ollama', status: 'not_pulled' }),
      flow({ id: LLAMA.id, name: LLAMA.name, provider: 'ollama' }),
      flow({ id: EMBED.id, name: EMBED.name, provider: 'ollama', chat: false }),
    ];
    wrap(
      <AddNode
        screen={{ x: 10, y: 10 }}
        fromPort={false}
        models={models}
        blocks={[]}
        hasInput
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Add a node' });
    const input = within(dialog).getByRole('combobox');
    // Models show once you type a name.
    fireEvent.change(input, { target: { value: 'ollama' } });
    expect(dialog).toHaveTextContent('llama3.2 (Ollama)');
    expect(dialog).not.toHaveTextContent('Qwen3 14B (Ollama)');
    expect(dialog).not.toHaveTextContent('Embeddings');
    fireEvent.change(input, { target: { value: 'claude' } });
    expect(dialog).not.toHaveTextContent('Claude Sonnet 5.5');
    expect(dialog).not.toHaveTextContent('needs a key');
  });
});
