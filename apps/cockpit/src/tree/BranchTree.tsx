/**
 * ------------------------------------------------------------------
 *  Title    |  Branch tree
 *  Ref      |  DESIGN.md §8.2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The thread as the tree it really is: every edit,
 *           |  regenerate and branch, where each one split off, and
 *           |  the path you are on drawn in signal.
 *  How      |  Core folds linear runs into one node (GET /tree); elk
 *           |  lays the nodes out top to bottom in creation order, and
 *           |  xyflow draws them. Nodes slide to their new place when
 *           |  the tree changes; the active path draws itself once.
 *           |  Keys are handled here, not by the global keymap, so
 *           |  they work the same in the drawer and full screen (where
 *           |  a dialog pauses single keys): j and k walk child and
 *           |  parent, h and l move between siblings, Enter jumps the
 *           |  conversation there, c compares with where you are.
 *  Note     |  Right-click a node for everything else.
 * ------------------------------------------------------------------
 */

import type { BranchTreeNode, BranchTree as Tree } from '@nvx/contracts';
import {
  Background,
  BackgroundVariant,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import '@xyflow/react/dist/base.css';
import { motion } from 'motion/react';
import { type CSSProperties, type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from 'react';
import { chordOf } from '../keys/dispatch';
import { keysFor, normalise } from '../keys/registry';
import { branchHere, jumpTo, useBranchTree } from '../lib/branching';
import { keys } from '../lib/data';
import { hueVar, modelById } from '../lib/format';
import { queryClient } from '../lib/query';
import type { ThreadView } from '../lib/types';
import { Icon } from '../ui/Icon';
import type { MenuEntry } from '../ui/Menu';
import { EmptyState, Skeleton } from '../ui/primitives';
import { askDelete, openCompare, useBranchLayer } from './store';

const elk = new ELK();

type Variant = 'panel' | 'full';
const SIZE: Record<Variant, { w: number; h: number }> = {
  panel: { w: 220, h: 58 },
  full: { w: 264, h: 66 },
};
/** Below this zoom node text is too small to read. */
const READABLE_ZOOM: Record<Variant, number> = { panel: 0.72, full: 0.6 };

export interface MsgNodeData extends Record<string, unknown> {
  node: BranchTreeNode;
  names: { id: string; name: string; color: string }[];
  selected: boolean;
  compare: boolean;
  head: boolean;
  variant: Variant;
  /** The flow that answered this node, when one did (DESIGN §16.3). */
  route: { name: string; version: number } | null;
}

type MsgNode = Node<MsgNodeData, 'msg'>;

const MsgNodeView = memo(function MsgNodeView({ data }: NodeProps<MsgNode>) {
  const { node, names, selected, compare, head, variant, route } = data;
  const model = modelById(node.model_id);
  return (
    <div
      className="tnode"
      data-role={node.role}
      data-active={node.active || undefined}
      data-selected={selected || undefined}
      data-compare={compare || undefined}
      data-head={head || undefined}
      data-status={node.status}
      data-variant={variant}
    >
      <Handle type="target" position={Position.Top} className="tnode__handle" isConnectable={false} />
      <span className="tnode__glyph" aria-hidden="true" />
      <span className="tnode__body">
        {names.length ? (
          <span className="tnode__names">
            {names.map((b) => (
              <span
                key={b.id}
                className="tnode__name"
                style={{ '--hue': hueVar(b.color as never) } as CSSProperties}
              >
                {b.name}
              </span>
            ))}
          </span>
        ) : null}
        <span className="tnode__preview">
          {node.preview || (node.role === 'user' ? 'Your message' : 'Reply')}
        </span>
      </span>
      <span className="tnode__meta">
        {node.collapsed > 0 ? (
          <span className="tnode__count" data-num title={`${node.collapsed} more in a straight line`}>
            +{node.collapsed}
          </span>
        ) : null}
        {route ? (
          <span
            className="tnode__route"
            title={`Answered by the flow ${route.name}, version ${route.version}`}
          >
            <Icon name="tree" size={9} />
            <span data-num>v{route.version}</span>
          </span>
        ) : null}
        {model ? (
          <span
            className="tnode__model"
            style={{ '--hue': hueVar(model.hue) } as CSSProperties}
            title={model.name}
            role="img"
            aria-label={model.name}
          />
        ) : null}
      </span>
      {head ? <span className="tnode__here">You are here</span> : null}
      <Handle type="source" position={Position.Bottom} className="tnode__handle" isConnectable={false} />
    </div>
  );
});

const NODE_TYPES = { msg: MsgNodeView };

/** Lay the tree out top to bottom, children in the order they were written. */
async function layout(tree: Tree, variant: Variant): Promise<Map<string, { x: number; y: number }>> {
  const { w, h } = SIZE[variant];
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': variant === 'full' ? '44' : '30',
      'elk.spacing.nodeNode': variant === 'full' ? '28' : '18',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: tree.nodes.map((n) => ({ id: n.id, width: w, height: h })),
    edges: tree.nodes
      .filter((n) => n.parent_id)
      .map((n) => ({ id: `${n.parent_id}->${n.id}`, sources: [n.parent_id as string], targets: [n.id] })),
  });
  return new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }] as const));
}

function matches(e: KeyboardEvent, id: string): boolean {
  const keys = keysFor(id);
  return !!keys && normalise(keys) === chordOf(e.nativeEvent);
}

function Canvas({ threadId, variant, tree }: { threadId: string; variant: Variant; tree: Tree }) {
  const flow = useReactFlow();
  const [pos, setPos] = useState<Map<string, { x: number; y: number }> | null>(null);
  // "You are here" is the node holding the head you are on, not the first
  // node of the active path (every ancestor is on the path too).
  const headNode = useMemo(
    () =>
      tree.nodes.find((n) => n.end_id === tree.active_head_id)?.id ??
      tree.nodes.findLast((n) => n.active)?.id ??
      tree.nodes.at(-1)?.id,
    [tree],
  );
  const [selected, setSelected] = useState<string | undefined>(headNode);
  const [compareWith, setCompareWith] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ n: BranchTreeNode; x: number; y: number } | null>(null);
  const fitted = useRef(false);
  const [overflow, setOverflow] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void layout(tree, variant).then((p) => live && setPos(p));
    return () => {
      live = false;
    };
  }, [tree, variant]);

  // Keep the cursor on a node that exists.
  useEffect(() => {
    if (!selected || !tree.nodes.some((n) => n.id === selected)) setSelected(headNode);
  }, [tree, selected, headNode]);

  const byId = useMemo(() => new Map(tree.nodes.map((n) => [n.id, n] as const)), [tree]);
  const kids = useMemo(() => {
    const m = new Map<string | null, BranchTreeNode[]>();
    for (const n of tree.nodes) m.set(n.parent_id, [...(m.get(n.parent_id) ?? []), n]);
    return m;
  }, [tree]);
  const branchById = useMemo(() => new Map(tree.branches.map((b) => [b.id, b] as const)), [tree]);
  // Which flow answered a node: from the tree itself when Core sends it, else
  // from the messages already loaded for this thread (the visible path).
  const loaded = queryClient.getQueryData<ThreadView>(keys.thread(threadId));
  const routeOf = useMemo(() => {
    const byId = new Map((loaded?.messages ?? []).map((m) => [m.id, m.provenance?.flow]));
    return (n: BranchTreeNode): MsgNodeData['route'] => {
      const own = (n as BranchTreeNode & { flow?: { name: string; version: number } | null }).flow;
      if (own) return { name: own.name, version: own.version };
      const f = byId.get(n.end_id) ?? byId.get(n.id);
      return f ? { name: f.name, version: f.version } : null;
    };
  }, [loaded]);

  const activeIds = useMemo(() => new Set(tree.nodes.filter((n) => n.active).map((n) => n.id)), [tree]);

  const nodes: MsgNode[] = useMemo(
    () =>
      pos
        ? tree.nodes.map((n) => ({
            id: n.id,
            type: 'msg' as const,
            position: pos.get(n.id) ?? { x: 0, y: 0 },
            // Known sizes, so the minimap can draw nodes before they are measured.
            width: SIZE[variant].w,
            height: SIZE[variant].h,
            draggable: false,
            selectable: false,
            data: {
              node: n,
              names: n.branch_ids.flatMap((id) => {
                const b = branchById.get(id);
                return b ? [{ id: b.id, name: b.name, color: b.color }] : [];
              }),
              selected: n.id === selected,
              compare: n.id === compareWith,
              head: n.id === headNode,
              variant,
              route: routeOf(n),
            },
          }))
        : [],
    [pos, tree, selected, compareWith, headNode, branchById, variant, routeOf],
  );

  const edges: Edge[] = useMemo(
    () =>
      tree.nodes
        .filter((n) => n.parent_id)
        .map((n) => {
          const active = activeIds.has(n.id) && activeIds.has(n.parent_id as string);
          return {
            id: `${n.parent_id}->${n.id}`,
            source: n.parent_id as string,
            target: n.id,
            // Curves, not orthogonal steps: steps drew small hooks under
            // every fork where sibling edges shared a corridor.
            type: 'simplebezier',
            className: active ? 'tedge tedge--active' : 'tedge',
            zIndex: active ? 1 : 0,
          } as Edge;
        }),
    [tree, activeIds],
  );

  // Fit once when the layout first lands; after that, follow the cursor.
  useEffect(() => {
    if (!pos || fitted.current) return;
    fitted.current = true;
    requestAnimationFrame(async () => {
      const target = selected ? pos.get(selected) : undefined;
      // Fit the whole tree when it stays readable; otherwise open centred on
      // where you are at a size you can read, and let the minimap show the rest.
      await flow.fitView({ padding: 0.15, duration: 0, maxZoom: 1 });
      if (flow.getZoom() < READABLE_ZOOM[variant]) {
        // Part of the tree is now off screen: say so (minimap, edge fade).
        setOverflow(true);
        if (target)
          void flow.setCenter(target.x + SIZE[variant].w / 2, target.y + SIZE[variant].h / 2, {
            zoom: READABLE_ZOOM[variant] + 0.1,
          });
      }
    });
  }, [pos, flow, selected, variant]);

  const select = (id: string | undefined) => {
    if (!id) return;
    setSelected(id);
    const p = pos?.get(id);
    if (p)
      void flow.setCenter(p.x + SIZE[variant].w / 2, p.y + SIZE[variant].h / 2, {
        zoom: flow.getZoom(),
        duration: 220,
      });
  };

  const siblingsOf = (n: BranchTreeNode) => kids.get(n.parent_id) ?? [n];

  const jump = (n: BranchTreeNode | undefined) => {
    if (n)
      void jumpTo(threadId, n.end_id).then(
        (ok) => ok && variant === 'full' && useBranchLayer.getState().setFull(false),
      );
  };

  /** c, or the menu: compare this point with where you are now. */
  const compareTo = (n: BranchTreeNode | undefined) => {
    if (!n || !tree.active_head_id) return;
    if (compareWith && compareWith !== n.id) return markCompare(n);
    if (tree.active_path.includes(n.end_id)) return setCompareWith(n.id);
    openCompare(threadId, tree.active_head_id, n.end_id);
  };

  /** Shift-click: the first click marks one side, the second opens the comparison. */
  const markCompare = (n: BranchTreeNode | undefined) => {
    if (!n) return;
    const first = compareWith ? byId.get(compareWith) : undefined;
    if (!first || first.id === n.id) return setCompareWith(first?.id === n.id ? null : n.id);
    setCompareWith(null);
    openCompare(threadId, first.end_id, n.end_id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = selected ? byId.get(selected) : undefined;
    if (!n) return;
    let handled = true;
    if (matches(e, 'tree.parent')) select(n.parent_id ?? undefined);
    else if (matches(e, 'tree.child')) {
      const c = kids.get(n.id) ?? [];
      select((c.find((x) => x.active) ?? c[0])?.id);
    } else if (matches(e, 'tree.prevSibling') || matches(e, 'tree.nextSibling')) {
      const s = siblingsOf(n);
      const i = s.findIndex((x) => x.id === n.id);
      select(s[i + (matches(e, 'tree.prevSibling') ? -1 : 1)]?.id);
    } else if (matches(e, 'tree.open')) jump(n);
    else if (matches(e, 'tree.compare')) compareTo(n);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const el = wrap.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${n.id}"]`);
      const r = el?.getBoundingClientRect();
      setMenu({ n, x: r ? r.left + 16 : 40, y: r ? r.bottom + 4 : 40 });
    } else if (e.key === 'Escape' && compareWith) setCompareWith(null);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const menuFor = (n: BranchTreeNode): MenuEntry[] => {
    const names = n.branch_ids.flatMap((id) => {
      const b = branchById.get(id);
      return b ? [b] : [];
    });
    return [
      { label: 'Jump here', icon: 'arrowRight', keys: keysFor('tree.open'), onSelect: () => jump(n) },
      {
        label: 'Branch from here',
        icon: 'branch',
        disabled: n.status === 'pending' || n.status === 'streaming',
        onSelect: () => {
          if (variant === 'full') useBranchLayer.getState().setFull(false);
          void branchHere(threadId, n.end_id, { previousHead: tree.active_head_id });
        },
      },
      {
        label: 'Compare with where you are',
        icon: 'compare',
        keys: keysFor('tree.compare'),
        disabled: tree.active_path.includes(n.end_id),
        onSelect: () => compareTo(n),
      },
      ...(names.length
        ? ([
            { kind: 'separator' },
            ...names.map((b) => ({
              label: `Rename ${b.name}`,
              icon: 'edit' as const,
              onSelect: () => useBranchLayer.getState().setRename({ threadId, branch: b }),
            })),
          ] as MenuEntry[])
        : []),
      { kind: 'separator' },
      {
        label: 'Delete from here',
        icon: 'trash',
        danger: true,
        disabled: n.status === 'pending' || n.status === 'streaming',
        onSelect: () => void askDelete(threadId, n.id),
      },
    ];
  };

  const showMap = overflow || tree.nodes.length > (variant === 'full' ? 10 : 18);

  return (
    <div
      ref={wrap}
      className="btree"
      data-variant={variant}
      data-overflow={overflow || undefined}
      role="tree"
      aria-label="Branches in this thread"
      aria-activedescendant={selected ? `tnode-${selected}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {!pos ? <Skeleton lines={4} label="Laying out the tree" /> : null}
      <ReactFlow<MsgNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnDoubleClick={false}
        minZoom={0.25}
        maxZoom={1.6}
        onNodeClick={(e, node) => {
          if (e.shiftKey) markCompare(byId.get(node.id));
          else select(node.id);
          wrap.current?.focus();
        }}
        onNodeDoubleClick={(_, node) => jump(byId.get(node.id))}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          const n = byId.get(node.id);
          if (!n) return;
          setSelected(n.id);
          setMenu({ n, x: e.clientX, y: e.clientY });
        }}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="btree__bg" />
        {showMap ? (
          <MiniMap
            pannable
            zoomable
            className="btree__map"
            nodeBorderRadius={6}
            nodeColor="var(--chalk-2)"
            nodeStrokeColor="var(--hair-2)"
            nodeStrokeWidth={2}
            nodeClassName={(n) => ((n.data as MsgNodeData).node.active ? 'is-active' : '')}
          />
        ) : null}
      </ReactFlow>
      {/* Accessible mirror of the canvas: one item per node, in tree order. */}
      <ul className="sr-only">
        {tree.nodes.map((n) => (
          // biome-ignore lint/a11y/useFocusableInteractive: the tree owns focus via aria-activedescendant
          <li
            key={n.id}
            id={`tnode-${n.id}`}
            role="treeitem"
            aria-selected={n.id === selected}
            aria-current={n.active || undefined}
          >
            {n.role === 'user' ? 'You' : 'Reply'}: {n.preview}
            {n.collapsed ? `, and ${n.collapsed} more` : ''}
          </li>
        ))}
      </ul>
      {menu ? (
        <FloatingMenu x={menu.x} y={menu.y} items={menuFor(menu.n)} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}

/** A node's menu, opened where you right-clicked (or under the node, from the keyboard). */
function FloatingMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as globalThis.Node)) return;
      onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);
  const flat = items.filter((i) => i.kind !== 'sub' && i.kind !== 'label');
  return (
    <motion.div
      ref={ref}
      className="menu menu--floating"
      role="menu"
      style={{ left: Math.min(x, window.innerWidth - 260), top: Math.min(y, window.innerHeight - 280) }}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
      onKeyDown={(e) => {
        const all = [
          ...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ??
            []),
        ];
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'ArrowDown') all[(i + 1) % all.length]?.focus();
        else if (e.key === 'ArrowUp') all[(i - 1 + all.length) % all.length]?.focus();
        else return;
        e.preventDefault();
      }}
    >
      {flat.map((e, i) =>
        e.kind === 'separator' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity but their place
          <div key={`sep-${i}`} className="menu__sep" role="separator" />
        ) : e.kind === undefined || e.kind === 'item' ? (
          <div
            key={e.label}
            role="menuitem"
            tabIndex={-1}
            className="menu__item"
            data-danger={e.danger || undefined}
            aria-disabled={e.disabled || undefined}
            data-disabled={e.disabled || undefined}
            onClick={() => {
              if (e.disabled) return;
              onClose();
              e.onSelect();
            }}
            onKeyDown={(k) => {
              if ((k.key === 'Enter' || k.key === ' ') && !e.disabled) {
                k.preventDefault();
                onClose();
                e.onSelect();
              }
            }}
          >
            {e.icon ? <Icon name={e.icon} size={14} /> : <span className="menu__noicon" />}
            <span className="menu__text">{e.label}</span>
          </div>
        ) : null,
      )}
    </motion.div>
  );
}

export function BranchTree({ threadId, variant = 'panel' }: { threadId: string; variant?: Variant }) {
  const q = useBranchTree(threadId);
  if (q.isPending) return <Skeleton lines={5} label="Loading the tree" />;
  if (q.isError || !q.data)
    return (
      <EmptyState
        icon="tree"
        title="The tree did not load"
        body="Check that NVX Ancile is running, then open the tree again."
      />
    );
  if (q.data.nodes.length === 0)
    return (
      <EmptyState
        icon="tree"
        title="Nothing to branch yet"
        body="Send a message. Every edit, regenerate and branch after that shows up here."
      />
    );
  return (
    <ReactFlowProvider>
      <Canvas threadId={threadId} variant={variant} tree={q.data} />
    </ReactFlowProvider>
  );
}
