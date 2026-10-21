/**
 * ------------------------------------------------------------------
 *  Title    |  Who answers
 *  Ref      |  DESIGN.md §16.3 · roadmap FX1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The one chip in the composer that says who answers the
 *           |  next message: a model, or a flow. It shows one name;
 *           |  everything else waits for a click.
 *  How      |  No flow answering: the chip opens the palette's model
 *           |  list, which also lists the flows you can pick (Ctrl+K,
 *           |  @). A flow answering: it opens a menu with where the
 *           |  choice comes from (thread, notebook, workspace), the
 *           |  flow's model steps (each switchable for this thread
 *           |  only; the flow itself is untouched, and a step whose
 *           |  model cannot answer says what stands in), Use one model
 *           |  instead (pauses the flow in this thread), another flow,
 *           |  the editor, and Wake for a sleeping GPU node.
 *  Note     |  Waking is your click, never automatic: a node costs
 *           |  money from the moment it starts.
 * ------------------------------------------------------------------
 */

import type { FlowNode } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ComputeNode, computeKeys, nodeAction } from '../compute/data';
import { api } from '../lib/api';
import { canAnswer, useModels } from '../lib/data';
import type { ModelView } from '../lib/types';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { BarLabel, HueChip, Tip } from '../ui/primitives';
import { shortModelName } from './composerBar';
import {
  FLOW_OFF,
  FROM_WORDS,
  flowKeys,
  flowModels,
  flowSource,
  flowsFor,
  setNodeModel,
  setThreadFlow,
  useFlowList,
  useResolvedFlow,
} from './flowActions';

const nodeModelId = (model: string) => `node/${model.replace(/[^A-Za-z0-9._:-]+/g, '-')}`;

type StepNode = Extract<FlowNode, { kind: 'model' | 'manager' | 'router' }>;

/** What the menu says about one step: its model, and what stands in when that model cannot answer. */
export function stepLine(
  step: { label?: string; kind: string },
  chosen: string,
  changed: boolean,
  all: readonly ModelView[] | undefined,
  fallbacks: readonly string[],
): string {
  const by = (id: string) => all?.find((m) => m.id === id);
  const m = by(chosen);
  const name = m?.name ?? chosen;
  const head = `${step.label ?? step.kind}: ${name}${changed ? ' (this thread only)' : ''}`;
  // Nothing to say until the lineup has loaded.
  if (!all || canAnswer(m)) return head;
  const stand = fallbacks.map(by).find(canAnswer);
  return stand
    ? `${head} (unavailable; ${stand.name} steps in)`
    : `${head} (unavailable; no fallback is ready)`;
}

export function WhoAnswers({
  threadId,
  notebookId,
  synced,
  model,
  pick,
  upcoming,
}: {
  threadId: string;
  notebookId: string | null;
  /** A saved thread (not Home or a notebook's ask box): only then can a flow be chosen for it. */
  synced: boolean;
  /** The model that answers when no flow does. */
  model: ModelView | undefined;
  /** An @model chosen for this message alone. */
  pick?: { label: string; hue: ModelView['hue'] };
  /** The flow a new thread here would use, said before the thread exists. */
  upcoming?: { name: string } | null;
}) {
  const navigate = useNavigate();
  const openPalette = useUi((s) => s.openPalette);
  const resolved = useResolvedFlow(synced ? threadId : undefined).data;
  const flows = useFlowList(synced).data;
  const all = useModels({ all: true }).data;
  const ready = (all ?? []).filter(canAnswer);
  const flow = resolved?.flow ?? null;
  const paused = !flow ? (resolved?.paused ?? null) : null;

  const usesNodes = flowModels(flow).filter((m) => m.startsWith('node/'));
  // Only when the flow calls a GPU node: then whether that node is awake.
  const nodes = useQuery({
    queryKey: computeKeys.nodes,
    enabled: usesNodes.length > 0,
    refetchInterval: 15_000,
    queryFn: () => api.get<{ items: ComputeNode[] }>('/compute/nodes').then((r) => r.items),
  });
  const sleeping = usesNodes.length
    ? (nodes.data ?? []).filter(
        (n) =>
          n.observed_state !== 'running' &&
          n.observed_state !== 'terminated' &&
          n.served_models.some((s) => usesNodes.includes(nodeModelId(s))),
      )
    : [];
  // The steps this thread switched, shown beside each step in the menu.
  const overrides = useQuery({
    queryKey: [...flowKeys.resolve(threadId), 'overrides'] as const,
    enabled: !!flow && synced,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      api
        .get<{
          settings?: {
            flow_overrides?: Record<string, { model?: string }>;
            flow_overrides_flow?: string | null;
          };
        }>(`/threads/${threadId}`)
        .then((t) =>
          t.settings?.flow_overrides_flow === flow?.id ? (t.settings?.flow_overrides ?? {}) : {},
        ),
  }).data;

  const answering = pick ? null : (flow ?? (synced ? null : (upcoming ?? null)));
  const label = pick?.label ?? answering?.name ?? model?.name ?? null;

  const aria = pick
    ? `${pick.label} for this message. Change who answers`
    : answering
      ? `${answering.name}, a flow. Change who answers`
      : paused
        ? `${model?.name ?? 'No model'}; ${paused.name} is paused in this thread. Change who answers`
        : `${model?.name ?? 'No model'}. Change who answers`;
  const tip = pick
    ? `${pick.label} answers this message${answering ? `, instead of ${answering.name}` : ''}`
    : answering
      ? `${answering.name} answers`
      : paused
        ? `${paused.name} is paused here; ${model?.name ?? 'your model'} answers`
        : 'Change who answers';

  const button = (
    <button
      type="button"
      className="composer__model"
      data-tour="model-chip"
      data-overridden={pick ? true : undefined}
      data-answers={answering ? 'flow' : 'model'}
      aria-label={aria}
      onClick={flow && !pick ? undefined : () => openPalette('models')}
    >
      {label ? (
        answering ? (
          <>
            <Icon name="tree" size={12} />
            <BarLabel full={label} short={shortModelName(label)} />
          </>
        ) : (
          <HueChip hue={pick?.hue ?? model?.hue ?? 'chalk'}>
            <BarLabel full={label} short={shortModelName(label)} />
          </HueChip>
        )
      ) : (
        <>
          <Icon name="model" size={12} />
          <BarLabel full="Choose a model" short="Model" />
        </>
      )}
      {sleeping.length && !pick ? (
        <Tip label={`${sleeping.map((n) => n.name).join(', ')} is asleep; the first answer waits for it`}>
          <span className="composer__wake">
            <Icon name="clock" size={11} />
          </span>
        </Tip>
      ) : null}
    </button>
  );

  const tipped = (
    <Tip label={tip} binding="model.switch">
      {button}
    </Tip>
  );

  // No flow answers, or an @model takes this one message: the model list (and the flows) in the palette.
  if (!flow || pick || !resolved) return tipped;

  const steps = flow.nodes.filter(
    (n): n is StepNode => (n.kind === 'model' || n.kind === 'manager' || n.kind === 'router') && !n.disabled,
  );
  const mine = flowsFor(flows, notebookId);

  const items: MenuEntry[] = [
    { kind: 'label', label: FROM_WORDS[resolved.from] ?? 'From this thread' },
    ...steps.map<MenuEntry>((n) => {
      const changed = !!overrides?.[n.id]?.model;
      const chosen = overrides?.[n.id]?.model ?? n.params.model;
      return {
        kind: 'sub',
        label: stepLine(n, chosen, changed, all, 'fallbacks' in n.params ? n.params.fallbacks : []),
        icon: 'model',
        items: [
          {
            label: 'Use the flow’s choice',
            disabled: !changed,
            onSelect: () => void setNodeModel(threadId, flow.id, n.id, null),
          },
          { kind: 'separator' },
          ...ready
            .filter((m) => m.id !== chosen && !m.unlisted)
            .slice(0, 16)
            .map<MenuEntry>((m) => ({
              label: m.name,
              onSelect: () => void setNodeModel(threadId, flow.id, n.id, m.id),
            })),
        ],
      };
    }),
    ...sleeping.map<MenuEntry>((n) => ({
      label: `Wake ${n.name} now`,
      icon: 'zap',
      onSelect: () => void nodeAction(n, 'start'),
    })),
    { kind: 'separator' },
    {
      label: 'Use one model instead',
      icon: 'model',
      onSelect: () => openPalette('models'),
    },
    ...(mine.length > 1 || resolved.from === 'thread'
      ? [
          {
            kind: 'sub' as const,
            label: 'Use another flow',
            icon: 'tree' as const,
            items: [
              ...mine
                .filter((f) => f.id !== flow.id)
                .map<MenuEntry>((f) => ({
                  label: `${f.name} · ${flowSource(f, notebookId)}`,
                  onSelect: () => void setThreadFlow(threadId, { flow_id: f.id }),
                })),
              ...(resolved.from === 'thread'
                ? [
                    { kind: 'separator' as const },
                    {
                      label: 'Follow the notebook again',
                      icon: 'undo' as const,
                      onSelect: () => void setThreadFlow(threadId, { flow_id: null }),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    ...(notebookId
      ? [
          {
            label: 'Open the flow editor',
            icon: 'ext' as const,
            onSelect: () => void navigate({ to: `/n/${notebookId}/flow` }),
          },
        ]
      : []),
    {
      label: 'Turn the flow off in this thread',
      icon: 'close',
      onSelect: () => void setThreadFlow(threadId, { flow_id: FLOW_OFF }),
    },
  ];

  return <DropMenu align="start" side="top" items={items} trigger={tipped} />;
}
