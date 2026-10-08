/**
 * ------------------------------------------------------------------
 *  Title    |  Flow auto-layout
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Tidy a flow left to right in one keypress (L): the
 *           |  message enters on the left, the answer leaves on the
 *           |  right, routes fan out top to bottom in their order.
 *  How      |  elk "layered" with model order respected, so the same
 *           |  graph always lays out the same way. Notes and groups
 *           |  keep their place; group frames are refitted around
 *           |  their members afterwards.
 * ------------------------------------------------------------------
 */

import type { FlowGraph, FlowNode } from '@nvx/contracts';
import ELK from 'elkjs/lib/elk.bundled.js';
import { boundsOf, NODE_H, NODE_W, sizeOf } from './graph';

const elk = new ELK();

export async function autoLayout(g: FlowGraph): Promise<FlowGraph> {
  const laid = g.nodes.filter((n) => n.kind !== 'note' && n.kind !== 'group');
  if (!laid.length) return g;
  const ids = new Set(laid.map((n) => n.id));
  const out = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.spacing.nodeNode': '40',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.edgeRouting': 'SPLINES',
    },
    children: laid.map((n) => ({ id: n.id, width: sizeOf(n).w || NODE_W, height: sizeOf(n).h || NODE_H })),
    edges: g.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  });
  // Keep the flow where it was on the canvas: anchor at the old top-left.
  const before = boundsOf(laid);
  const pos = new Map((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  const ox = before?.x ?? 0;
  const oy = before?.y ?? 0;
  let nodes: FlowNode[] = g.nodes.map((n) => {
    const p = pos.get(n.id);
    return p ? { ...n, position: { x: Math.round(p.x + ox), y: Math.round(p.y + oy) } } : n;
  });
  // Refit group frames around their members.
  nodes = nodes.map((n) => {
    if (n.kind !== 'group') return n;
    const members = nodes.filter((m) => m.parent === n.id);
    const b = boundsOf(members);
    if (!b) return n;
    return { ...n, position: { x: b.x - 36, y: b.y - 56 }, size: { w: b.w + 72, h: b.h + 92 } };
  });
  return { ...g, nodes };
}
