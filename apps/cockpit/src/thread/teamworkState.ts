/**
 * ------------------------------------------------------------------
 *  Title    |  Teamwork state
 *  Ref      |  DESIGN.md §16.5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the Teamwork fold shows: every node a flow ran for
 *           |  one answer, in order, with its stream, cost and the
 *           |  decisions routers made on the way.
 *  How      |  One pure fold over the flow.* run events (live), and a
 *           |  builder from provenance.flow (after a reload); both
 *           |  give the same TeamState. Deltas arrive many times a
 *           |  second, so they are merged per node and channel and
 *           |  applied once per animation frame: the fold then runs at
 *           |  most 60 times a second however fast the models write.
 *  Note     |  A separate store from the run's LiveTurn, so a worker's
 *           |  tokens never re-render the answer body.
 * ------------------------------------------------------------------
 */

import type { FlowProvenance, RunEvent } from '@nvx/contracts';
import { create } from 'zustand';

export type StepStatus = 'running' | 'done' | 'skipped' | 'failed' | 'pinned' | 'cached';

export interface TeamStep {
  nodeId: string;
  kind: string;
  label: string | null;
  modelId: string | null;
  /** The nodes that handed it the work. */
  from: string[];
  status: StepStatus;
  startedAt: string;
  ms: number | null;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  text: string;
  reasoning: string;
  error: string | null;
}

export interface TeamDecision {
  nodeId: string;
  chose: string[];
  reason: string;
  confidence: number | null;
}

export interface TeamState {
  flowId: string;
  name: string;
  version: number;
  /** In the order they started. */
  steps: TeamStep[];
  decisions: Record<string, TeamDecision>;
  /** Nodes running now. */
  active: string[];
  done: boolean;
  cost: number;
  startedAt: string;
  /** Wall time of the whole flow, once done. */
  ms: number | null;
}

type FlowEvent = Extract<RunEvent, { type: `flow.${string}` }>;

export const isFlowEvent = (e: RunEvent): e is FlowEvent => e.type.startsWith('flow.');

function emptyTeam(e: { flow_id?: string; name?: string; version?: number; at: string }): TeamState {
  return {
    flowId: e.flow_id ?? '',
    name: e.name ?? 'Flow',
    version: e.version ?? 1,
    steps: [],
    decisions: {},
    active: [],
    done: false,
    cost: 0,
    startedAt: e.at,
    ms: null,
  };
}

/** Change the latest run of a node (a manager may ask one worker twice). */
const patchStep = (t: TeamState, nodeId: string, f: (s: TeamStep) => TeamStep): TeamState => {
  for (let i = t.steps.length - 1; i >= 0; i--) {
    const s = t.steps[i] as TeamStep;
    if (s.nodeId !== nodeId) continue;
    const steps = [...t.steps];
    steps[i] = f(s);
    return { ...t, steps };
  }
  return t;
};

/** Apply one flow event. Pure; unknown events leave the state as it was. */
export function foldTeam(t: TeamState | undefined, e: FlowEvent): TeamState | undefined {
  switch (e.type) {
    case 'flow.started':
      return emptyTeam(e);
    case 'flow.node.started': {
      const base = t ?? emptyTeam(e);
      const step: TeamStep = {
        nodeId: e.node_id,
        kind: e.kind,
        label: e.label,
        modelId: e.model_id,
        from: e.from,
        status: 'running',
        startedAt: e.at,
        ms: null,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        text: '',
        reasoning: '',
        error: null,
      };
      return {
        ...base,
        steps: [...base.steps, step],
        active: [...base.active.filter((n) => n !== e.node_id), e.node_id],
      };
    }
    case 'flow.node.delta': {
      if (!t) return t;
      return patchStep(t, e.node_id, (s) =>
        e.channel === 'text' ? { ...s, text: s.text + e.delta } : { ...s, reasoning: s.reasoning + e.delta },
      );
    }
    case 'flow.node.finished': {
      if (!t) return t;
      const next = patchStep(t, e.node_id, (s) => ({
        ...s,
        status: e.status,
        ms: e.ms,
        tokensIn: e.tokens_in,
        tokensOut: e.tokens_out,
        cost: e.cost_usd,
        error: e.error ?? null,
      }));
      return {
        ...next,
        active: next.active.filter((n) => n !== e.node_id),
        cost: next.steps.reduce((n, s) => n + s.cost, 0),
      };
    }
    case 'flow.decision': {
      const base = t ?? emptyTeam(e);
      return {
        ...base,
        decisions: {
          ...base.decisions,
          [e.node_id]: { nodeId: e.node_id, chose: e.chose, reason: e.reason, confidence: e.confidence },
        },
      };
    }
    default:
      return t;
  }
}

/** The finished flow, as recorded on the message. */
export function teamFromProvenance(p: FlowProvenance): TeamState {
  const order = new Map(p.path.map((id, i) => [id, i]));
  const steps: TeamStep[] = [...p.steps]
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((s, i, all) => {
      // Provenance does not record hand-offs; the step before on the path is the closest truth.
      const idx = order.get(s.node_id);
      const prev =
        idx !== undefined && idx > 0
          ? [p.path[idx - 1] as string]
          : i > 0
            ? [all[i - 1]?.node_id as string]
            : [];
      return {
        nodeId: s.node_id,
        kind: s.kind,
        label: s.label,
        modelId: s.model_id,
        from: prev.filter(Boolean),
        status: s.status,
        startedAt: s.started_at,
        ms: s.ms,
        tokensIn: s.tokens_in,
        tokensOut: s.tokens_out,
        cost: s.cost_usd,
        text: s.output,
        reasoning: s.reasoning ?? '',
        error: s.error ?? null,
      };
    });
  const first = steps[0]?.startedAt ?? new Date(0).toISOString();
  const end = steps.reduce((n, s) => Math.max(n, Date.parse(s.startedAt) + (s.ms ?? 0)), Date.parse(first));
  return {
    flowId: p.flow_id,
    name: p.name,
    version: p.version,
    steps,
    decisions: Object.fromEntries(
      p.decisions.map((d) => [
        d.node_id,
        { nodeId: d.node_id, chose: d.chose, reason: d.reason, confidence: d.confidence },
      ]),
    ),
    active: [],
    done: true,
    cost: p.cost_usd,
    startedAt: first,
    ms: Math.max(0, end - Date.parse(first)),
  };
}

/* ---- Delta batching ----------------------------------------------------------- */

type Schedule = (fn: () => void) => unknown;

const defaultSchedule: Schedule = (fn) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16);

/**
 * Merge flow.node.delta events per (message, node, channel) and hand them
 * on once per frame, as one event each. Other events flush pending deltas
 * first, so order is kept: a node never "finishes" before its last words.
 */
export function createDeltaBatcher(
  apply: (messageId: string, e: FlowEvent) => void,
  schedule: Schedule = defaultSchedule,
) {
  const pending = new Map<
    string,
    { messageId: string; e: Extract<FlowEvent, { type: 'flow.node.delta' }> }
  >();
  let queued = false;

  const flush = () => {
    queued = false;
    const batch = [...pending.values()];
    pending.clear();
    for (const { messageId, e } of batch) apply(messageId, e);
  };

  return {
    push(messageId: string, e: FlowEvent) {
      if (e.type !== 'flow.node.delta') {
        flush();
        apply(messageId, e);
        return;
      }
      const key = `${messageId}\u0000${e.node_id}\u0000${e.channel}`;
      const had = pending.get(key);
      pending.set(key, had ? { messageId, e: { ...e, delta: had.e.delta + e.delta } } : { messageId, e });
      if (!queued) {
        queued = true;
        schedule(flush);
      }
    },
    flush,
  };
}

/* ---- Store ------------------------------------------------------------------- */

interface TeamworkStore {
  teams: Record<string, TeamState>;
  apply: (messageId: string, e: FlowEvent) => void;
  drop: (messageId: string) => void;
}

export const useTeamwork = create<TeamworkStore>((set) => ({
  teams: {},
  apply: (messageId, e) =>
    set((s) => {
      const next = foldTeam(s.teams[messageId], e);
      if (!next || next === s.teams[messageId]) return s;
      return { teams: { ...s.teams, [messageId]: next } };
    }),
  drop: (messageId) =>
    set((s) => {
      const { [messageId]: _gone, ...rest } = s.teams;
      return { teams: rest };
    }),
}));

const batcher = createDeltaBatcher((messageId, e) => useTeamwork.getState().apply(messageId, e));

/** Feed a flow event from a run stream (lib/run.ts). */
export function pushFlowEvent(messageId: string, e: FlowEvent): void {
  batcher.push(messageId, e);
}

/**
 * The run ended: settle the live teamwork (flush pending text, stop every
 * still-active node, record the total time), so it reads as finished at once
 * instead of waiting for the message to be fetched again.
 */
export function finishTeam(messageId: string, at: string): void {
  batcher.flush();
  useTeamwork.setState((s) => {
    const t = s.teams[messageId];
    if (!t || t.done) return s;
    return {
      teams: {
        ...s.teams,
        [messageId]: {
          ...t,
          done: true,
          active: [],
          ms: Math.max(0, Date.parse(at) - Date.parse(t.startedAt)),
        },
      },
    };
  });
}

/** Live teamwork for a message, or undefined when no flow ran for it in this tab. */
export function useLiveTeam(messageId: string): TeamState | undefined {
  return useTeamwork((s) => s.teams[messageId]);
}
