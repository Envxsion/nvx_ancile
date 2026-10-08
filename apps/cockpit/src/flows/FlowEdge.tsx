/**
 * ------------------------------------------------------------------
 *  Title    |  Flow edges and the context lens
 *  Ref      |  DESIGN.md §16.2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  An edge says what crosses it. Hover one and a lens
 *           |  shows exactly that: how many turns, passages, memories
 *           |  and how much earlier work, with tokens and a cost; click
 *           |  it to see the literal payload. A router's edges are
 *           |  drawn by how often and how surely they are chosen.
 *  How      |  Estimates come from Core (/flows/estimate-context) once
 *           |  per edge and policy, cached for the session. Without
 *           |  that route the lens still shows the policy in words.
 * ------------------------------------------------------------------
 */

import type { FlowEdge as FlowEdgeT } from '@nvx/contracts';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import { type CSSProperties, memo, useState } from 'react';
import { contextSummary } from './describe';
import { useEditor } from './store';

export interface EdgeData extends Record<string, unknown> {
  edge: FlowEdgeT;
  /** Share of recent decisions that took this route (0..1), and their mean confidence. */
  heat?: { share: number; confidence: number | null; n: number } | null;
  travelled?: boolean;
  diff?: 'added' | null;
  dimmed?: boolean;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n)));

export const FlowEdge = memo(function FlowEdge(p: EdgeProps & { data: EdgeData }) {
  const { edge, heat, travelled, diff, dimmed } = p.data;
  const [path, lx, ly] = getBezierPath({
    sourceX: p.sourceX,
    sourceY: p.sourceY,
    targetX: p.targetX,
    targetY: p.targetY,
    sourcePosition: p.sourcePosition,
    targetPosition: p.targetPosition,
    curvature: 0.32,
  });
  const [hover, setHover] = useState(false);
  const select = useEditor((s) => s.select);
  // The whole graph is estimated at once (FlowEditor); this edge reads its row.
  const estimates = useEditor((s) => s.estimates);
  const est = Array.isArray(estimates) ? estimates.find((x) => x.edge_id === edge.id) : undefined;
  const lens = () => setHover(true);

  const width = heat ? 1.5 + heat.share * 4 : undefined;
  const unsure = heat && heat.confidence != null && heat.confidence < 0.6;

  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        className="fedge"
        style={
          {
            ...(width && { strokeWidth: width }),
          } as CSSProperties
        }
        interactionWidth={22}
      />
      <path
        d={path}
        className="fedge__flow"
        data-travelled={travelled || undefined}
        data-selected={p.selected || undefined}
        data-diff={diff ?? undefined}
        data-dimmed={dimmed || undefined}
        data-unsure={unsure || undefined}
        fill="none"
      />
      <EdgeLabelRenderer>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover reveals the lens; the button inside is the control */}
        <div
          className="fedge__label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          onMouseEnter={lens}
          onMouseLeave={() => setHover(false)}
          data-open={hover || p.selected || undefined}
        >
          {edge.label ? (
            <span className="fedge__route" data-unsure={unsure || undefined}>
              {edge.label}
              {heat ? (
                <span
                  className="fedge__heat"
                  title={`${heat.n} recent messages; mean confidence ${heat.confidence != null ? Math.round(heat.confidence * 100) : '?'}%`}
                >
                  {Math.round(heat.share * 100)}%
                </span>
              ) : null}
            </span>
          ) : null}
          <button
            type="button"
            className="fedge__lens"
            data-custom={edge.context ? true : undefined}
            aria-label="What crosses this connection"
            onClick={(e) => {
              e.stopPropagation();
              select([], edge.id);
            }}
          >
            <span className="fedge__lens-dot" aria-hidden="true" />
            {hover || p.selected ? (
              <span className="fedge__lens-body">
                <span>{contextSummary(edge.context)}</span>
                {est ? (
                  <span className="fedge__lens-num" data-over={est.over || undefined}>
                    {k(est.tokens.conversation)} conversation · {k(est.tokens.sources)} sources ·{' '}
                    {k(est.tokens.memory)} memory · {k(est.tokens.upstream)} earlier · {k(est.total)}
                    {est.context_window ? ` of ${k(est.context_window)}` : ''} tokens
                    {est.over ? ', over the window' : ''}
                  </span>
                ) : estimates === 'needs-core' ? (
                  <span className="fedge__lens-num mute">Token estimate needs a newer Core</span>
                ) : null}
              </span>
            ) : null}
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

export const EDGE_TYPES = { flow: FlowEdge };
