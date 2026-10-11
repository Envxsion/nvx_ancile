/**
 * ------------------------------------------------------------------
 *  Title    |  Edit and remove a model
 *  Ref      |  DESIGN.md §16.7 · Admin → Models
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The "⋯" menu on a model row: edit it, switch it on or
 *           |  off, and remove a model you added.
 *  How      |  PATCH /models/:id with only what changed. A model from
 *           |  models.yaml takes its colour and on/off here; the rest
 *           |  lives in the file. Removing asks first, then offers Undo
 *           |  (POST /models/restore), which brings the model and its
 *           |  key back without the key ever reaching the browser.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { type CSSProperties, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { hueVar } from '../lib/format';
import { queryClient } from '../lib/query';
import type { Hue, ModelView } from '../lib/types';
import { notify } from '../state/notify';
import { type ConfirmCopy, ConfirmDialog } from '../ui/Confirm';
import { Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';

export const MODEL_HUES: Hue[] = ['azure', 'jade', 'amber', 'coral', 'magenta', 'cyan', 'chalk'];

function failed(e: unknown, what: string) {
  notify({
    level: 'error',
    title: e instanceof ApiCallError ? e.body.error.title : `${what} failed`,
    body: e instanceof ApiCallError ? e.body.error.hint : 'Check that NVX Ancile is running, then try again.',
  });
}

const refresh = () => queryClient.invalidateQueries({ queryKey: keys.models });

/** The body of a PATCH: only the fields that changed. Exported for tests. */
export function modelPatch(
  m: ModelView,
  f: {
    name: string;
    context: string;
    enabled: boolean;
    hue: Hue | null;
    baseUrl: string;
    keyName: string;
    newKey: string;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const enabled = m.status !== 'disabled';
  if (f.enabled !== enabled) out.enabled = f.enabled;
  if (f.hue !== (m.chosenHue ?? null)) out.hue = f.hue;
  if (!m.custom) return out;
  const name = f.name.trim();
  if (name && name !== m.name) out.display_name = name;
  const ctx = Number(f.context);
  if (f.context.trim() && Number.isInteger(ctx) && ctx > 0 && ctx !== m.contextWindow)
    out.context_window = ctx;
  if (m.baseUrl) {
    const url = f.baseUrl.trim();
    if (url && url !== m.baseUrl) out.base_url = url;
    const key = f.keyName.trim();
    if (key !== (m.keyName ?? '')) out.secret = key || null;
    if (f.newKey.trim()) out.api_key = f.newKey.trim();
  }
  return out;
}

/** Mounted only while editing, so a background refresh never resets what you typed. */
function EditModelDialog({ model, onClose }: { model: ModelView; onClose: () => void }) {
  useLayer(true);
  const [name, setName] = useState(model.name);
  const [context, setContext] = useState(String(model.contextWindow));
  const [enabled, setEnabled] = useState(model.status !== 'disabled');
  const [hue, setHue] = useState<Hue | null>(model.chosenHue ?? null);
  const [baseUrl, setBaseUrl] = useState(model.baseUrl ?? '');
  const [keyName, setKeyName] = useState(model.keyName ?? '');
  const [newKey, setNewKey] = useState('');

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/models/${model.id}`, body),
    onSuccess: () => {
      void refresh();
      notify({ level: 'success', title: `Saved ${name.trim() || model.name}` });
      onClose();
    },
    onError: (e) => failed(e, 'Saving the model'),
  });

  const submit = () => {
    const body = modelPatch(model, { name, context, enabled, hue, baseUrl, keyName, newKey });
    if (!Object.keys(body).length) return onClose();
    save.mutate(body);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick edit-model" aria-describedby="edit-model-desc">
          <Dialog.Title className="dialog__title">Edit {model.name}</Dialog.Title>
          <p id="edit-model-desc" className="dialog__lede">
            {model.custom
              ? 'Changes apply to the next answer, everywhere this model can be chosen.'
              : 'This model comes from config/models.yaml. Change its name and context there; its colour and whether it is on are yours to set here.'}
          </p>
          <form
            className="edit-model__form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {model.custom ? (
              <>
                <label className="field">
                  <span>Name</span>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    required
                    // biome-ignore lint/a11y/noAutofocus: the dialog opens to its first field
                    autoFocus
                  />
                </label>
                <label className="field">
                  <span>Context window (tokens)</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            <fieldset className="field">
              <legend>Colour</legend>
              <div className="edit-model__hues" role="radiogroup" aria-label="Colour">
                <button
                  type="button"
                  role="radio"
                  aria-checked={hue === null}
                  className="btn btn--ghost btn--sm"
                  onClick={() => setHue(null)}
                >
                  Follow the family
                </button>
                {MODEL_HUES.map((h) => (
                  <button
                    key={h}
                    type="button"
                    role="radio"
                    aria-checked={hue === h}
                    aria-label={h}
                    className="new-nb__hue"
                    style={{ '--hue': hueVar(h) } as CSSProperties}
                    onClick={() => setHue(h)}
                  />
                ))}
              </div>
            </fieldset>
            <div className="field edit-model__switch">
              <span>On</span>
              <Switch
                checked={enabled}
                onChange={setEnabled}
                label={enabled ? 'On: routing and pickers can use it' : 'Off: nothing uses it'}
              />
            </div>
            {model.custom && model.baseUrl ? (
              <>
                <label className="field">
                  <span>Server address</span>
                  <input
                    className="input input--mono"
                    type="url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    spellCheck={false}
                  />
                  <span className="field__hint">The OpenAI base address, ending in /v1.</span>
                </label>
                <label className="field">
                  <span>Key name</span>
                  <input
                    className="input input--mono"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value.toUpperCase())}
                    placeholder="No key"
                    spellCheck={false}
                  />
                  <span className="field__hint">
                    A key already stored in NVX Ancile, by name. Leave it empty for a server that needs no
                    key.
                  </span>
                </label>
                <label className="field">
                  <span>Replace the key</span>
                  <input
                    className="input input--mono"
                    type="password"
                    autoComplete="off"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="Leave empty to keep it"
                  />
                  <span className="field__hint">Kept encrypted by Core and never shown again.</span>
                </label>
              </>
            ) : null}
            <div className="dialog__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={save.isPending}>
                {save.isPending ? 'Saving' : 'Save changes'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Undo a removal. A plain call: the row it came from is gone by now. */
export async function restoreModel(m: Pick<ModelView, 'id' | 'name'>): Promise<void> {
  try {
    await api.post('/models/restore', { id: m.id });
    void refresh();
    notify({ level: 'success', title: `${m.name} is back` });
  } catch (e) {
    failed(e, 'Undoing the removal');
  }
}

/** The "⋯" on a model row. */
export function ModelMenu({ model }: { model: ModelView }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmCopy | null>(null);
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.put(`/models/${model.id}`, { enabled: on }),
    onSuccess: () => refresh(),
    onError: (e) => failed(e, 'Changing the model'),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/models/${model.id}`),
    onSuccess: () => {
      void refresh();
      notify({ level: 'info', title: `Removed ${model.name}`, undo: () => void restoreModel(model) });
    },
    onError: (e) => failed(e, 'Removing the model'),
  });
  const off = model.status === 'disabled';
  const items: MenuEntry[] = [
    { label: 'Edit', icon: 'edit', onSelect: () => setEditing(true) },
    ...(model.offline
      ? []
      : [
          {
            label: off ? 'Turn on' : 'Turn off',
            icon: off ? ('play' as const) : ('stop' as const),
            disabled: toggle.isPending,
            onSelect: () => toggle.mutate(off),
          },
        ]),
    ...(model.custom
      ? [
          { kind: 'separator' as const },
          {
            label: 'Remove',
            icon: 'trash' as const,
            danger: true,
            disabled: remove.isPending,
            onSelect: () =>
              setConfirm({
                title: `Remove ${model.name}?`,
                body: model.baseUrl
                  ? 'Routing, pickers and flows stop offering it. Its stored key goes too, unless another model uses it. You can undo this for ten minutes.'
                  : 'Routing, pickers and flows stop offering it. Threads that used it keep their answers. You can undo this for ten minutes.',
                action: 'Remove model',
              }),
          },
        ]
      : []),
  ];
  return (
    <>
      <DropMenu
        items={items}
        trigger={
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`More for ${model.name}`}>
            <Icon name="more" size={15} />
          </button>
        }
      />
      {editing ? <EditModelDialog model={model} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog copy={confirm} onConfirm={() => remove.mutate()} onClose={() => setConfirm(null)} />
    </>
  );
}
