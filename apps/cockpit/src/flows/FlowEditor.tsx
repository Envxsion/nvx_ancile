/**
 * ------------------------------------------------------------------
 *  Title    |  The flow editor
 *  Ref      |  DESIGN.md §16.6 · ROADMAP Phase 5b
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Draw how your messages are answered. Nodes from any
 *           |  provider, routers and rules, teams, context on every
 *           |  connection, a live run lighting up the path, versions
 *           |  with a visual diff, and a keyboard for everything.
 *  How      |  The graph lives in the editor store (store.ts) and is
 *           |  mapped to xyflow nodes and edges on every change; the
 *           |  canvas never owns state. Edits are pure functions from
 *           |  graph.ts, so each is one undo step. Checks run as you
 *           |  draw (locally at once, then Core's validate); the draft
 *           |  autosaves to this browser until you save.
 * ------------------------------------------------------------------
 */

import type { Flow, FlowGraph, FlowNodeKind, FlowSummary } from '@nvx/contracts';
import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeChange,
  MiniMap,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { AddModelDialog } from '../models/AddModel';
import '@xyflow/react/dist/base.css';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chordOf, isTyping } from '../keys/dispatch';
import { keysFor, normalise } from '../keys/registry';
import { api } from '../lib/api';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { EmptyState, Kbd, Skeleton, Tip } from '../ui/primitives';
import { AddNode, type Pick } from './AddNode';
import {
  createFlow,
  estimateContext,
  flowKeys,
  needsCore,
  saveFlow,
  useFlow,
  useFlows,
  useNodeStats,
  validateGraph,
} from './api';
import { EDGE_TYPES, type EdgeData } from './FlowEdge';
import {
  addNode,
  align,
  collapseToSubflow,
  connect,
  copy,
  distribute,
  duplicate,
  group,
  membersOf,
  moveNodes,
  nextId,
  paste,
  removeEdges,
  removeNodes,
  setDisabled,
  sizeOf,
  ungroup,
  updateNode,
  updateParams,
} from './graph';
import { KINDS, modelOf, newNode, outputPorts } from './kinds';
import { autoLayout } from './layout';
import { localLint } from './lint';
import { useFlowModels } from './models';
import type { CardData } from './NodeCard';
import { NODE_TYPES } from './NodeCard';
import { NodePanel } from './NodePanel';
import { CloseCallsPanel, EdgePanel, LintPanel, SettingsPanel, TryPanel, VersionsPanel } from './Panels';
import {
  dropDraft,
  type FlowMeta,
  isDirty,
  readClip,
  readDraft,
  useEditor,
  writeClip,
  writeDraft,
} from './store';

const metaOf = (f: Flow): FlowMeta => ({
  id: f.id,
  name: f.name,
  description: f.description,
  version: f.version,
  published: f.published_version ?? null,
  scope: f.scope,
  scopeRef: f.scope_ref,
  active: f.active,
});

const graphOf = (f: Flow): FlowGraph => ({
  nodes: f.nodes,
  edges: f.edges,
  settings: f.settings,
  ...(f.viewport && { viewport: f.viewport }),
});

/** Does this key event match a binding (handles ⌥ rewriting letters on macOS)? */
function matches(e: KeyboardEvent, id: string): boolean {
  const keys = keysFor(id);
  if (!keys) return false;
  const want = normalise(keys);
  const chord = chordOf(e.nativeEvent);
  if (chord === want) return true;
  if (e.altKey && e.code.startsWith('Key')) {
    const parts = chord.split('+');
    parts[parts.length - 1] = e.code.slice(3).toLowerCase();
    return parts.join('+') === want;
  }
  return false;
}

/* ---- Selection toolbar -------------------------------------------------- */

function SelectionBar({ ids, onAct }: { ids: string[]; onAct: (a: string) => void }) {
  if (ids.length < 2) return null;
  const b = (a: string, icon: Parameters<typeof Icon>[0]['name'], label: string, binding?: string) => (
    <Tip label={label} binding={binding}>
      <button type="button" className="icon-btn icon-btn--sm" aria-label={label} onClick={() => onAct(a)}>
        <Icon name={icon} size={14} />
      </button>
    </Tip>
  );
  return (
    <div className="fsel m-glass-thick" role="toolbar" aria-label={`${ids.length} nodes selected`}>
      <span className="fsel__n">{ids.length} selected</span>
      <span className="fsel__sep" />
      <span className="fsel__txt">
        <button type="button" className="fsel__btn" onClick={() => onAct('left')}>
          Left
        </button>
        <button type="button" className="fsel__btn" onClick={() => onAct('hcenter')}>
          Centre
        </button>
        <button type="button" className="fsel__btn" onClick={() => onAct('top')}>
          Top
        </button>
        <button type="button" className="fsel__btn" onClick={() => onAct('vcenter')}>
          Middle
        </button>
        <button type="button" className="fsel__btn" onClick={() => onAct('dist-h')}>
          Space across
        </button>
        <button type="button" className="fsel__btn" onClick={() => onAct('dist-v')}>
          Space down
        </button>
      </span>
      <span className="fsel__sep" />
      {b('group', 'folder', 'Group', 'flow.group')}
      {b('subflow', 'layout', 'Collapse into a subflow', 'flow.subflow')}
      {b('block', 'star', 'Save as a team block')}
      {b('duplicate', 'copy', 'Duplicate', 'flow.duplicate')}
      {b('bypass', 'eye', 'Bypass or restore', 'flow.bypass')}
      {b('delete', 'trash', 'Delete', 'flow.delete')}
    </div>
  );
}

/* ---- Shortcut sheet -------------------------------------------------------- */

const SHEET: { id: string; label: string }[] = [
  { id: 'flow.add', label: 'Add a node (or double-click the canvas)' },
  { id: 'flow.panel', label: 'Open the selected node' },
  { id: 'flow.delete', label: 'Delete' },
  { id: 'flow.duplicate', label: 'Duplicate' },
  { id: 'flow.copy', label: 'Copy' },
  { id: 'flow.paste', label: 'Paste (works across flows)' },
  { id: 'flow.undo', label: 'Undo' },
  { id: 'flow.redo', label: 'Redo' },
  { id: 'flow.selectAll', label: 'Select everything' },
  { id: 'flow.group', label: 'Group' },
  { id: 'flow.subflow', label: 'Collapse into a subflow' },
  { id: 'flow.fit', label: 'Zoom to fit' },
  { id: 'flow.layout', label: 'Tidy the layout' },
  { id: 'flow.pin', label: 'Pin the last output' },
  { id: 'flow.bypass', label: 'Bypass' },
  { id: 'flow.issues', label: 'What to fix' },
  { id: 'flow.versions', label: 'Versions' },
  { id: 'flow.try', label: 'Try a message' },
  { id: 'flow.save', label: 'Save' },
];

/* ---- The editor ------------------------------------------------------------------- */

export function FlowEditor({
  flowId,
  back,
}: {
  flowId: string;
  back?: { to: string; label: string; params?: Record<string, string> };
}) {
  return (
    <ReactFlowProvider>
      <Editor flowId={flowId} back={back} />
      <AddModelDialog />
    </ReactFlowProvider>
  );
}

function Editor({
  flowId,
  back,
}: {
  flowId: string;
  back?: { to: string; label: string; params?: Record<string, string> };
}) {
  const flow = useFlow(flowId);
  const stats = useNodeStats(flowId).data;
  const rf = useReactFlow();
  const navigate = useNavigate();
  const wrap = useRef<HTMLDivElement>(null);
  const models = useFlowModels();
  const blocks = useFlows('workspace');
  const s = useEditor();
  const [addScreen, setAddScreen] = useState<{ x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [metaDraft, setMetaDraft] = useState<{ name?: string; description?: string }>({});
  const [saving, setSaving] = useState(false);
  const dragging = useRef(false);
  // Sizes the canvas measured, handed back on every render (controlled nodes
  // otherwise lose them, and the minimap and fit cannot see the nodes).
  const measured = useRef(new Map<string, { width: number; height: number }>());
  const [measureTick, setMeasureTick] = useState(0);
  const loadedVersion = useRef<string>('');

  // Load the flow (and a newer local draft, with a way to throw it away).
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per flow version
  useEffect(() => {
    const f = flow.data;
    if (!f) return;
    const key = `${f.id}@${f.version}`;
    if (loadedVersion.current === key) return;
    loadedVersion.current = key;
    const draft = readDraft(f.id);
    const useDraft =
      draft && draft.base === f.version && JSON.stringify(draft.graph) !== JSON.stringify(graphOf(f));
    s.load(metaOf(f), graphOf(f), useDraft ? draft.graph : null);
    setMetaDraft({});
    if (useDraft)
      notify({
        level: 'info',
        title: 'Your unsaved changes are back',
        body: `From ${new Date(draft.at).toLocaleString('en-GB', { timeStyle: 'short', dateStyle: 'short' })}. Save to keep them.`,
        undo: () => {
          dropDraft(f.id);
          s.load(metaOf(f), graphOf(f), null);
        },
      });
    requestAnimationFrame(() => void rf.fitView({ padding: 0.2, maxZoom: 1, duration: 0 }));
  }, [flow.data]);

  const dirty = isDirty(s) || !!metaDraft.name || metaDraft.description !== undefined;

  // Autosave the draft locally, and warn before closing the tab.
  useEffect(() => {
    if (!s.meta || !isDirty(s)) return;
    const t = setTimeout(() => s.meta && writeDraft(s.meta.id, s.graph, s.meta.version), 600);
    return () => clearTimeout(t);
  }, [s.graph, s.meta, s]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Check as you draw: locally at once, then Core's fuller check.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check on graph and model changes
  useEffect(() => {
    if (!s.meta) return;
    s.setValidation(localLint(s.graph, models.byId));
    const t = setTimeout(() => {
      validateGraph(s.graph)
        .then((v) => useEditor.getState().setValidation(v))
        .catch(() => undefined); // the local result stands
      // What crosses every edge, once per change of the graph.
      estimateContext({ graph: s.graph })
        .then((r) => useEditor.getState().setEstimates(r.edges))
        .catch((err) => useEditor.getState().setEstimates(needsCore(err) ? 'needs-core' : null));
    }, 700);
    return () => clearTimeout(t);
  }, [s.graph, models.byId, s.meta?.id]);

  // Router heat: recent decisions per router node.
  const routers = s.graph.nodes.filter((n) => n.kind === 'router' || n.kind === 'rule').map((n) => n.id);
  const decisions = useQueries({
    queries: routers.map((node) => ({
      queryKey: flowKeys.decisions(flowId, node),
      queryFn: () =>
        api.get<
          | { items: { chose: string[]; confidence: number | null }[] }
          | { chose: string[]; confidence: number | null }[]
        >(`/flows/${flowId}/decisions?node=${node}&limit=100`),
      retry: false,
      staleTime: 60_000,
    })),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when decisions arrive
  const heat = useMemo(() => {
    const out = new Map<string, { share: number; confidence: number | null; n: number }>();
    routers.forEach((node, i) => {
      const raw = decisions[i]?.data;
      const list = raw ? (Array.isArray(raw) ? raw : raw.items) : [];
      if (!list.length) return;
      const counts = new Map<string, { n: number; conf: number; c: number }>();
      for (const d of list)
        for (const r of d.chose) {
          const c = counts.get(r) ?? { n: 0, conf: 0, c: 0 };
          c.n++;
          if (d.confidence != null) {
            c.conf += d.confidence;
            c.c++;
          }
          counts.set(r, c);
        }
      for (const [r, c] of counts)
        out.set(`${node}:${r}`, {
          share: c.n / list.length,
          confidence: c.c ? c.conf / c.c : null,
          n: list.length,
        });
    });
    return out;
  }, [decisions.map((d) => d.dataUpdatedAt).join(','), routers.join(',')]);

  /* ---- Mapping to xyflow ---------------------------------------------------- */

  const collapsedGroups = new Set(
    s.graph.nodes.filter((n) => n.kind === 'group' && n.params.collapsed).map((n) => n.id),
  );
  const issuesBy = useMemo(() => {
    const m = new Map<string, NonNullable<typeof s.validation>['issues']>();
    for (const i of s.validation?.issues ?? [])
      if (i.node_id) m.set(i.node_id, [...(m.get(i.node_id) ?? []), i]);
    return m;
  }, [s.validation]);

  const toggleGroup = useCallback(
    (id: string) =>
      useEditor.getState().apply((g) => {
        const n = g.nodes.find((x) => x.id === id);
        return n?.kind === 'group' ? updateParams(g, id, { collapsed: !n.params.collapsed }) : g;
      }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from the editor state
  const nodes: Node[] = useMemo(() => {
    const list: Node[] = s.graph.nodes.map((n) => {
      const furniture = KINDS[n.kind].furniture;
      const size = sizeOf(n);
      const collapsed = n.kind === 'group' && n.params.collapsed;
      const data: CardData = {
        node: n,
        model: models.byId.get(modelOf(n) ?? ''),
        live: s.live?.nodes[n.id],
        decision: s.live?.decisions[n.id],
        stats: stats?.[n.id]?.runs
          ? {
              p50: stats[n.id]?.p50_ms ?? 0,
              p95: stats[n.id]?.p95_ms ?? 0,
              cost: stats[n.id]?.avg_cost_usd ?? 0,
            }
          : null,
        issues: issuesBy.get(n.id) ?? [],
        diff: s.compare
          ? s.compare.diff.added.includes(n.id)
            ? 'added'
            : s.compare.diff.changed.includes(n.id)
              ? 'changed'
              : null
          : null,
        onToggleGroup: toggleGroup,
      };
      return {
        id: n.id,
        type: n.kind === 'note' ? 'note' : n.kind === 'group' ? 'group' : 'card',
        position: n.position,
        data,
        selected: s.selected.includes(n.id),
        hidden: !!n.parent && collapsedGroups.has(n.parent),
        zIndex: n.kind === 'group' ? -1 : furniture ? 0 : 1,
        ...(furniture && {
          style: collapsed ? { width: 200, height: 40 } : { width: size.w, height: size.h },
        }),
        connectable: !furniture,
        // Known sizes until measured, so fit and the minimap see every node at once.
        initialWidth: collapsed ? 200 : size.w,
        initialHeight: collapsed ? 40 : size.h,
        ...(measured.current.has(n.id) && { measured: measured.current.get(n.id) }),
      } satisfies Node;
    });
    // Nodes a compared older version had, as ghosts where they were.
    if (s.compare)
      for (const id of s.compare.diff.removed) {
        const old = s.compare.graph.nodes.find((n) => n.id === id);
        if (old && !KINDS[old.kind].furniture)
          list.push({
            id: `ghost:${id}`,
            type: 'card',
            position: old.position,
            data: { node: old, issues: [], diff: null, ghost: true } as CardData,
            selectable: false,
            draggable: false,
            connectable: false,
            className: 'fghost',
          });
      }
    return list;
  }, [s.graph.nodes, s.selected, s.live, s.compare, issuesBy, models.byId, toggleGroup, measureTick, stats]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from the editor state
  const edges: Edge[] = useMemo(() => {
    const nodeById = new Map(s.graph.nodes.map((n) => [n.id, n]));
    return s.graph.edges.map((e) => {
      const from = nodeById.get(e.from);
      const ports = from ? outputPorts(from) : ['out'];
      const handle =
        e.label && ports.includes(e.label)
          ? e.label
          : ports.includes('out')
            ? 'out'
            : ports.includes('answer')
              ? 'answer'
              : ports[0];
      const data: EdgeData = {
        edge: e,
        heat: e.label ? (heat.get(`${e.from}:${e.label}`) ?? null) : null,
        travelled: !!s.live?.travelled.includes(`${e.from}>${e.to}`),
        diff: s.compare?.diff.edgesAdded.includes(`${e.from}>${e.to}:${e.label ?? ''}`) ? 'added' : null,
        dimmed: !!s.live && !s.live.travelled.includes(`${e.from}>${e.to}`),
      };
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: handle,
        targetHandle: 'in',
        type: 'flow',
        data,
        selected: s.selectedEdge === e.id,
        hidden:
          (!!from?.parent && collapsedGroups.has(from.parent)) ||
          (!!nodeById.get(e.to)?.parent && collapsedGroups.has(nodeById.get(e.to)?.parent as string)),
      } satisfies Edge;
    });
  }, [s.graph.edges, s.graph.nodes, s.selectedEdge, s.live, s.compare, heat]);

  /* ---- Changes from the canvas ------------------------------------------- */

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const st = useEditor.getState();
    const moves: Record<string, { x: number; y: number }> = {};
    let selection: string[] | null = null;
    const removed: string[] = [];
    let remeasure = false;
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        if (c.dragging && !dragging.current) {
          dragging.current = true;
          st.checkpoint();
        }
        if (!c.dragging) dragging.current = false;
        const old = st.graph.nodes.find((n) => n.id === c.id);
        if (!old) continue;
        const pos = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
        moves[c.id] = pos;
        // A group carries its members.
        if (old.kind === 'group') {
          const dx = pos.x - old.position.x;
          const dy = pos.y - old.position.y;
          for (const m of membersOf(st.graph, old.id))
            moves[m.id] = { x: m.position.x + dx, y: m.position.y + dy };
        }
      } else if (c.type === 'select') {
        const base: string[] = selection ?? useEditor.getState().selected;
        selection = c.selected ? [...new Set([...base, c.id])] : base.filter((x) => x !== c.id);
      } else if (c.type === 'remove') removed.push(c.id);
      else if (c.type === 'dimensions' && c.dimensions && !c.resizing) {
        const prev = measured.current.get(c.id);
        if (!prev || prev.width !== c.dimensions.width || prev.height !== c.dimensions.height) {
          measured.current.set(c.id, { width: c.dimensions.width, height: c.dimensions.height });
          remeasure = true;
        }
      } else if (c.type === 'dimensions' && c.dimensions && c.resizing) {
        const n = st.graph.nodes.find((x) => x.id === c.id);
        if (n && (n.kind === 'note' || n.kind === 'group'))
          st.apply(
            (g) =>
              updateNode(g, c.id, {
                size: {
                  w: Math.round(c.dimensions?.width ?? 200),
                  h: Math.round(c.dimensions?.height ?? 100),
                },
              } as never),
            { record: false },
          );
      }
    }
    if (Object.keys(moves).length) st.apply((g) => moveNodes(g, moves), { record: false });
    if (removed.length) st.apply((g) => removeNodes(g, removed));
    if (selection) st.select(selection.filter((x) => !x.startsWith('ghost:')));
    if (remeasure) setMeasureTick((t) => t + 1);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const st = useEditor.getState();
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) st.apply((g) => removeEdges(g, removed));
    const sel = changes.find((c) => c.type === 'select' && c.selected);
    if (sel && sel.type === 'select') st.select([], sel.id);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    useEditor.getState().apply((g) => connect(g, c.source, c.target, c.sourceHandle ?? undefined));
  }, []);

  /** Dropping a connection on empty canvas opens the search, already wired. */
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode) return;
      const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!pt) return;
      const at = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
      useEditor
        .getState()
        .setAdding({ at, from: { node: state.fromNode.id, label: state.fromHandle?.id ?? 'out' } });
      setAddScreen({ x: pt.clientX, y: pt.clientY });
    },
    [rf],
  );

  const openAdd = (screen?: { x: number; y: number }) => {
    const r = wrap.current?.getBoundingClientRect();
    const pt = screen ?? { x: (r?.left ?? 0) + (r?.width ?? 800) / 2 - 160, y: (r?.top ?? 0) + 120 };
    s.setAdding({ at: rf.screenToFlowPosition({ x: pt.x + 40, y: pt.y }) });
    setAddScreen(pt);
  };

  const onPick = async (p: Pick) => {
    const st = useEditor.getState();
    const adding = st.adding;
    const at = adding?.at ?? { x: 0, y: 0 };
    let kind: FlowNodeKind = 'model';
    let model: string | undefined;
    if (p.type === 'kind') kind = p.kind;
    else if (p.type === 'model') model = p.model.id;
    else kind = 'subflow';
    const id = nextId(st.graph, kind);
    let n = newNode(
      kind,
      id,
      { x: Math.round(at.x), y: Math.round(at.y - 40) },
      model ?? models.list.find((m) => m.chat && m.status === 'ready')?.id,
    );
    if (p.type === 'model') n = { ...n, label: p.model.name } as typeof n;
    if (p.type === 'block' && n.kind === 'subflow')
      n = { ...n, label: p.flow.name.replace(/^Block:\s*/, ''), params: { flow_id: p.flow.id } };
    st.apply((g) => {
      let next = addNode(g, n);
      if (adding?.from) next = connect(next, adding.from.node, id, adding.from.label);
      return next;
    });
    st.select([id]);
    st.setAdding(null);
    setAddScreen(null);
    wrap.current?.focus();
  };

  /* ---- Actions ------------------------------------------------------------------ */

  const save = async (message?: string) => {
    const st = useEditor.getState();
    if (!st.meta || saving) return;
    setSaving(true);
    try {
      const f = await saveFlow(
        st.meta.id,
        { ...st.graph, viewport: rf.getViewport() },
        {
          name: metaDraft.name ?? st.meta.name,
          description: metaDraft.description ?? st.meta.description,
          base_version: st.meta.version,
          ...(message && { message }),
        },
      );
      loadedVersion.current = `${f.id}@${f.version}`;
      st.markSaved(metaOf(f), st.graph);
      setMetaDraft({});
      dropDraft(f.id);
      notify({
        level: 'success',
        title: `Saved version ${f.version}`,
        body:
          f.published_version != null && f.published_version !== f.version
            ? 'It is a draft until you publish it.'
            : undefined,
      });
    } catch (err) {
      const conflict = (err as { status?: number }).status === 409;
      notify({
        level: needsCore(err) ? 'info' : 'error',
        title: needsCore(err)
          ? 'Saving flows needs a newer Core'
          : conflict
            ? 'Someone saved this flow since you opened it'
            : 'Not saved',
        body: needsCore(err)
          ? 'Your changes are kept in this browser as a draft.'
          : conflict
            ? 'Your changes are kept as a draft. Reload to see theirs, then reapply yours.'
            : (err as Error).message,
      });
    } finally {
      setSaving(false);
    }
  };

  const fitAll = () => void rf.fitView({ padding: 0.2, maxZoom: 1.2, duration: 280 });

  const layout = async () => {
    const next = await autoLayout(useEditor.getState().graph);
    useEditor.getState().apply(() => next);
    requestAnimationFrame(fitAll);
  };

  const makeBlock = async (ids: string[], replace: boolean) => {
    const st = useEditor.getState();
    if (!st.meta) return;
    const temp = collapseToSubflow(st.graph, ids, 'pending');
    if (!temp) return;
    try {
      const block = await createFlow({
        name: `Block: ${st.graph.nodes.find((n) => n.id === ids[0])?.label ?? 'Team'}`,
        description: `Made from ${st.meta.name}.`,
        scope: 'workspace',
        scope_ref: null,
        graph: temp.inner,
      });
      if (replace) {
        st.apply((g) => {
          const r = collapseToSubflow(g, ids, block.id);
          return r ? r.outer : g;
        });
        notify({
          level: 'success',
          title: 'Collapsed into a subflow',
          body: 'Double-click it to open and edit it in place.',
        });
      } else
        notify({
          level: 'success',
          title: `Saved ${block.name.replace(/^Block:\s*/, '')} as a team block`,
          body: 'Add it to any flow from the node search.',
        });
    } catch (err) {
      notify({
        level: needsCore(err) ? 'info' : 'error',
        title: needsCore(err) ? 'Team blocks need a newer Core' : 'Not saved',
        body: needsCore(err) ? 'They are stored as flows in Core.' : (err as Error).message,
      });
    }
  };

  const act = (a: string) => {
    const st = useEditor.getState();
    const ids = st.selected;
    switch (a) {
      case 'left':
      case 'hcenter':
      case 'top':
      case 'vcenter':
      case 'right':
      case 'bottom':
        return st.apply((g) => align(g, ids, a));
      case 'dist-h':
        return st.apply((g) => distribute(g, ids, 'h'));
      case 'dist-v':
        return st.apply((g) => distribute(g, ids, 'v'));
      case 'group': {
        let made: string | null = null;
        st.apply((g) => {
          const r = group(g, ids);
          made = r.id;
          return r.graph;
        });
        if (made) st.select([made]);
        return;
      }
      case 'subflow':
        return void makeBlock(ids, true);
      case 'block':
        return void makeBlock(ids, false);
      case 'duplicate': {
        let made: string[] = [];
        st.apply((g) => {
          const r = duplicate(g, ids);
          made = r.ids;
          return r.graph;
        });
        st.select(made);
        return;
      }
      case 'bypass': {
        const on = !st.graph.nodes.filter((n) => ids.includes(n.id)).every((n) => n.disabled);
        return st.apply((g) => setDisabled(g, ids, on));
      }
      case 'delete':
        st.apply((g) =>
          removeNodes(
            g,
            ids.filter((id) => st.graph.nodes.find((n) => n.id === id)?.kind !== 'input'),
          ),
        );
        return st.select([]);
    }
  };

  /* ---- Keyboard ------------------------------------------------------------- */

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const st = useEditor.getState();
    const typing = isTyping(e.target);
    let handled = true;
    if (matches(e, 'flow.save')) void save();
    else if (matches(e, 'flow.try')) st.setPanel('try');
    else if (typing || addScreen) handled = false;
    else if (matches(e, 'flow.add')) openAdd();
    else if (matches(e, 'flow.delete') || e.key === 'Backspace') {
      if (st.selectedEdge) st.apply((g) => removeEdges(g, [st.selectedEdge as string]));
      else act('delete');
    } else if (matches(e, 'flow.undo')) st.undo();
    else if (matches(e, 'flow.redo') || (e.ctrlKey && e.key === 'y')) st.redo();
    else if (matches(e, 'flow.duplicate')) act('duplicate');
    else if (matches(e, 'flow.copy') || matches(e, 'flow.cut')) {
      writeClip(copy(st.graph, st.selected));
      if (matches(e, 'flow.cut')) act('delete');
    } else if (matches(e, 'flow.paste')) {
      const clip = readClip();
      if (clip) {
        let made: string[] = [];
        st.apply((g) => {
          const r = paste(g, clip);
          made = r.ids;
          return r.graph;
        });
        st.select(made);
      }
    } else if (matches(e, 'flow.selectAll')) st.select(st.graph.nodes.map((n) => n.id));
    else if (matches(e, 'flow.group')) act('group');
    else if (matches(e, 'flow.ungroup')) {
      for (const id of st.selected)
        if (st.graph.nodes.find((n) => n.id === id)?.kind === 'group') st.apply((g) => ungroup(g, id));
    } else if (matches(e, 'flow.subflow')) act('subflow');
    else if (matches(e, 'flow.fit')) fitAll();
    else if (matches(e, 'flow.layout')) void layout();
    else if (matches(e, 'flow.bypass')) act('bypass');
    else if (matches(e, 'flow.pin')) {
      const n = st.graph.nodes.find((x) => x.id === st.selected[0]);
      if (n?.kind === 'model') {
        if (n.params.pinned_output) st.apply((g) => updateParams(g, n.id, { pinned_output: undefined }));
        else {
          const out = st.live?.nodes[n.id]?.text;
          if (out) st.apply((g) => updateParams(g, n.id, { pinned_output: out }));
          else
            notify({
              level: 'info',
              title: 'Nothing to pin yet',
              body: 'Run it once (Try a message), then pin its output.',
            });
        }
      }
    } else if (matches(e, 'flow.issues')) st.setPanel(st.panel === 'lint' ? null : 'lint');
    else if (matches(e, 'flow.versions')) st.setPanel(st.panel === 'versions' ? null : 'versions');
    else if (matches(e, 'flow.panel') && st.selected.length === 1) st.setPanel('node');
    else if (e.key === 'Escape') {
      if (st.compare) st.setCompare(null);
      else if (st.selected.length || st.selectedEdge) st.select([]);
      else if (st.panel) st.setPanel(null);
      else handled = false;
    } else if (e.key === '?') setSheet((v) => !v);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /* ---- Render ---------------------------------------------------------------- */

  if (flow.isPending)
    return (
      <div className="feditor feditor--loading">
        <Skeleton lines={6} label="Opening the flow" />
      </div>
    );
  if (flow.isError || !flow.data)
    return (
      <div className="feditor feditor--loading">
        <EmptyState
          icon="branch"
          title={needsCore(flow.error) ? 'Flows need a newer Core' : 'This flow is not here'}
          body={
            needsCore(flow.error)
              ? 'This Core cannot store or run flows yet. Update it and come back.'
              : 'It may have been deleted. Your other flows are in the list.'
          }
          action={{ label: 'All flows', onClick: () => void navigate({ to: '/flows' }) }}
        />
      </div>
    );

  const meta = s.meta;
  const errs = s.validation?.issues.filter((i) => i.level === 'error').length ?? 0;
  const warns = (s.validation?.issues.length ?? 0) - errs;
  const runnable = s.graph.nodes.filter(
    (n) => !KINDS[n.kind].furniture && n.kind !== 'input' && n.kind !== 'output',
  ).length;
  const selectedNode =
    s.selected.length === 1 ? s.graph.nodes.find((n) => n.id === s.selected[0]) : undefined;
  const selectedEdge = s.selectedEdge ? s.graph.edges.find((e) => e.id === s.selectedEdge) : undefined;
  const panel =
    s.panel === 'node' && !selectedNode ? null : s.panel === 'edge' && !selectedEdge ? null : s.panel;
  const name = metaDraft.name ?? meta?.name ?? '';
  const draftOnly = meta && meta.published !== null && meta.published !== meta.version;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the canvas takes keyboard shortcuts; its controls are the interactive parts
    <div
      className="feditor"
      ref={wrap}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-live={s.live?.state}
      data-comparing={s.compare ? true : undefined}
    >
      <header className="ftool m-glass">
        {back ? (
          <Link
            to={back.to}
            params={back.params as never}
            className="icon-btn icon-btn--sm"
            aria-label={`Back to ${back.label}`}
          >
            <Icon name="chevronLeft" size={14} />
          </Link>
        ) : null}
        <button
          type="button"
          className="ftool__name"
          onClick={() => s.setPanel('settings')}
          title="Rename, limits and teamwork"
        >
          <span className="ftool__title">{name}</span>
          <span className="ftool__state" data-dirty={dirty || undefined}>
            {dirty ? 'Unsaved' : draftOnly ? `Draft v${meta?.version}` : `v${meta?.version}`}
            {meta && !dirty && !draftOnly ? <Icon name="seal" size={11} /> : null}
          </span>
        </button>
        <span className="ftool__sep" />
        <Tip label="Undo" binding="flow.undo">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Undo"
            disabled={!s.history.past.length}
            onClick={s.undo}
          >
            <Icon name="undo" size={14} />
          </button>
        </Tip>
        <Tip label="Redo" binding="flow.redo">
          <button
            type="button"
            className="icon-btn icon-btn--sm ftool__redo"
            aria-label="Redo"
            disabled={!s.history.future.length}
            onClick={s.redo}
          >
            <Icon name="undo" size={14} />
          </button>
        </Tip>
        <span className="ftool__sep" />
        <Tip label="Add a node" binding="flow.add">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openAdd()}>
            <Icon name="plus" size={13} /> Add
          </button>
        </Tip>
        <Tip label="Tidy the layout" binding="flow.layout">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Tidy the layout"
            onClick={() => void layout()}
          >
            <Icon name="grid" size={14} />
          </button>
        </Tip>
        <Tip label="Zoom to fit" binding="flow.fit">
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Zoom to fit" onClick={fitAll}>
            <Icon name="expand" size={14} />
          </button>
        </Tip>
        <span className="ftool__spacer" />
        <Tip label="What to fix" binding="flow.issues">
          <button
            type="button"
            className="ftool__lint"
            data-state={errs ? 'error' : warns ? 'warning' : 'ok'}
            aria-pressed={panel === 'lint'}
            onClick={() => s.setPanel(panel === 'lint' ? null : 'lint')}
          >
            <Icon name={errs ? 'alert' : warns ? 'warn' : 'check'} size={13} />
            {errs || warns ? `${errs + warns}` : 'Ready'}
          </button>
        </Tip>
        <Tip label="Close routing calls">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Close routing calls"
            aria-pressed={panel === 'calls'}
            onClick={() => s.setPanel(panel === 'calls' ? null : 'calls')}
          >
            <Icon name="inbox" size={14} />
          </button>
        </Tip>
        <Tip label="Versions and publishing" binding="flow.versions">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Versions"
            aria-pressed={panel === 'versions'}
            onClick={() => s.setPanel(panel === 'versions' ? null : 'versions')}
          >
            <Icon name="clock" size={14} />
          </button>
        </Tip>
        <Tip label="Shortcuts">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Shortcuts"
            aria-pressed={sheet}
            onClick={() => setSheet((v) => !v)}
          >
            <Icon name="keyboard" size={14} />
          </button>
        </Tip>
        <Tip label="Try a message" binding="flow.try">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-pressed={panel === 'try'}
            onClick={() => s.setPanel(panel === 'try' ? null : 'try')}
            data-tour="flow-try"
          >
            <Icon name="play" size={13} /> Try
          </button>
        </Tip>
        <Tip label="Save" binding="flow.save">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!dirty || saving}
            data-busy={saving || undefined}
            onClick={() => void save()}
          >
            Save
          </button>
        </Tip>
      </header>

      <div className="feditor__body">
        <div className="fcanvas" data-tour="flow-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onPaneClick={() => {
              s.select([]);
              setAddScreen(null);
            }}
            onNodeClick={(e, node) => {
              // Clicking a node always opens it, even if it was already selected.
              if (e.shiftKey || e.metaKey || e.ctrlKey || node.id.startsWith('ghost:')) return;
              const st = useEditor.getState();
              if (!st.selected.includes(node.id) || st.selected.length > 1) st.select([node.id]);
              else st.setPanel('node');
            }}
            onNodeDoubleClick={(_, node) => {
              const n = s.graph.nodes.find((x) => x.id === node.id);
              if (n?.kind === 'subflow' && n.params.flow_id)
                void navigate({ to: '/flows/$flowId', params: { flowId: n.params.flow_id } });
              else s.setPanel('node');
            }}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).classList.contains('react-flow__pane'))
                openAdd({ x: e.clientX, y: e.clientY });
            }}
            isValidConnection={(c) => c.source !== c.target}
            snapToGrid
            snapGrid={[16, 16]}
            selectionOnDrag
            panOnDrag={[1, 2]}
            panOnScroll
            zoomOnDoubleClick={false}
            panActivationKeyCode="Space"
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            deleteKeyCode={null}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: false }}
            colorMode="system"
            defaultEdgeOptions={{ type: 'flow' }}
            connectionRadius={28}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="fcanvas__bg" />
            <MiniMap
              pannable
              zoomable
              className="fcanvas__map"
              nodeBorderRadius={8}
              nodeColor="var(--chalk-2)"
              nodeStrokeColor="var(--hair-2)"
            />
          </ReactFlow>

          <SelectionBar ids={s.selected} onAct={act} />

          {runnable === 0 && !s.live ? (
            <div className="fempty m-glass-thick">
              <span className="fempty__mark">
                <Icon name="branch" size={18} />
              </span>
              <h2>Draw how your messages are answered</h2>
              <p>
                Press <Kbd keys="tab" /> or double-click to add a node. Drag from a port into empty space to
                add what comes next. Type a model’s name to drop it in, already set up.
              </p>
              <div className="fempty__actions">
                <button type="button" className="btn btn--primary btn--sm" onClick={() => openAdd()}>
                  <Icon name="plus" size={12} /> Add a node
                </button>
              </div>
            </div>
          ) : null}

          {s.live ? (
            <div className="flive m-glass" data-state={s.live.state}>
              <span className="flive__dot" aria-hidden="true" />
              {s.live.state === 'running' ? 'Running' : s.live.state === 'failed' ? 'Stopped' : 'Done'} ·{' '}
              {Object.values(s.live.nodes).filter((n) => n.status !== 'running').length} steps · $
              {s.live.cost.toFixed(4)}
              <button type="button" className="fp-link" onClick={s.clearLive}>
                Clear
              </button>
            </div>
          ) : null}

          {sheet ? (
            <div className="fsheet m-glass-thick" role="dialog" aria-label="Flow editor shortcuts">
              <header>
                <h3>Shortcuts</h3>
                <button
                  type="button"
                  className="icon-btn icon-btn--xs"
                  aria-label="Close"
                  onClick={() => setSheet(false)}
                >
                  <Icon name="close" size={11} />
                </button>
              </header>
              <ul>
                {SHEET.map((r) => (
                  <li key={r.id}>
                    <span>{r.label}</span>
                    <Kbd keys={keysFor(r.id) ?? ''} binding={r.id} />
                  </li>
                ))}
                <li>
                  <span>Pan</span>
                  <span className="fsheet__k">Space + drag, or scroll</span>
                </li>
                <li>
                  <span>Select several</span>
                  <span className="fsheet__k">Drag on the canvas, or Shift + click</span>
                </li>
              </ul>
            </div>
          ) : null}

          {addScreen ? (
            <AddNode
              screen={addScreen}
              fromPort={!!s.adding?.from}
              models={models.list}
              blocks={(blocks.data ?? []).filter(
                (f: FlowSummary) => f.name.startsWith('Block:') && f.id !== flowId,
              )}
              hasInput={s.graph.nodes.some((n) => n.kind === 'input')}
              onPick={(p) => void onPick(p)}
              onClose={() => {
                setAddScreen(null);
                s.setAdding(null);
                wrap.current?.focus();
              }}
            />
          ) : null}
        </div>

        {panel ? (
          <aside className="fpanel m-glass" aria-label="Details">
            <button
              type="button"
              className="icon-btn icon-btn--xs fpanel__close"
              aria-label="Close the panel"
              onClick={() => s.setPanel(null)}
            >
              <Icon name="close" size={11} />
            </button>
            {panel === 'node' && selectedNode ? (
              <NodePanel node={selectedNode} models={models.list} flowId={meta?.id} />
            ) : null}
            {panel === 'edge' && selectedEdge ? <EdgePanel edge={selectedEdge} /> : null}
            {panel === 'try' ? (
              <TryPanel scopeRef={meta?.scope === 'notebook' ? meta.scopeRef : null} />
            ) : null}
            {panel === 'lint' ? <LintPanel /> : null}
            {panel === 'versions' ? (
              <VersionsPanel
                onSaved={() => {
                  loadedVersion.current = '';
                  void flow.refetch();
                }}
              />
            ) : null}
            {panel === 'calls' ? <CloseCallsPanel /> : null}
            {panel === 'settings' ? (
              <SettingsPanel onMeta={(p) => setMetaDraft((m) => ({ ...m, ...p }))} />
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
