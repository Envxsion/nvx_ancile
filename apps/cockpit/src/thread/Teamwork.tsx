/**
 * ------------------------------------------------------------------
 *  Title    |  Teamwork
 *  Ref      |  DESIGN.md §16.5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When a flow answers, show the team at work: who ran,
 *           |  who handed what to whom, why a router chose a route,
 *           |  what each step thought and wrote, and what it cost.
 *  How      |  A one-line summary ("Router → 2 coders → Reviewer ·
 *           |  14 s · $0.008") that opens into a timeline of steps
 *           |  beside a mini-graph of the flow: the running node lit in
 *           |  signal violet, the path taken in gilt once the answer
 *           |  is done. Live from the run's flow.* events (batched per
 *           |  frame in teamworkState.ts); after a reload, rebuilt from
 *           |  provenance.flow so it reads exactly the same.
 *  Note     |  Each step row is memoised and only the step that
 *           |  changed gets a new object, so a worker's tokens
 *           |  re-render one row, never the whole fold or the answer.
 * ------------------------------------------------------------------
 */

import type { FlowGraph } from '@nvx/contracts';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type CSSProperties, memo, useEffect, useMemo, useState } from 'react';
import { useModels } from '../lib/data';
import { hueVar, modelById, usd } from '../lib/format';
import type { MessageView } from '../lib/types';
import { useUi } from '../state/ui';
import { Icon, type IconName } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { routeAgain, useFlowVersion } from './flowActions';
import '../styles/teamwork.css';
import {
  type TeamDecision,
  type TeamState,
  type TeamStep,
  teamFromProvenance,
  useLiveTeam,
} from './teamworkState';

const KIND_ICON: Record<string, IconName> = {
  input: 'send',
  output: 'quote',
  model: 'model',
  router: 'branch',
  rule: 'filter',
  manager: 'user',
  parallel: 'grid',
  join: 'merge',
  context: 'layout',
  tool: 'zap',
  template: 'text',
  human: 'question',
  subflow: 'tree',
  retrieve: 'search',
  factcheck: 'factcheck',
  loop: 'regenerate',
};

/** Kinds that only plumb: they appear in the timeline, quietly, and never in the summary. */
const PLUMBING = new Set(['input', 'output', 'context', 'template', 'parallel']);

const PREF_KEY = 'nvx.ancile.teamwork';
type Pref = 'flow' | 'open' | 'collapsed' | 'hidden';

function readPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'open' || v === 'collapsed' || v === 'hidden' ? v : 'flow';
  } catch {
    return 'flow';
  }
}

export function stepName(s: Pick<TeamStep, 'label' | 'modelId' | 'kind'>): string {
  if (s.label) return s.label;
  if (s.kind === 'model' && s.modelId) return modelById(s.modelId)?.name ?? s.modelId;
  return s.kind[0]?.toUpperCase() + s.kind.slice(1);
}

/** "Router → 2 coders → Reviewer": steps started from the same hand-off form one stage. */
export function summarise(steps: TeamStep[]): string {
  const work = steps.filter((s) => !PLUMBING.has(s.kind));
  const stages: TeamStep[][] = [];
  for (const s of work) {
    const key = s.from.join(',');
    const last = stages.at(-1);
    if (last && last[0]?.from.join(',') === key && last[0]?.kind === s.kind && key) last.push(s);
    else stages.push([s]);
  }
  return stages
    .map((g) => {
      if (g.length === 1) return stepName(g[0] as TeamStep);
      const names = g.map(stepName);
      const stem = names[0]?.replace(/\s*\d+$/, '') ?? 'step';
      const same = names.every((n) => n.replace(/\s*\d+$/, '') === stem);
      return `${g.length} ${same ? `${stem.toLowerCase()}s` : 'in parallel'}`;
    })
    .join(' → ');
}

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/** A clock that ticks while something is running, and stops when nothing is. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

export function Teamwork({ m, threadId }: { m: MessageView; threadId: string }) {
  const live = useLiveTeam(m.id);
  const recorded = m.provenance?.flow;
  // Live wins while this tab watched it run; afterwards the record is the truth.
  const base: TeamState | undefined = useMemo(
    () => (live && (!live.done || !recorded) ? live : recorded ? teamFromProvenance(recorded) : live),
    [live, recorded],
  );
  const graph = useFlowVersion(base?.flowId || undefined, base?.version).data;
  // The record has no hand-offs; with the flow's graph they are exact: a step
  // was handed its work by the nodes with an edge into it that also ran.
  const team = useMemo(
    () => (base && graph && !live ? withHandoffs(base, graph) : base),
    [base, graph, live],
  );
  const names = useMemo(
    () => new Map((team?.steps ?? []).map((s) => [s.nodeId, stepName(s)])),
    [team?.steps],
  );
  const [pref] = useState(readPref);
  const initial = pref === 'flow' ? (graph?.settings?.show_teamwork ?? 'collapsed') : pref;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? initial === 'open';
  const running = !!team && !team.done && team.active.length > 0;
  const failed = !!team?.done && team.steps.some((s) => s.status === 'failed');
  const now = useNow(!!team && !team.done);

  if (!team || initial === 'hidden') return null;

  const elapsed = team.ms ?? Math.max(0, now - Date.parse(team.startedAt));
  const summary = summarise(team.steps) || team.name;
  const models = [...new Set(team.steps.map((s) => s.modelId).filter(Boolean) as string[])];

  return (
    <section
      className="teamwork"
      data-open={expanded || undefined}
      data-running={running || undefined}
      data-failed={failed || undefined}
      aria-label={`How this answer was made: ${summary}${failed ? ', a step failed' : ''}`}
    >
      <button
        type="button"
        className="teamwork__bar"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        <span className="teamwork__pulse" aria-hidden="true" />
        <Icon name="tree" size={12} />
        <span className="teamwork__summary">{summary}</span>
        {failed ? <span className="tw-tag tw-tag--fail">failed</span> : null}
        <span className="teamwork__chips" aria-hidden="true">
          {models.slice(0, 4).map((id) => (
            <span
              key={id}
              className="teamwork__dot"
              title={modelById(id)?.name ?? id}
              style={{ '--hue': hueVar(modelById(id)?.hue ?? 'chalk') } as CSSProperties}
            />
          ))}
        </span>
        <span className="teamwork__meta mute" data-num>
          {seconds(elapsed)} · {usd(team.cost, 3)}
        </span>
        <Icon name="chevronDown" size={12} className="teamwork__chev" />
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="body"
            className="teamwork__body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 36 }}
          >
            <div className="teamwork__grid">
              <ol className="teamwork__steps">
                {team.steps.map((s, i) => (
                  <StepRow
                    key={`${s.nodeId}-${s.startedAt}`}
                    step={s}
                    decision={team.decisions[s.nodeId]}
                    first={i === 0}
                    now={s.status === 'running' ? now : 0}
                    messageId={m.id}
                    threadId={threadId}
                    done={team.done}
                    names={names}
                  />
                ))}
              </ol>
              <MiniGraph team={team} graph={graph} />
            </div>
            <p className="teamwork__foot mute">
              <span>
                {team.name} · version <span data-num>{team.version}</span>
              </span>
              <button type="button" className="link-btn" onClick={() => useUi.getState().explain(m.id)}>
                Why this route?
              </button>
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

const StepRow = memo(function StepRow({
  step,
  decision,
  first,
  now,
  messageId,
  threadId,
  done,
  names,
}: {
  names: Map<string, string>;
  step: TeamStep;
  decision: TeamDecision | undefined;
  first: boolean;
  /** Only running rows get a ticking clock, so finished ones stay memoised. */
  now: number;
  messageId: string;
  threadId: string;
  done: boolean;
}) {
  const reduce = useReducedMotion();
  const [showText, setShowText] = useState(step.status === 'running');
  const [showThinking, setShowThinking] = useState(false);
  const models = useModels().data;
  const model = step.modelId ? modelById(step.modelId) : undefined;
  const plumbing = PLUMBING.has(step.kind);
  const ms = step.ms ?? (now ? Math.max(0, now - Date.parse(step.startedAt)) : null);
  const canSwap = done && (step.kind === 'model' || step.kind === 'manager');

  const swapItems: MenuEntry[] = [
    { kind: 'label', label: 'Rerun from this step with' },
    ...(models ?? [])
      .filter((x) => x.chat !== false && x.id !== step.modelId)
      .slice(0, 14)
      .map((x) => ({
        label: x.name,
        icon: 'model' as const,
        onSelect: () => void routeAgain(threadId, messageId, { fromNode: step.nodeId, model: x.id }),
      })),
  ];

  return (
    <li
      className="tw-step"
      data-status={step.status}
      data-kind={step.kind}
      data-plumbing={plumbing || undefined}
      style={model ? ({ '--hue': hueVar(model.hue) } as CSSProperties) : undefined}
    >
      <div className="tw-step__head">
        <span className="tw-step__ring" aria-hidden="true">
          <Icon name={KIND_ICON[step.kind] ?? 'dot'} size={11} />
        </span>
        <span className="tw-step__name">{stepName(step)}</span>
        <span className="tw-step__status sr-only">{step.status}</span>
        {step.status === 'pinned' ? <span className="tw-tag">pinned</span> : null}
        {step.status === 'cached' ? <span className="tw-tag">cached</span> : null}
        {step.status === 'skipped' ? <span className="tw-tag">skipped</span> : null}
        <span className="tw-step__meta mute" data-num>
          {ms !== null ? seconds(ms) : ''}
          {step.cost > 0 ? ` · ${usd(step.cost, 4)}` : ''}
        </span>
        {canSwap ? (
          <DropMenu
            items={swapItems}
            trigger={
              <button
                type="button"
                className="icon-btn icon-btn--xs"
                aria-label={`Rerun ${stepName(step)} with another model`}
              >
                <Icon name="regenerate" size={11} />
              </button>
            }
          />
        ) : null}
      </div>

      {(!first && step.from.length) || (model && step.label) ? (
        <p className="tw-step__sub mute">
          {model && step.label ? <span className="tw-step__model">{model.name}</span> : null}
          {!first && step.from.length ? (
            <span className="tw-step__handoff">
              from {step.from.map((f) => names.get(f) ?? f).join(' and ')}
            </span>
          ) : null}
        </p>
      ) : null}

      {decision ? (
        <div className="tw-decision">
          <span className="tw-decision__routes">
            {decision.chose.map((r) => (
              <span key={r} className="tw-route">
                <Icon name="arrowRight" size={10} />
                {r}
              </span>
            ))}
          </span>
          {decision.confidence !== null ? (
            <span className="tw-conf" title={`Confidence ${Math.round(decision.confidence * 100)}%`}>
              <motion.span
                className="tw-conf__fill"
                initial={reduce ? false : { scaleX: 0 }}
                animate={{ scaleX: decision.confidence }}
                transition={{ type: 'spring', stiffness: 220, damping: 30 }}
              />
            </span>
          ) : null}
          {decision.reason ? <p className="tw-decision__reason">{decision.reason}</p> : null}
        </div>
      ) : null}

      {step.reasoning ? (
        <div className="tw-thinking" data-open={showThinking || undefined}>
          <button type="button" className="tw-toggle" onClick={() => setShowThinking((v) => !v)}>
            <Icon name="sparkle" size={10} />
            {showThinking ? 'Hide thinking' : 'Thinking'}
          </button>
          {showThinking ? <p className="tw-thinking__text">{step.reasoning}</p> : null}
        </div>
      ) : null}

      {step.text && !plumbing ? (
        <div className="tw-output" data-open={showText || undefined}>
          <button type="button" className="tw-toggle" onClick={() => setShowText((v) => !v)}>
            <Icon name="text" size={10} />
            {showText ? 'Hide output' : `Output · ${step.text.length.toLocaleString('en-GB')} characters`}
          </button>
          {showText ? (
            <p className="tw-output__text" dir="auto">
              {step.text}
              {step.status === 'running' ? <span className="tw-caret" aria-hidden="true" /> : null}
            </p>
          ) : null}
        </div>
      ) : null}

      {step.error ? (
        <p className="tw-error" role="alert">
          <Icon name="warn" size={11} />
          {step.error}
        </p>
      ) : null}
    </li>
  );
});

/** Give each recorded step its true hand-offs from the flow's edges. */
function withHandoffs(team: TeamState, graph: FlowGraph): TeamState {
  const ran = new Set(team.steps.map((s) => s.nodeId));
  const into = new Map<string, string[]>();
  for (const e of graph.edges) if (ran.has(e.from)) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  return { ...team, steps: team.steps.map((s) => ({ ...s, from: into.get(s.nodeId) ?? s.from })) };
}

/* ---- Mini-graph ---------------------------------------------------------------- */

const W = 220;
const H = 168;
const PAD = 14;

interface MiniNode {
  id: string;
  x: number;
  y: number;
  label: string;
}

/** The flow's own layout when the version loaded; else a column per hand-off depth. */
function layout(
  team: TeamState,
  graph: FlowGraph | undefined,
): { nodes: MiniNode[]; edges: [string, string][] } {
  if (graph?.nodes.length) {
    const runnable = graph.nodes.filter((n) => n.kind !== 'note' && n.kind !== 'group');
    const xs = runnable.map((n) => n.position.x);
    const ys = runnable.map((n) => n.position.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const sx = (W - PAD * 2) / Math.max(1, x1 - x0);
    const sy = (H - PAD * 2) / Math.max(1, y1 - y0);
    const s = Math.min(sx, sy);
    const ox = (W - (x1 - x0) * s) / 2;
    const oy = (H - (y1 - y0) * s) / 2;
    return {
      nodes: runnable.map((n) => ({
        id: n.id,
        x: ox + (n.position.x - x0) * s,
        y: oy + (n.position.y - y0) * s,
        label: n.label ?? n.kind,
      })),
      edges: graph.edges.map((e) => [e.from, e.to]),
    };
  }
  const depth = new Map<string, number>();
  for (const s of team.steps) {
    const d = s.from.length ? Math.max(...s.from.map((f) => depth.get(f) ?? 0)) + 1 : 0;
    if (!depth.has(s.nodeId)) depth.set(s.nodeId, d);
  }
  const cols = new Map<number, string[]>();
  for (const [id, d] of depth) cols.set(d, [...(cols.get(d) ?? []), id]);
  const maxD = Math.max(0, ...cols.keys());
  const nodes: MiniNode[] = [];
  for (const [d, ids] of cols) {
    for (const [i, id] of ids.entries()) {
      nodes.push({
        id,
        x: PAD + (maxD ? (d / maxD) * (W - PAD * 2) : (W - PAD * 2) / 2),
        y: PAD + ((i + 1) / (ids.length + 1)) * (H - PAD * 2),
        label: stepName(team.steps.find((s) => s.nodeId === id) as TeamStep),
      });
    }
  }
  const edges: [string, string][] = team.steps.flatMap((s) =>
    s.from.map((f) => [f, s.nodeId] as [string, string]),
  );
  return { nodes, edges };
}

const MiniGraph = memo(function MiniGraph({
  team,
  graph,
}: {
  team: TeamState;
  graph: FlowGraph | undefined;
}) {
  const { nodes, edges } = useMemo(() => layout(team, graph), [team, graph]);
  const ran = new Set(team.steps.map((s) => s.nodeId));
  const active = new Set(team.active);
  const at = new Map(nodes.map((n) => [n.id, n]));
  return (
    <figure className="tw-graph" aria-label="The flow, with the path this answer took">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img">
        <title>Flow graph</title>
        {edges.map(([a, b]) => {
          const p = at.get(a);
          const q = at.get(b);
          if (!p || !q) return null;
          const taken = ran.has(a) && ran.has(b);
          const mx = (p.x + q.x) / 2;
          return (
            <path
              key={`${a}-${b}`}
              className="tw-graph__edge"
              data-taken={taken || undefined}
              data-done={team.done || undefined}
              d={`M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}`}
            />
          );
        })}
        {nodes.map((n) => (
          <g
            key={n.id}
            className="tw-graph__node"
            data-ran={ran.has(n.id) || undefined}
            data-active={active.has(n.id) || undefined}
            data-done={team.done || undefined}
            transform={`translate(${n.x},${n.y})`}
          >
            <circle r={active.has(n.id) ? 6 : 4.5} />
            <title>{n.label}</title>
          </g>
        ))}
      </svg>
      <figcaption className="mute">{team.done ? 'The path this answer took' : 'Running now'}</figcaption>
    </figure>
  );
});
