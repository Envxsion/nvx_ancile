/**
 * ------------------------------------------------------------------
 *  Title    |  Flow node cards
 *  Ref      |  DESIGN.md §16.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  How each node looks on the canvas: its glyph and hue,
 *           |  what it is set to do in one line, the model it calls
 *           |  (and whether a GPU node is awake), what it costs and
 *           |  how long it takes, and its state in a live run.
 *  How      |  One card for every runnable kind; routes, a manager's
 *           |  workers and a loop's body get their own labelled
 *           |  output ports on the right. Notes and groups are their
 *           |  own lighter components.
 * ------------------------------------------------------------------
 */

import type { FlowIssue, FlowNode } from '@nvx/contracts';
import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react';
import { type CSSProperties, memo } from 'react';
import { hueVar } from '../lib/format';
import { Icon } from '../ui/Icon';
import { contextSummary, msText, nodeSummary, usd } from './describe';
import { KINDS, modelOf, outputPorts, PROVIDER_NAMES, providerOf } from './kinds';
import type { FlowModel } from './models';
import { NoteMarkdown } from './noteMarkdown';
import type { LiveNode } from './store';

export interface CardData extends Record<string, unknown> {
  node: FlowNode;
  model?: FlowModel;
  live?: LiveNode;
  decision?: { chose: string[]; reason: string; confidence: number | null };
  issues: FlowIssue[];
  diff?: 'added' | 'changed' | null;
  /** Typical latency and cost from recent runs, when Core has them. */
  stats?: { p50: number; p95: number; cost: number } | null;
  /** This thread overrides some of this node's settings. */
  overridden?: boolean;
  onToggleGroup?: (id: string) => void;
}

function ModelChip({ id, model }: { id: string; model?: FlowModel }) {
  const provider = PROVIDER_NAMES[providerOf(id)] ?? providerOf(id);
  return (
    <span
      className="fnode__model"
      style={{ '--hue': hueVar(model?.hue ?? 'chalk') } as CSSProperties}
      data-unready={model && model.status !== 'ready' ? true : undefined}
      title={model ? `${model.name} · ${provider}` : `${id} (not in your model list)`}
    >
      <span className="fnode__model-dot" aria-hidden="true" />
      <span className="fnode__model-name">{model?.name ?? id.split('/').pop()}</span>
      <span className="fnode__model-via">{provider}</span>
      {model?.awake === false ? (
        <span
          className="fnode__sleep"
          title={`${model.nodeName ?? 'Its GPU node'} is asleep; the first call wakes it`}
        >
          asleep
        </span>
      ) : null}
    </span>
  );
}

function Badges({ n, data }: { n: FlowNode; data: CardData }) {
  const out: { key: string; text: string; tone?: string; title?: string }[] = [];
  if (n.disabled)
    out.push({
      key: 'bypass',
      text: 'Bypassed',
      tone: 'mute',
      title: 'Skipped when the flow runs; work passes straight through',
    });
  if (n.kind === 'model' && n.params.pinned_output)
    out.push({
      key: 'pin',
      text: 'Pinned',
      tone: 'gilt',
      title: 'Uses its pinned output instead of calling the model',
    });
  if (n.kind === 'model' && n.params.cache_s)
    out.push({
      key: 'cache',
      text: `Cache ${Math.round(n.params.cache_s / 60)}m`,
      title: 'Reuses an identical earlier answer',
    });
  if ((n.kind === 'model' || n.kind === 'manager') && n.params.speaks)
    out.push({ key: 'speaks', text: 'Speaks', title: 'Its words stream into the answer you see' });
  if (data.overridden) out.push({ key: 'ovr', text: 'Changed in this chat', tone: 'warn' });
  if (data.stats)
    out.push({
      key: 'stats',
      text: `${msText(data.stats.p50)} · ${usd(data.stats.cost)}`,
      title: `Typical: ${msText(data.stats.p50)}, slow: ${msText(data.stats.p95)}, about ${usd(data.stats.cost)} a call`,
    });
  if (!out.length) return null;
  return (
    <div className="fnode__badges">
      {out.map((b) => (
        <span key={b.key} className="fnode__badge" data-tone={b.tone} title={b.title}>
          {b.text}
        </span>
      ))}
    </div>
  );
}

function LiveLine({ live }: { live: LiveNode }) {
  if (live.status === 'running') {
    const text = (live.text || live.reasoning).trim();
    return (
      <div className="fnode__live" data-state="running">
        <span className="fnode__live-pulse" aria-hidden="true" />
        <span className="fnode__live-text">{text ? text.slice(-90) : 'Working…'}</span>
      </div>
    );
  }
  return (
    <div className="fnode__live" data-state={live.status}>
      <Icon
        name={live.status === 'failed' ? 'alert' : live.status === 'skipped' ? 'minus' : 'check'}
        size={11}
      />
      <span className="fnode__live-text">
        {live.status === 'failed'
          ? (live.error ?? 'Failed')
          : live.status === 'skipped'
            ? 'Skipped'
            : `${msText(live.ms)}${live.cost ? ` · ${usd(live.cost)}` : ''}${live.tokensOut ? ` · ${live.tokensOut} tok` : ''}${live.status === 'cached' ? ' · cached' : live.status === 'pinned' ? ' · pinned' : ''}`}
      </span>
    </div>
  );
}

export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps & { data: CardData }) {
  const n = data.node;
  const info = KINDS[n.kind];
  const ports = outputPorts(n);
  const routed = info.outputs === 'routes';
  const errors = data.issues.filter((i) => i.level === 'error').length;
  const warnings = data.issues.length - errors;
  const model = modelOf(n);

  return (
    <div
      className="fnode"
      data-kind={n.kind}
      data-selected={selected || undefined}
      data-disabled={n.disabled || undefined}
      data-live={data.live?.status}
      data-diff={data.diff ?? undefined}
      data-issues={errors ? 'error' : warnings ? 'warning' : undefined}
      style={{ '--hue': hueVar(info.hue) } as CSSProperties}
    >
      {info.input ? (
        <Handle type="target" position={Position.Left} id="in" className="fport fport--in" />
      ) : null}

      <div className="fnode__head">
        <span className="fnode__glyph" aria-hidden="true">
          <Icon name={info.icon} size={14} />
        </span>
        <div className="fnode__titles">
          <span className="fnode__kind">{info.name}</span>
          <span className="fnode__label" dir="auto">
            {n.label || n.id}
          </span>
        </div>
        {errors || warnings ? (
          <span className="fnode__issues" title={data.issues.map((i) => i.message).join('\n')}>
            <Icon name={errors ? 'alert' : 'warn'} size={12} />
            {errors + warnings}
          </span>
        ) : null}
      </div>

      {model ? <ModelChip id={model} model={data.model} /> : null}
      <div className="fnode__summary" dir="auto">
        {n.kind === 'context' ? contextSummary(n.params) : nodeSummary(n)}
      </div>

      {data.decision ? (
        <div className="fnode__decision" title={data.decision.reason}>
          <Icon name="branch" size={11} />
          Chose <b>{data.decision.chose.join(', ')}</b>
          {data.decision.confidence != null ? ` · ${Math.round(data.decision.confidence * 100)}%` : ''}
        </div>
      ) : null}
      {data.live ? <LiveLine live={data.live} /> : null}
      <Badges n={n} data={data} />

      {info.outputs === 'one' ? (
        <Handle type="source" position={Position.Right} id="out" className="fport fport--out" />
      ) : null}
      {routed ? (
        // One row per route under the card's content, each with its own port.
        <div className="fnode__ports">
          {ports.map((p) => (
            <div key={p} className="fnode__port" data-chosen={data.decision?.chose.includes(p) || undefined}>
              <span className="fnode__port-label">{p}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={p}
                className="fport fport--out fport--route"
                data-chosen={data.decision?.chose.includes(p) || undefined}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export const NoteCard = memo(function NoteCard({ data, selected }: NodeProps & { data: CardData }) {
  const n = data.node;
  if (n.kind !== 'note') return null;
  return (
    <div
      className="fnote"
      data-selected={selected || undefined}
      style={{ '--hue': hueVar((n.color as never) ?? 'amber') } as CSSProperties}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={140}
        minHeight={60}
        lineClassName="fnote__resize"
        handleClassName="fnote__handle"
      />
      <div className="fnote__text" dir="auto">
        <NoteMarkdown text={n.params.text} />
      </div>
    </div>
  );
});

export const GroupCard = memo(function GroupCard({ data, selected }: NodeProps & { data: CardData }) {
  const n = data.node;
  if (n.kind !== 'group') return null;
  const collapsed = n.params.collapsed;
  return (
    <div
      className="fgroup"
      data-selected={selected || undefined}
      data-collapsed={collapsed || undefined}
      style={{ '--hue': hueVar((n.color as never) ?? 'chalk') } as CSSProperties}
    >
      {!collapsed ? (
        <NodeResizer
          isVisible={!!selected}
          minWidth={200}
          minHeight={120}
          lineClassName="fgroup__resize"
          handleClassName="fnote__handle"
        />
      ) : null}
      <div className="fgroup__head">
        <button
          type="button"
          className="fgroup__toggle nodrag"
          aria-label={collapsed ? 'Expand group' : 'Collapse group'}
          onClick={() => data.onToggleGroup?.(n.id)}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        </button>
        <span className="fgroup__label" dir="auto">
          {n.label || 'Group'}
        </span>
      </div>
    </div>
  );
});

export const NODE_TYPES = { card: NodeCard, note: NoteCard, group: GroupCard };
