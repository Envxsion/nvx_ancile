/**
 * ------------------------------------------------------------------
 *  Title    |  Routing controls
 *  Ref      |  docs/openrouter.md (Routing presets)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Choose how an OpenRouter model picks its provider, in
 *           |  plain words, with every OpenRouter field one click away
 *           |  and a live note of what the choice sends and turns off.
 *  How      |  RoutingControls is controlled (a flow step keeps the
 *           |  value in its params). RoutingOverrideEditor loads and
 *           |  saves one for a model, notebook or thread. The preview
 *           |  is Core's own build (POST /openrouter/routing/preview),
 *           |  so what is shown is what is sent.
 * ------------------------------------------------------------------
 */

import {
  type OrProviderObject,
  OrQuantization,
  type RoutingScope,
  type RoutingSettings,
} from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { DEFAULT_ROUTING, OR_KEYS, PRESETS, previewRouting, saveRouting, useRoutingOverride } from './api';
import { openExplainer } from './EndpointExplorer';

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const ADVANCED_HELP: Record<string, string> = {
  order: 'Providers to try first, in this order.',
  only: 'Use these providers and no others.',
  ignore: 'Never use these providers.',
  allow_fallbacks: 'When the chosen providers fail, let OpenRouter try others.',
  require_parameters: 'Only providers that support every setting in the request (tools, max tokens).',
  data_collection: 'Deny keeps out providers that may store or train on prompts.',
  zdr: 'Only providers that keep nothing at all (zero data retention).',
  quantizations: 'Only endpoints running at these precisions.',
  sort: 'Rank by price, speed or latency. Sorting by price turns Auto Exacto off.',
  max_price: 'Never pay more than this per million tokens.',
};

function AdvancedPanel({
  value,
  onChange,
}: {
  value: OrProviderObject;
  onChange: (v: OrProviderObject) => void;
}) {
  const id = useId();
  const set = (patch: Partial<OrProviderObject>) => {
    const next: Record<string, unknown> = { ...value, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as OrProviderObject);
  };
  const text = (k: 'order' | 'only' | 'ignore') => (
    <label className="or-field" key={k}>
      <span className="or-field__label">{k}</span>
      <input
        className="input"
        defaultValue={(value[k] ?? []).join(', ')}
        placeholder="DeepInfra, Together"
        onBlur={(e) => set({ [k]: list(e.target.value).length ? list(e.target.value) : undefined })}
      />
      <span className="or-field__help">{ADVANCED_HELP[k]}</span>
    </label>
  );
  return (
    <fieldset className="or-advanced">
      <legend>Every OpenRouter provider field</legend>
      {text('order')}
      {text('only')}
      {text('ignore')}
      {(['allow_fallbacks', 'require_parameters', 'zdr'] as const).map((k) => (
        <div className="or-field or-field--switch" key={k}>
          <span className="or-field__label">{k}</span>
          <Switch
            checked={value[k] ?? k === 'allow_fallbacks'}
            onChange={(on: boolean) => set({ [k]: on })}
            label={k}
          />
          <span className="or-field__help">{ADVANCED_HELP[k]}</span>
        </div>
      ))}
      <label className="or-field">
        <span className="or-field__label">data_collection</span>
        <select
          className="input"
          value={value.data_collection ?? 'allow'}
          onChange={(e) => set({ data_collection: e.target.value === 'deny' ? 'deny' : undefined })}
        >
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
        <span className="or-field__help">{ADVANCED_HELP.data_collection}</span>
      </label>
      <label className="or-field">
        <span className="or-field__label">sort</span>
        <select
          className="input"
          value={value.sort ?? ''}
          onChange={(e) => set({ sort: (e.target.value || undefined) as OrProviderObject['sort'] })}
        >
          <option value="">none (OpenRouter balances)</option>
          <option value="price">price</option>
          <option value="throughput">throughput</option>
          <option value="latency">latency</option>
        </select>
        <span className="or-field__help">{ADVANCED_HELP.sort}</span>
      </label>
      <div className="or-field" role="group" aria-labelledby={`${id}-q`}>
        <span className="or-field__label" id={`${id}-q`}>
          quantizations
        </span>
        <div className="or-chips">
          {OrQuantization.options.map((q) => {
            const on = value.quantizations?.includes(q) ?? false;
            return (
              <button
                key={q}
                type="button"
                className="btn btn--sm btn--ghost"
                aria-pressed={on}
                onClick={() => {
                  const cur = new Set(value.quantizations ?? []);
                  if (on) cur.delete(q);
                  else cur.add(q);
                  set({ quantizations: cur.size ? [...cur] : undefined });
                }}
              >
                {q}
              </button>
            );
          })}
        </div>
        <span className="or-field__help">{ADVANCED_HELP.quantizations}</span>
      </div>
      <div className="or-field">
        <span className="or-field__label">max_price</span>
        <div className="or-row">
          {(['prompt', 'completion'] as const).map((k) => (
            <input
              key={k}
              className="input"
              type="number"
              min={0}
              step="0.01"
              aria-label={`Most per million ${k === 'prompt' ? 'input' : 'output'} tokens, in dollars`}
              placeholder={k === 'prompt' ? 'Input $/M' : 'Output $/M'}
              defaultValue={value.max_price?.[k] ?? ''}
              onBlur={(e) => {
                const n = e.target.value === '' ? undefined : Number(e.target.value);
                const mp = { ...(value.max_price ?? {}), [k]: n };
                if (mp[k] === undefined) delete mp[k];
                set({ max_price: Object.keys(mp).length ? mp : undefined });
              }}
            />
          ))}
        </div>
        <span className="or-field__help">{ADVANCED_HELP.max_price}</span>
      </div>
    </fieldset>
  );
}

export function RoutingControls({
  model,
  modelId,
  value,
  onChange,
  providers = [],
}: {
  /** The OpenRouter id, e.g. qwen/qwen3-coder. */
  model: string;
  modelId?: string;
  value: RoutingSettings;
  onChange: (next: RoutingSettings) => void;
  /** Provider names to offer for Pinned (from the endpoint list). */
  providers?: string[];
}) {
  const group = useId();
  const preview = useQuery({
    queryKey: ['openrouter', 'preview', model, modelId ?? '', JSON.stringify(value)],
    queryFn: () => previewRouting(model, value, modelId),
    staleTime: 60_000,
  });
  const set = (patch: Partial<RoutingSettings>) => onChange({ ...value, ...patch });
  const chosen = PRESETS.find((p) => p.value === value.preset);
  return (
    <section className="or-section" aria-label="How this model picks a provider">
      <div className="or-presets" role="radiogroup" aria-labelledby={`${group}-l`}>
        <span id={`${group}-l`} className="or-field__label">
          How it picks a provider
        </span>
        {PRESETS.map((p) => (
          <label key={p.value} className="or-preset" data-on={value.preset === p.value ? '' : undefined}>
            <input
              type="radio"
              name={group}
              value={p.value}
              checked={value.preset === p.value}
              onChange={() => set({ preset: p.value })}
            />
            <span className="or-preset__name">{p.label}</span>
            <span className="or-preset__blurb">{p.blurb}</span>
          </label>
        ))}
      </div>
      {value.preset === 'pinned' ? (
        <label className="or-field">
          <span className="or-field__label">Providers, in order</span>
          <input
            className="input"
            defaultValue={value.providers.join(', ')}
            placeholder={providers.slice(0, 2).join(', ') || 'DeepInfra, Together'}
            onBlur={(e) => set({ providers: list(e.target.value) })}
          />
          {providers.length ? (
            <span className="or-field__help">Serving this model: {providers.join(', ')}</span>
          ) : null}
        </label>
      ) : null}
      {value.preset === 'advanced' ? (
        <AdvancedPanel value={value.advanced ?? {}} onChange={(advanced) => set({ advanced })} />
      ) : null}
      <div className="or-row or-row--wrap">
        <label className="or-field">
          <span className="or-field__label">Longest answer, in tokens</span>
          <input
            className="input"
            type="number"
            min={1}
            placeholder="The model's own"
            defaultValue={value.max_tokens ?? ''}
            onBlur={(e) =>
              set({ max_tokens: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null })
            }
          />
        </label>
        <label className="or-field">
          <span className="or-field__label">Lowest precision</span>
          <select
            className="input"
            value={value.min_precision ?? ''}
            onChange={(e) =>
              set({ min_precision: (e.target.value || null) as RoutingSettings['min_precision'] })
            }
          >
            <option value="">Any</option>
            <option value="fp4">FP4</option>
            <option value="fp8">FP8</option>
            <option value="bf16">BF16</option>
          </select>
        </label>
        <div className="or-field or-field--switch">
          <span className="or-field__label">Do not allow data collection</span>
          <Switch
            checked={value.deny_data_collection}
            onChange={(on: boolean) => set({ deny_data_collection: on })}
            label="Do not allow data collection"
          />
        </div>
      </div>
      <div className="or-preview" aria-live="polite">
        {chosen && !chosen.exacto && value.preset !== 'advanced' ? (
          <p className="or-preview__exacto">
            Auto Exacto is off with this choice: OpenRouter no longer picks the providers that handle tool
            calls best.{' '}
            <button type="button" className="link-btn" onClick={openExplainer}>
              What that means
            </button>
          </p>
        ) : null}
        {preview.data ? (
          <>
            {value.preset === 'advanced' && !preview.data.auto_exacto ? (
              <p className="or-preview__exacto">Auto Exacto is off with these fields.</p>
            ) : null}
            <ul>
              {preview.data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <details>
              <summary>What is sent</summary>
              <pre className="or-code">
                {JSON.stringify(
                  { provider: preview.data.provider, max_tokens: preview.data.max_tokens },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** Load, edit and save the routing for one model, notebook or thread. */
export function RoutingOverrideEditor({
  scope,
  id,
  model,
  modelId,
  providers,
}: {
  scope: RoutingScope;
  id: string;
  model: string;
  modelId?: string;
  providers?: string[];
}) {
  const q = useRoutingOverride(scope, id);
  const [draft, setDraft] = useState<RoutingSettings | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data.settings ?? DEFAULT_ROUTING);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (s: RoutingSettings | null) => saveRouting(scope, id, s),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OR_KEYS.routing(scope, id) });
      notify({ level: 'success', title: 'Routing saved' });
    },
    onError: () => notify({ level: 'error', title: 'Routing was not saved', body: 'Try again.' }),
  });
  if (!draft) return null;
  const where = scope === 'model' ? 'this model' : scope === 'notebook' ? 'this notebook' : 'this thread';
  return (
    <div className="or-editor">
      <RoutingControls
        model={model}
        {...(modelId && { modelId })}
        value={draft}
        onChange={setDraft}
        {...(providers && { providers })}
      />
      <div className="dialog__actions">
        {q.data?.settings ? (
          <button type="button" className="btn btn--ghost" onClick={() => save.mutate(null)}>
            Use the default
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--primary"
          disabled={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          Save for {where}
        </button>
      </div>
    </div>
  );
}
