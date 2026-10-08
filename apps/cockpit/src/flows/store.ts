/**
 * ------------------------------------------------------------------
 *  Title    |  Flow editor state
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The open flow: its graph, what is selected, which panel
 *           |  is out, the undo stack, the live overlay of a run, and
 *           |  a draft that survives a closed tab.
 *  How      |  Every edit goes through apply(), which records the
 *           |  graph before it, so ⌘Z always steps back exactly one
 *           |  edit. Dragging records once, when the drag starts.
 *           |  The draft is written to localStorage 600 ms after the
 *           |  last edit and dropped on save.
 * ------------------------------------------------------------------
 */

import type { Flow, FlowGraph, FlowIssue, RunEvent } from '@nvx/contracts';
import { create } from 'zustand';
import type { EdgeEstimate } from './api';
import { type Clip, type GraphDiff, type History, record, redo, undo } from './graph';
import type { ValidateFlowResponse } from './types';

export type Panel = 'node' | 'edge' | 'try' | 'lint' | 'versions' | 'calls' | 'settings' | null;

export interface LiveNode {
  status: 'running' | 'done' | 'skipped' | 'failed' | 'pinned' | 'cached';
  model: string | null;
  ms: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  text: string;
  reasoning: string;
  error?: string;
  startedAt: number;
}

export interface LiveRun {
  runId: string;
  state: 'running' | 'done' | 'failed';
  nodes: Record<string, LiveNode>;
  decisions: Record<string, { chose: string[]; reason: string; confidence: number | null }>;
  /** Edges a run travelled ("from>to"), lit on the canvas. */
  travelled: string[];
  answer: string;
  cost: number;
  startedAt: number;
}

export interface FlowMeta {
  id: string;
  name: string;
  description: string;
  version: number;
  published: number | null;
  scope: Flow['scope'];
  scopeRef: string | null;
  active: boolean;
}

interface EditorState {
  meta: FlowMeta | null;
  graph: FlowGraph;
  /** The graph as last saved; dirty when it differs. */
  saved: FlowGraph;
  history: History;
  selected: string[];
  selectedEdge: string | null;
  panel: Panel;
  validation: ValidateFlowResponse | null;
  /** What crosses each edge into a model, for the whole graph (Core's estimate). */
  estimates: EdgeEstimate[] | 'needs-core' | null;
  live: LiveRun | null;
  compare: { version: number; graph: FlowGraph; diff: GraphDiff } | null;
  /** Add-node search: where it opened, and the port it was dragged from. */
  adding: { at: { x: number; y: number }; from?: { node: string; label: string } } | null;

  load: (meta: FlowMeta, graph: FlowGraph, draft?: FlowGraph | null) => void;
  apply: (fn: (g: FlowGraph) => FlowGraph, opts?: { record?: boolean }) => void;
  /** Record the current graph once (before a drag) without changing it. */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: (meta: FlowMeta, graph: FlowGraph) => void;
  select: (ids: string[], edge?: string | null) => void;
  setPanel: (p: Panel) => void;
  setValidation: (v: ValidateFlowResponse | null) => void;
  setEstimates: (e: EditorState['estimates']) => void;
  setAdding: (a: EditorState['adding']) => void;
  setCompare: (c: EditorState['compare']) => void;
  startLive: (runId: string) => void;
  onEvent: (e: RunEvent) => void;
  clearLive: () => void;
}

const empty: FlowGraph = {
  nodes: [],
  edges: [],
  settings: { max_steps: 24, cost_cap_usd: 1, timeout_s: 600, show_teamwork: 'collapsed' },
};

export const useEditor = create<EditorState>((set, get) => ({
  meta: null,
  graph: empty,
  saved: empty,
  history: { past: [], future: [] },
  selected: [],
  selectedEdge: null,
  panel: null,
  validation: null,
  estimates: null,
  live: null,
  compare: null,
  adding: null,

  load: (meta, graph, draft) =>
    set({
      meta,
      graph: draft ?? graph,
      saved: graph,
      history: { past: [], future: [] },
      selected: [],
      selectedEdge: null,
      validation: null,
      live: null,
      compare: null,
    }),
  apply: (fn, opts) => {
    const before = get().graph;
    const next = fn(before);
    if (next === before) return;
    set((s) => ({ graph: next, history: opts?.record === false ? s.history : record(s.history, before) }));
  },
  checkpoint: () => set((s) => ({ history: record(s.history, s.graph) })),
  undo: () => {
    const r = undo(get().history, get().graph);
    if (r) set({ graph: r.graph, history: r.history });
  },
  redo: () => {
    const r = redo(get().history, get().graph);
    if (r) set({ graph: r.graph, history: r.history });
  },
  markSaved: (meta, graph) => set({ meta, saved: graph, graph }),
  select: (ids, edge = null) =>
    set((s) => ({
      selected: ids,
      selectedEdge: edge,
      panel: edge
        ? 'edge'
        : ids.length === 1
          ? 'node'
          : s.panel === 'node' || s.panel === 'edge'
            ? null
            : s.panel,
    })),
  setPanel: (panel) => set({ panel }),
  setValidation: (validation) => set({ validation }),
  setEstimates: (estimates) => set({ estimates }),
  setAdding: (adding) => set({ adding }),
  setCompare: (compare) => set({ compare }),
  startLive: (runId) =>
    set({
      live: {
        runId,
        state: 'running',
        nodes: {},
        decisions: {},
        travelled: [],
        answer: '',
        cost: 0,
        startedAt: Date.now(),
      },
    }),
  onEvent: (e) =>
    set((s) => {
      const live = s.live;
      if (!live) return s;
      const nodes = { ...live.nodes };
      switch (e.type) {
        case 'flow.node.started': {
          nodes[e.node_id] = {
            status: 'running',
            model: e.model_id,
            ms: 0,
            cost: 0,
            tokensIn: 0,
            tokensOut: 0,
            text: '',
            reasoning: '',
            startedAt: Date.now(),
          };
          const travelled = [...live.travelled, ...e.from.map((f) => `${f}>${e.node_id}`)];
          return { live: { ...live, nodes, travelled } };
        }
        case 'flow.node.delta': {
          const n = nodes[e.node_id];
          if (!n) return s;
          nodes[e.node_id] =
            e.channel === 'text'
              ? { ...n, text: n.text + e.delta }
              : { ...n, reasoning: n.reasoning + e.delta };
          return { live: { ...live, nodes } };
        }
        case 'flow.node.finished': {
          const n = nodes[e.node_id];
          nodes[e.node_id] = {
            ...(n ?? { model: null, text: '', reasoning: '', startedAt: Date.now() }),
            status: e.status,
            ms: e.ms,
            cost: e.cost_usd,
            tokensIn: e.tokens_in,
            tokensOut: e.tokens_out,
            ...(e.error && { error: e.error }),
          } as LiveNode;
          return { live: { ...live, nodes, cost: live.cost + e.cost_usd } };
        }
        case 'flow.decision':
          return {
            live: {
              ...live,
              decisions: {
                ...live.decisions,
                [e.node_id]: { chose: e.chose, reason: e.reason, confidence: e.confidence },
              },
            },
          };
        case 'text.delta':
          return { live: { ...live, answer: live.answer + e.delta } };
        case 'error':
          return { live: { ...live, state: 'failed' } };
        case 'done':
          return { live: { ...live, state: live.state === 'failed' ? 'failed' : 'done' } };
        default:
          return s;
      }
    }),
  clearLive: () => set({ live: null }),
}));

export const isDirty = (s: Pick<EditorState, 'graph' | 'saved'>) =>
  s.graph !== s.saved && JSON.stringify(s.graph) !== JSON.stringify(s.saved);

export const issuesFor = (v: ValidateFlowResponse | null, nodeId: string): FlowIssue[] =>
  v?.issues.filter((i) => i.node_id === nodeId) ?? [];

/* ---- Clipboard: survives switching flows, and tabs -------------------- */

const CLIP_KEY = 'nvx.ancile.flow-clipboard';

export function writeClip(c: Clip): void {
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(c));
  } catch {
    /* storage blocked: copy works within this tab only */
  }
  memClip = c;
}

let memClip: Clip | null = null;

export function readClip(): Clip | null {
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    if (raw) return JSON.parse(raw) as Clip;
  } catch {
    /* fall through */
  }
  return memClip;
}

/* ---- Drafts ------------------------------------------------------------------ */

const draftKey = (id: string) => `nvx.ancile.flow-draft:${id}`;

export function readDraft(id: string): { graph: FlowGraph; at: number; base: number } | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as { graph: FlowGraph; at: number; base: number }) : null;
  } catch {
    return null;
  }
}

export function writeDraft(id: string, graph: FlowGraph, base: number): void {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify({ graph, at: Date.now(), base }));
  } catch {
    /* storage full or blocked */
  }
}

export function dropDraft(id: string): void {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    /* ignore */
  }
}
