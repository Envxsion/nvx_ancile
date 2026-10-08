/**
 * ------------------------------------------------------------------
 *  Title    |  New flow: the template gallery
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Start a flow from a shape that already works, with a
 *           |  preview of each, or from a blank canvas with just the
 *           |  message and the answer.
 *  How      |  Core's templates when it serves them, else the same
 *           |  shapes built in. Creating asks Core; if Core cannot
 *           |  store flows yet, it says so and nothing is pretended.
 *  Note     |  Each shape says whether your models can run it now, and
 *           |  which need a key first, so a first flow does not answer
 *           |  "No model could answer" before anyone has learned why.
 * ------------------------------------------------------------------
 */

import type { Flow, FlowScope, FlowTemplate } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { createFlow, needsCore, useTemplates } from './api';
import { emptyGraph } from './graph';
import { modelOf, newNode } from './kinds';
import { type FlowModel, useFlowModels } from './models';
import { FlowPreview } from './Preview';
import { LOCAL_TEMPLATES } from './templates';

/** The models a shape needs that cannot answer yet, by name. */
function unready(t: FlowTemplate, byId: Map<string, FlowModel>): string[] {
  if (!byId.size) return [];
  const out = new Set<string>();
  for (const n of t.graph.nodes) {
    const id = modelOf(n);
    if (!id) continue;
    const m = byId.get(id);
    if (!m) out.add(id.split('/').pop() ?? id);
    else if (m.status === 'needs_key' || m.status === 'disabled') out.add(m.name);
  }
  return [...out];
}

const BLANK: FlowTemplate = {
  id: 'blank',
  name: 'Blank',
  description: 'Just your message and the answer. Build the rest.',
  graph: {
    ...emptyGraph(),
    nodes: [newNode('input', 'input', { x: 0, y: 0 }), newNode('output', 'output', { x: 660, y: 0 })],
  },
};

export function NewFlowDialog({
  open,
  onOpenChange,
  scope,
  scopeRef,
  defaultName,
  activate,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scope: FlowScope;
  scopeRef: string | null;
  defaultName: string;
  activate: boolean;
  onCreated: (f: Flow) => void;
}) {
  useLayer(open);
  const remote = useTemplates();
  const fromCore = !!remote.data?.length;
  const templates = [BLANK, ...(fromCore ? (remote.data ?? []) : LOCAL_TEMPLATES)];
  const [pick, setPick] = useState('router');
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const chosen = templates.find((t) => t.id === pick) ?? (templates[0] as FlowTemplate);
  const { byId } = useFlowModels();
  const missing = unready(chosen, byId);

  const create = async () => {
    setBusy(true);
    try {
      const f = await createFlow({
        name: name.trim() || chosen.name,
        description: chosen.id === 'blank' ? '' : chosen.description,
        scope,
        scope_ref: scopeRef,
        activate,
        // Core knows its own template ids; built-in shapes travel as a graph.
        ...(fromCore && chosen.id !== 'blank' ? { from: chosen.id } : { graph: chosen.graph }),
      });
      onOpenChange(false);
      onCreated(f);
    } catch (err) {
      notify({
        level: needsCore(err) ? 'info' : 'error',
        title: needsCore(err) ? 'Saving flows needs a newer Core' : 'The flow was not created',
        body: needsCore(err)
          ? 'This Core cannot store flows yet. Update it, then try again.'
          : (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog dialog--wide fnew" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">
            <Icon name="branch" size={18} /> Start a flow
          </Dialog.Title>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="fnew__grid" role="radiogroup" aria-label="Start from">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={t.id === pick}
                  className="fnew__card"
                  onClick={() => setPick(t.id)}
                  onDoubleClick={() => {
                    setPick(t.id);
                    void create();
                  }}
                >
                  <FlowPreview graph={t.graph} height={92} />
                  <span className="fnew__name">{t.name}</span>
                  <span className="fnew__desc">{t.description}</span>
                  {unready(t, byId).length ? (
                    <span className="fnew__ready" data-ready="no">
                      Needs a model set up
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            {missing.length ? (
              <p className="fnew__note" role="status">
                {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not set up yet, so this flow cannot
                answer until you add {missing.length === 1 ? 'its key' : 'their keys'} in Settings → Models,
                or pick other models on the canvas. You can still draw it and try it with mock models.
              </p>
            ) : null}
            <label className="fnew__field">
              <span className="fp-field__label">Name</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
            </label>
            <div className="dialog__actions">
              <Dialog.Close className="btn btn--ghost" type="button">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                className="btn btn--primary"
                data-busy={busy || undefined}
                disabled={busy}
              >
                Create from {chosen.name.toLowerCase()}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
