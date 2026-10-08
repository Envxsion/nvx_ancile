/**
 * ------------------------------------------------------------------
 *  Title    |  Add a model
 *  Ref      |  DESIGN.md §16.7 · Settings → Models · flow model picker
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Any model from anywhere: browse OpenRouter's catalogue,
 *           |  point at your own OpenAI-compatible server (vLLM on a
 *           |  RunPod pod, LM Studio, a box on your network), or type a
 *           |  provider's model id.
 *  How      |  Core lists and adds (POST /models/catalogue, /models).
 *           |  A server's key is sent once and kept encrypted by Core;
 *           |  it is never shown again. OpenRouter needs its key for
 *           |  answers, not for browsing: when the first OpenRouter
 *           |  model lands without one, the dialog asks for it.
 * ------------------------------------------------------------------
 */

import type { CatalogueModel, ModelInfo, ModelSource } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Segmented } from '../ui/controls';
import { Icon } from '../ui/Icon';

type Tab = 'openrouter' | 'server' | 'direct';

/** Open the dialog from anywhere (Settings, the flow editor's model picker). */
export const useAddModel = create<{
  open: boolean;
  tab: Tab;
  /** Called with the new model's id once it is added. */
  onAdded: ((id: string) => void) | null;
  show: (tab?: Tab, onAdded?: (id: string) => void) => void;
  hide: () => void;
}>((set) => ({
  open: false,
  tab: 'openrouter',
  onAdded: null,
  show: (tab = 'openrouter', onAdded) => set({ open: true, tab, onAdded: onAdded ?? null }),
  hide: () => set({ open: false, onAdded: null }),
}));

const price = (m: CatalogueModel) =>
  m.price
    ? m.price.input_per_mtok === 0 && m.price.output_per_mtok === 0
      ? 'Free'
      : `$${m.price.input_per_mtok} in · $${m.price.output_per_mtok} out per M`
    : null;

const ctx = (n: number | null) =>
  n ? `${n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`} context` : null;

function errorText(e: unknown, what: string): { title: string; body?: string } {
  if (e instanceof ApiCallError) return { title: e.body.error.title, body: e.body.error.hint };
  return { title: `${what} didn't reach Core`, body: 'Check that NVX Ancile is running, then try again.' };
}

async function addModel(body: Record<string, unknown>): Promise<ModelInfo | null> {
  try {
    const m = await api.post<ModelInfo>('/models', body);
    void queryClient.invalidateQueries({ queryKey: keys.models });
    notify({
      level: 'success',
      title: `Added ${m.display_name}`,
      body: 'It is in the model switcher and every flow picker.',
    });
    return m;
  } catch (e) {
    notify({ level: 'error', ...errorText(e, 'Adding the model') });
    return null;
  }
}

function Catalogue({
  items,
  busy,
  onAdd,
}: {
  items: CatalogueModel[];
  busy: string | null;
  onAdd: (m: CatalogueModel) => void;
}) {
  if (!items.length) return <p className="mute add-model__empty">No models match.</p>;
  return (
    <ul className="add-model__list">
      {items.slice(0, 200).map((m) => (
        <li key={m.provider_model} className="add-model__row">
          <div className="add-model__info">
            <span className="add-model__name">{m.display_name}</span>
            <span className="add-model__meta mute">
              <code>{m.provider_model}</code>
              {[ctx(m.context_window), price(m)].filter(Boolean).map((t) => (
                <span key={t}> · {t}</span>
              ))}
            </span>
            {m.capabilities.length ? (
              <span className="add-model__caps">
                {m.capabilities.map((c) => (
                  <span key={c} className="tag">
                    {c}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
          {m.added ? (
            <span className="add-model__added">
              <Icon name="check" size={13} /> Added
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy !== null}
              onClick={() => onAdd(m)}
            >
              {busy === m.provider_model ? 'Adding…' : 'Add'}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function OpenRouterTab({ done }: { done: (m: ModelInfo) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CatalogueModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .post<{ items: CatalogueModel[] }>('/models/catalogue', { source: 'openrouter' })
      .then((r) => live && setItems(r.items))
      .catch((e) => live && setError(errorText(e, 'The catalogue').title));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (items ?? []).filter((m) =>
      terms.every((t) => `${m.provider_model} ${m.display_name}`.toLowerCase().includes(t)),
    );
  }, [items, q]);

  const add = async (m: CatalogueModel) => {
    setBusy(m.provider_model);
    const added = await addModel({ source: 'openrouter', provider_model: m.provider_model });
    setBusy(null);
    if (!added) return;
    setItems(
      (all) => all?.map((x) => (x.provider_model === m.provider_model ? { ...x, added: true } : x)) ?? null,
    );
    if (added.status === 'needs_key') setNeedKey(true);
    done(added);
  };

  const saveKey = async () => {
    setSaving(true);
    try {
      await api.post('/setup/providers/test', { provider: 'openrouter', key: key.trim(), save: true });
      void queryClient.invalidateQueries({ queryKey: keys.models });
      notify({
        level: 'success',
        title: 'OpenRouter is connected',
        body: 'Your OpenRouter models can answer now.',
      });
      setNeedKey(false);
      setKey('');
    } catch (e) {
      notify({ level: 'error', ...errorText(e, 'The key test') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="add-model__pane">
      {needKey ? (
        <form
          className="add-model__key"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void saveKey();
          }}
        >
          <span className="add-model__key-title">Add your OpenRouter key so these models can answer</span>
          <span className="mute">
            Create one at openrouter.ai/keys. It is tested once, then kept encrypted on this machine.
          </span>
          <div className="add-model__key-row">
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder="sk-or-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-label="OpenRouter API key"
            />
            <button type="submit" className="btn btn--primary btn--sm" disabled={!key.trim() || saving}>
              {saving ? 'Testing…' : 'Test and save'}
            </button>
          </div>
        </form>
      ) : null}
      <label className="add-model__search">
        <Icon name="search" size={14} />
        <input
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to search
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search OpenRouter: llama, deepseek, qwen coder…"
          aria-label="Search OpenRouter models"
        />
      </label>
      {error ? (
        <p className="add-model__error">
          <Icon name="alert" size={13} /> {error} You can still add a model by its id under "A provider".
        </p>
      ) : items === null ? (
        <p className="mute add-model__empty">Loading the catalogue…</p>
      ) : (
        <Catalogue items={shown} busy={busy} onAdd={(m) => void add(m)} />
      )}
    </div>
  );
}

function ServerTab({ done }: { done: (m: ModelInfo) => void }) {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [items, setItems] = useState<CatalogueModel[] | null>(null);
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const valid = /^https?:\/\/\S+/i.test(url.trim());

  const list = async () => {
    setListing(true);
    try {
      const r = await api.post<{ items: CatalogueModel[] }>('/models/catalogue', {
        source: 'openai-compatible',
        base_url: url.trim(),
        ...(key.trim() && { api_key: key.trim() }),
      });
      setItems(r.items);
    } catch (e) {
      notify({ level: 'error', ...errorText(e, 'Listing the models') });
    } finally {
      setListing(false);
    }
  };

  const add = async (providerModel: string, contextWindow?: number | null) => {
    setBusy(providerModel);
    const added = await addModel({
      source: 'openai-compatible',
      base_url: url.trim(),
      provider_model: providerModel,
      ...(key.trim() && { api_key: key.trim() }),
      ...(contextWindow && { context_window: contextWindow }),
    });
    setBusy(null);
    if (!added) return;
    setItems(
      (all) => all?.map((x) => (x.provider_model === providerModel ? { ...x, added: true } : x)) ?? null,
    );
    done(added);
  };

  return (
    <div className="add-model__pane">
      <p className="mute add-model__lede">
        Any server that speaks the OpenAI API: vLLM on a RunPod pod (its proxy URL), LM Studio, Ollama, or a
        machine on your network.
      </p>
      <label className="field">
        <span>Base URL</span>
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://abc123-8000.proxy.runpod.net/v1"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>API key (if it needs one)</span>
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Kept encrypted; never shown again"
        />
      </label>
      <div className="add-model__actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!valid || listing}
          onClick={() => void list()}
        >
          <Icon name="search" size={13} />
          {listing ? 'Asking the server…' : 'List its models'}
        </button>
      </div>
      {items ? (
        <Catalogue items={items} busy={busy} onAdd={(m) => void add(m.provider_model, m.context_window)} />
      ) : null}
      <form
        className="add-model__manual"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && manual.trim()) void add(manual.trim());
        }}
      >
        <input
          className="input"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Or type the model id it serves"
          spellCheck={false}
          aria-label="Model id"
        />
        <button
          type="submit"
          className="btn btn--ghost btn--sm"
          disabled={!valid || !manual.trim() || busy !== null}
        >
          Add
        </button>
      </form>
    </div>
  );
}

const DIRECT: {
  value: Exclude<ModelSource, 'openrouter' | 'openai-compatible'>;
  label: string;
  hint: string;
}[] = [
  { value: 'anthropic', label: 'Anthropic', hint: 'claude-opus-5-5, or a dated id' },
  { value: 'openai', label: 'OpenAI', hint: 'gpt-5.5, o-series…' },
  { value: 'google', label: 'Google', hint: 'gemini-3-pro…' },
];

function DirectTab({ done }: { done: (m: ModelInfo) => void }) {
  const [source, setSource] = useState<(typeof DIRECT)[number]['value']>('anthropic');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = DIRECT.find((d) => d.value === source);
  const add = async () => {
    setBusy(true);
    const added = await addModel({
      source,
      provider_model: id.trim(),
      ...(name.trim() && { display_name: name.trim() }),
    });
    setBusy(false);
    if (added) {
      setId('');
      setName('');
      done(added);
    }
  };
  return (
    <form
      className="add-model__pane"
      onSubmit={(e) => {
        e.preventDefault();
        if (id.trim()) void add();
      }}
    >
      <p className="mute add-model__lede">
        A model id beyond the defaults, used with that provider's key from Settings. Your Claude or ChatGPT
        subscription can't be used here: those providers only offer models to other apps through API keys.
      </p>
      <Segmented
        label="Provider"
        value={source}
        options={DIRECT.map((d) => ({ value: d.value, label: d.label }))}
        onChange={setSource}
      />
      <label className="field">
        <span>Model id</span>
        <input
          className="input"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder={meta?.hint}
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Name (optional)</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="How it shows in pickers"
        />
      </label>
      <div className="add-model__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!id.trim() || busy}>
          {busy ? 'Adding…' : 'Add model'}
        </button>
      </div>
    </form>
  );
}

/** The dialog itself; mount once (AdminModels and the flow editor both render it). */
export function AddModelDialog() {
  const open = useAddModel((s) => s.open);
  const tab = useAddModel((s) => s.tab);
  const hide = useAddModel((s) => s.hide);
  const [current, setCurrent] = useState<Tab>(tab);
  useLayer(open);
  useEffect(() => {
    if (open) setCurrent(tab);
  }, [open, tab]);
  const done = (m: ModelInfo) => useAddModel.getState().onAdded?.(m.id);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && hide()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog add-model m-glass-thick" aria-describedby="add-model-desc">
          <header className="dialog__head">
            <Dialog.Title className="dialog__title">Add a model</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close">
                <Icon name="close" size={14} />
              </button>
            </Dialog.Close>
          </header>
          <p id="add-model-desc" className="dialog__lede">
            Added models appear in the model switcher, in routing, and in every flow's model picker.
          </p>
          <Segmented
            label="Where it comes from"
            value={current}
            options={[
              { value: 'openrouter', label: 'OpenRouter', icon: 'globe' },
              { value: 'server', label: 'Your server', icon: 'node' },
              { value: 'direct', label: 'A provider', icon: 'key' },
            ]}
            onChange={setCurrent}
          />
          {current === 'openrouter' ? (
            <OpenRouterTab done={done} />
          ) : current === 'server' ? (
            <ServerTab done={done} />
          ) : (
            <DirectTab done={done} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
