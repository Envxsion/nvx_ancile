/**
 * A flow in miniature: nodes as tinted pills, edges as curves. Used in the
 * template gallery and the flows list so a shape is recognisable at a glance.
 */
import type { FlowGraph } from '@nvx/contracts';
import { type CSSProperties, memo } from 'react';
import { hueVar } from '../lib/format';
import { boundsOf, sizeOf } from './graph';
import { KINDS } from './kinds';

export const FlowPreview = memo(function FlowPreview({
  graph,
  height = 110,
}: {
  graph: FlowGraph;
  height?: number;
}) {
  const nodes = graph.nodes.filter((n) => n.kind !== 'note' && n.kind !== 'group');
  const b = boundsOf(nodes);
  if (!b) return <div className="fpreview fpreview--empty" style={{ height }} />;
  const pad = 30;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="fpreview"
      viewBox={`${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ height }}
      aria-hidden="true"
    >
      {graph.edges.map((e) => {
        const a = byId.get(e.from);
        const c = byId.get(e.to);
        if (!a || !c) return null;
        const sa = sizeOf(a);
        const sc = sizeOf(c);
        const x1 = a.position.x + sa.w;
        const y1 = a.position.y + sa.h / 2;
        const x2 = c.position.x;
        const y2 = c.position.y + sc.h / 2;
        const dx = Math.max(40, (x2 - x1) / 2);
        return (
          <path
            key={e.id}
            className="fpreview__edge"
            d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
          />
        );
      })}
      {nodes.map((n) => {
        const s = sizeOf(n);
        return (
          <rect
            key={n.id}
            className="fpreview__node"
            x={n.position.x}
            y={n.position.y + s.h * 0.15}
            width={s.w}
            height={s.h * 0.7}
            rx={18}
            style={{ '--hue': hueVar(KINDS[n.kind].hue) } as CSSProperties}
          />
        );
      })}
    </svg>
  );
});
