/**
 * ------------------------------------------------------------------
 *  Title    |  Flow chip
 *  Ref      |  DESIGN.md §16.3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Beside the model chip: which flow will answer this
 *           |  thread, where that choice comes from (the thread, its
 *           |  notebook, the workspace), and everything you can change
 *           |  about it without leaving the conversation.
 *  How      |  GET /flows/resolve for the choice. The menu switches the
 *           |  thread's flow, overrides one model node for this thread
 *           |  only (the notebook's flow is untouched), opens the
 *           |  editor, or turns flows off for the thread. A flow that
 *           |  calls a sleeping GPU node says so, with "Wake it now".
 *  Note     |  Waking is your click, never automatic: a node costs
 *           |  money from the moment it starts.
 * ------------------------------------------------------------------
 */

import type { FlowNode, Thread } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ComputeNode, computeKeys, nodeAction } from '../compute/data';
import { api } from '../lib/api';
import { useModels } from '../lib/data';
import { modelById } from '../lib/format';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { Tip } from '../ui/primitives';
import { flowModels, setThreadFlow, useFlowList, useResolvedFlow } from './flowActions';

const FROM_WORDS: Record<string, string> = {
  message: 'for this message',
  thread: 'this thread’s own flow',
  notebook: 'from the notebook',
  workspace: 'the workspace default',
  none: 'no flow',
};

/** Sentinel the thread stores to mean "no flow here, even if the notebook has one". */
export const FLOW_OFF = 'off';

const nodeModelId = (model: string) => `node/${model.replace(/[^A-Za-z0-9._:-]+/g, '-')}`;

export function FlowChip({ threadId, notebookId }: { threadId: string; notebookId: string | null }) {
  const navigate = useNavigate();
  const resolved = useResolvedFlow(threadId).data;
  const flows = useFlowList().data;
  const models = useModels().data;
  const flow = resolved?.flow ?? null;
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

  // A flow this thread turned off ("This thread instead of the flow").
  const paused = !flow ? (resolved?.paused ?? null) : null;
  // Nothing to say when no flow exists anywhere and none is chosen.
  if (!resolved || (!flow && !paused && !flows?.length)) return null;

  const modelNodes = (flow?.nodes ?? []).filter(
    (n): n is Extract<FlowNode, { kind: 'model' | 'manager' | 'router' }> =>
      (n.kind === 'model' || n.kind === 'manager' || n.kind === 'router') && !n.disabled,
  );

  const override = async (nodeId: string, model: string | null) => {
    if (!flow) return;
    const t = await api.get<Thread>(`/threads/${threadId}`).catch(() => null);
    const saved = t?.settings as
      | { flow_overrides?: Record<string, Record<string, unknown>>; flow_overrides_flow?: string | null }
      | undefined;
    // Overrides made for another flow (the thread moved, or its notebook's flow
    // changed) do not carry over: start from this flow's own choices.
    const current = saved?.flow_overrides_flow === flow.id ? (saved.flow_overrides ?? {}) : {};
    const next = { ...current };
    if (model) next[nodeId] = { ...(next[nodeId] ?? {}), model };
    else delete next[nodeId];
    await setThreadFlow(threadId, { flow_overrides: next, flow_overrides_flow: flow.id });
  };

  const chatModels = (models ?? []).filter((m) => m.chat !== false);

  const items: MenuEntry[] = [
    {
      kind: 'label',
      label: flow
        ? `${flow.name}: ${FROM_WORDS[resolved.from]}`
        : paused
          ? `${paused.name} is paused in this thread; your model answers`
          : 'Plain chat, no flow',
    },
    ...(paused
      ? [
          {
            label: `Turn ${paused.name} back on`,
            icon: 'undo' as const,
            onSelect: () => void setThreadFlow(threadId, { flow_id: null }),
          },
        ]
      : []),
    {
      kind: 'sub',
      label: 'Use for this thread',
      icon: 'tree',
      items: [
        ...(flows ?? []).map((f) => ({
          label: f.name,
          onSelect: () => void setThreadFlow(threadId, { flow_id: f.id }),
        })),
        ...(resolved.from === 'thread' ? [{ kind: 'separator' as const }] : []),
        ...(resolved.from === 'thread'
          ? [
              {
                label: 'Follow the notebook again',
                icon: 'undo' as const,
                onSelect: () => void setThreadFlow(threadId, { flow_id: null }),
              },
            ]
          : []),
      ],
    },
    ...(modelNodes.length
      ? [
          {
            kind: 'sub' as const,
            label: 'Change one step here only',
            icon: 'model' as const,
            items: modelNodes.map((n) => ({
              kind: 'sub' as const,
              label: `${n.label ?? n.kind}: ${modelById(n.params.model)?.name ?? n.params.model}`,
              items: [
                { label: 'Use the flow’s choice', onSelect: () => void override(n.id, null) },
                { kind: 'separator' as const },
                ...chatModels
                  .filter((m) => m.id !== n.params.model)
                  .slice(0, 16)
                  .map((m) => ({ label: m.name, onSelect: () => void override(n.id, m.id) })),
              ],
            })),
          },
        ]
      : []),
    ...(sleeping.length
      ? [
          { kind: 'separator' as const },
          ...sleeping.map((n) => ({
            label: `Wake ${n.name} now`,
            icon: 'zap' as const,
            onSelect: () => void nodeAction(n, 'start'),
          })),
        ]
      : []),
    { kind: 'separator' },
    ...(notebookId
      ? [
          {
            label: 'Open the flow editor',
            icon: 'ext' as const,
            onSelect: () => void navigate({ to: `/n/${notebookId}/flow` }),
          },
        ]
      : []),
    ...(paused || (resolved.from === 'none' && !flow)
      ? []
      : [
          {
            label: 'Turn flows off here; your model answers',
            icon: 'close' as const,
            onSelect: () => void setThreadFlow(threadId, { flow_id: FLOW_OFF }),
          },
        ]),
  ];

  return (
    <DropMenu
      align="start"
      side="top"
      items={items}
      trigger={
        <button
          type="button"
          className="flow-chip"
          data-from={paused ? 'paused' : resolved.from}
          aria-label={
            flow
              ? `Flow: ${flow.name}, ${FROM_WORDS[resolved.from]}. Change`
              : paused
                ? `${paused.name} is paused in this thread. Change`
                : 'No flow. Choose one'
          }
        >
          <Icon name="tree" size={12} />
          <span className="flow-chip__name">{flow ? flow.name : paused ? 'Flow paused' : 'No flow'}</span>
          {sleeping.length ? (
            <Tip label={`${sleeping.map((n) => n.name).join(', ')} is asleep; the first answer waits for it`}>
              <span className="flow-chip__wake">
                <Icon name="clock" size={11} />
              </span>
            </Tip>
          ) : null}
        </button>
      }
    />
  );
}
