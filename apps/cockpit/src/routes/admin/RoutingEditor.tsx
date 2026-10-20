/**
 * ------------------------------------------------------------------
 *  Title    |  Routing chain editor
 *  Ref      |  DESIGN.md §7.2, packages/contracts RoutingChain
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Admin → Routing: who answers each kind of task, in
 *           |  order, and the way to change it without a file. Drag a
 *           |  model, or use its menu (Move up, Move down, Remove);
 *           |  add any chat model that can answer now; reset to the
 *           |  default. A link that cannot answer stays, marked.
 *  How      |  Every change saves at once (PUT /routing/:task_class)
 *           |  and Core's answer replaces the cached list. Removing a
 *           |  model and resetting both offer Undo, which saves the
 *           |  order you had. Reset asks first: it drops your order.
 *           |  Drag is a pointer gesture on the grip (Motion Reorder);
 *           |  keyboard users get the same moves from the menu.
 *  Note     |  The order lives in Core settings and wins over
 *           |  config/routing.yaml until you reset it.
 * ------------------------------------------------------------------
 */

import type { RoutingChain, RoutingList } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { ApiCallError, api } from '../../lib/api';
import { useModels } from '../../lib/data';
import { queryClient } from '../../lib/query';
import type { ModelView } from '../../lib/types';
import { billingTitle, displayName, modelBadge, sameModelBothWays } from '../../models/billing';
import { LATEST_TAG, nowNote, offerable, retiredNote } from '../../models/lines';
import { notify } from '../../state/notify';
import { type ConfirmCopy, ConfirmDialog } from '../../ui/Confirm';
import { ErrorState } from '../../ui/ErrorState';
import { Icon } from '../../ui/Icon';
import { DropMenu, type MenuEntry } from '../../ui/Menu';
import { EmptyState, Skeleton } from '../../ui/primitives';
import { CreditFirst } from './CreditFirst';
import { addModel, moveBy, removeModel, sameOrder } from './chainOrder';

const ROUTING_KEY = ['routing'] as const;

/** What each task class is for, in a few words. */
const PURPOSE: Record<string, string> = {
  'chat.default': 'Ordinary chat turns',
  'chat.deep': 'Think harder turns and research synthesis',
  utility: 'Titles, tags, memory capture and summaries',
  'factcheck.verify': 'The second opinion that checks an answer',
};

const STATUS_NOTE: Record<NonNullable<ModelView['status']>, string> = {
  ready: 'Ready',
  needs_key: 'Skipped until its key is added',
  disabled: 'Skipped while it is off',
  not_pulled: 'Skipped until Ollama has it',
  signed_out: 'Skipped until Claude Code is signed in',
  credit_out: 'Skipped until your monthly credit renews',
};

function failed(error: unknown, what: string) {
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : `${what} failed`,
    body:
      error instanceof ApiCallError
        ? error.body.error.hint
        : 'Check that NVX Ancile is running, then try again.',
  });
}

/** Put Core's answer for one class into the cached list. */
function store(item: RoutingChain) {
  queryClient.setQueryData<RoutingChain[]>(ROUTING_KEY, (old) =>
    old ? old.map((r) => (r.task_class === item.task_class ? item : r)) : [item],
  );
}

export function RoutingEditor() {
  const routing = useQuery({
    queryKey: ROUTING_KEY,
    queryFn: () => api.get<RoutingList>('/routing').then((r) => r.items),
  });
  // Every model, so a link that cannot answer still shows its name and why; Add model offers only those that can.
  const models = useModels({ all: true }).data ?? [];
  const offered = useModels().data ?? [];
  const [confirm, setConfirm] = useState<{ copy: ConfirmCopy; run: () => void } | null>(null);

  const save = useMutation({
    mutationFn: (v: { taskClass: string; chain: string[] }) =>
      api.put<RoutingChain>(`/routing/${encodeURIComponent(v.taskClass)}`, { chain: v.chain }),
    onSuccess: store,
    onError: (e) => {
      failed(e, 'Saving the chain');
      void routing.refetch();
    },
  });
  const reset = useMutation({
    mutationFn: (v: { taskClass: string; previous: string[] }) =>
      api.del<RoutingChain>(`/routing/${encodeURIComponent(v.taskClass)}`),
    onSuccess: (item, v) => {
      store(item);
      notify({
        level: 'success',
        title: `${v.taskClass} is back to its default order`,
        undo: () => save.mutate({ taskClass: v.taskClass, chain: v.previous }),
      });
    },
    onError: (e) => failed(e, 'Resetting the chain'),
  });

  if (routing.isPending) return <Skeleton lines={3} label="Loading routing" />;
  if (routing.isError && !routing.data) {
    const retry = () => void routing.refetch();
    if (routing.error instanceof ApiCallError)
      return <ErrorState error={routing.error.body} onRetry={retry} retry="always" />;
    return (
      <EmptyState
        icon="alert"
        title="Routing could not be loaded"
        body="Core did not answer. Check that NVX Ancile is running, then try again."
        action={{ label: 'Try again', onClick: retry }}
      />
    );
  }

  return (
    <>
      <p className="mute admin__lede">
        Who answers each kind of task, in order. Drag a model or use its menu to reorder. Models without a
        key, or off, are skipped.
      </p>
      <CreditFirst />
      <div className="route-chains">
        {(routing.data ?? []).map((r) => (
          <ChainCard
            key={r.task_class}
            item={r}
            models={models}
            offered={offered}
            busy={save.isPending || reset.isPending}
            onSave={(chain) => save.mutate({ taskClass: r.task_class, chain })}
            onReset={() =>
              setConfirm({
                copy: {
                  title: `Reset ${r.task_class} to its default?`,
                  body: 'Your order is dropped and the chain from the configuration file applies again. You can undo this straight after.',
                  action: 'Reset chain',
                },
                run: () => reset.mutate({ taskClass: r.task_class, previous: r.configured }),
              })
            }
          />
        ))}
      </div>
      <ConfirmDialog
        copy={confirm?.copy ?? null}
        onConfirm={() => confirm?.run()}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

function ChainCard({
  item,
  models,
  offered,
  busy,
  onSave,
  onReset,
}: {
  item: RoutingChain;
  /** Every model, for the names and states of the links. */
  models: ModelView[];
  /** The models Add model offers: those that can answer now. */
  offered: ModelView[];
  busy: boolean;
  onSave: (chain: string[]) => void;
  onReset: () => void;
}) {
  const [order, setOrder] = useState<string[]>(item.configured);
  const orderRef = useRef(order);
  orderRef.current = order;
  const savedKey = item.configured.join('\n');
  // Core's answer (or a refetch after a failed save) is the truth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey stands for item.configured
  useEffect(() => setOrder(item.configured), [savedKey]);

  const byId = new Map(models.map((m) => [m.id, m]));
  // A chain can mix a plan and a key: each link says which, and a Claude model on both says so in its name.
  const dupes = sameModelBothWays(models);
  const name = (id: string) => {
    const m = byId.get(id);
    return m ? displayName(m, dupes) : id;
  };
  const tc = item.task_class;

  const commit = (next: string[]) => {
    setOrder(next);
    if (!sameOrder(next, item.configured)) onSave(next);
  };
  const remove = (id: string) => {
    const previous = orderRef.current;
    commit(removeModel(previous, id));
    notify({
      level: 'info',
      title: `Removed ${name(id)} from ${tc}`,
      undo: () => onSave(previous),
    });
  };

  // A line is offered once ("Latest"), not the model it answers with now; retired models are not offered.
  const candidates = offerable(offered).filter((m) => !order.includes(m.id));
  const addItems: MenuEntry[] = candidates.length
    ? candidates.map((m) => ({
        label: displayName(m, dupes),
        icon: 'model',
        onSelect: () => commit(addModel(orderRef.current, m.id)),
      }))
    : [{ kind: 'label', label: 'Every model that can answer is already here' }];

  return (
    <section className="route-chain" aria-labelledby={`route-${tc}`}>
      <header className="route-chain__head">
        <div className="route-chain__id">
          <h3 id={`route-${tc}`} className="route-chain__name" data-num>
            {tc}
          </h3>
          {item.custom ? <span className="tag model-added">Your order</span> : null}
          {PURPOSE[tc] ? <span className="route-chain__purpose mute">{PURPOSE[tc]}</span> : null}
        </div>
        <div className="route-chain__actions">
          {item.custom ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={onReset} disabled={busy}>
              Reset to default
            </button>
          ) : null}
          <DropMenu
            items={addItems}
            trigger={
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy}>
                <Icon name="plus" size={13} />
                Add model
              </button>
            }
          />
        </div>
      </header>
      {order.length === 0 ? (
        <p className="route-chain__empty mute">No models yet. Add one to give this task an answer.</p>
      ) : (
        <Reorder.Group
          as="ol"
          axis="y"
          values={order}
          onReorder={setOrder}
          className="rows route-chain__list"
        >
          {order.map((id, i) => (
            <ChainLink
              key={id}
              id={id}
              index={i}
              count={order.length}
              name={name(id)}
              model={byId.get(id)}
              lineNote={(() => {
                const m = byId.get(id);
                return m ? (retiredNote(m, models) ?? nowNote(m, models)) : null;
              })()}
              busy={busy}
              onDrop={() => commit(orderRef.current)}
              onMove={(step) => commit(moveBy(orderRef.current, id, step))}
              onRemove={() => remove(id)}
            />
          ))}
        </Reorder.Group>
      )}
      <p className="route-chain__now mute">
        {item.ok
          ? `Tries now: ${item.chain.map(name).join(' → ')}`
          : 'No model in this chain can answer yet. Add a key in Models, or add a ready model.'}
      </p>
    </section>
  );
}

function ChainLink({
  id,
  index,
  count,
  name,
  model,
  lineNote,
  busy,
  onDrop,
  onMove,
  onRemove,
}: {
  id: string;
  index: number;
  count: number;
  name: string;
  model: ModelView | undefined;
  /** "now Claude Opus 5.6" on a line, or why a retired model still answers. */
  lineNote: string | null;
  busy: boolean;
  onDrop: () => void;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  const [dragging, setDragging] = useState(false);
  const status = model?.status ?? 'ready';
  const note = model ? STATUS_NOTE[status] : 'Not one of your models yet';
  const items: MenuEntry[] = [
    { label: 'Move up', icon: 'arrowUp', disabled: busy || index === 0, onSelect: () => onMove(-1) },
    {
      label: 'Move down',
      icon: 'arrowDown',
      disabled: busy || index === count - 1,
      onSelect: () => onMove(1),
    },
    { kind: 'separator' },
    {
      label: 'Remove from chain',
      icon: 'trash',
      danger: true,
      // A chain keeps at least one model; Reset to default is the way back to the file.
      disabled: busy || count === 1,
      onSelect: onRemove,
    },
  ];
  return (
    <Reorder.Item
      as="li"
      value={id}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => {
        setDragging(false);
        onDrop();
      }}
      className="row route-link"
      data-dragging={dragging || undefined}
      data-status={model && status === 'ready' ? 'ok' : 'skipped'}
    >
      <span
        className="route-link__grip"
        title="Drag to reorder"
        aria-hidden="true"
        onPointerDown={(e) => {
          if (!busy) controls.start(e);
        }}
      >
        <Icon name="grip" size={14} />
      </span>
      <span className="route-link__num" data-num>
        {index + 1}
      </span>
      <span className="row__title" title={id}>
        {name}
      </span>
      {model?.aliasOf ? <span className="tag mu-latest">{LATEST_TAG}</span> : null}
      {model && modelBadge(model) ? (
        <span
          className="model-badge route-link__badge"
          {...(model.billing && { title: billingTitle(model.billing, model.price) })}
        >
          {modelBadge(model)}
        </span>
      ) : null}
      <span className="row__meta">{[lineNote, note].filter(Boolean).join(' · ')}</span>
      <DropMenu
        items={items}
        trigger={
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`Options for ${name}`}>
            <Icon name="more" size={14} />
          </button>
        }
      />
    </Reorder.Item>
  );
}
