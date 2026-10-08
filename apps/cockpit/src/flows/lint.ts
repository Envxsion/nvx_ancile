/**
 * ------------------------------------------------------------------
 *  Title    |  Local flow checks
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The checks the canvas can make by itself, instantly,
 *           |  as you draw: no message in or no answer out, nodes
 *           |  nothing reaches, routes that go nowhere, loops without
 *           |  a loop node, models that are not ready, payloads that
 *           |  cannot fit. Core's /flows/validate adds what only Core
 *           |  knows (prices, GPU nodes, stats); its answer replaces
 *           |  this one whenever it arrives.
 * ------------------------------------------------------------------
 */

import type { FlowGraph, FlowIssue } from '@nvx/contracts';
import { reachable } from './graph';
import { KINDS, modelOf, outputPorts } from './kinds';
import type { FlowModel } from './models';
import type { ValidateFlowResponse } from './types';

export function localLint(g: FlowGraph, models: Map<string, FlowModel>): ValidateFlowResponse {
  const issues: FlowIssue[] = [];
  const run = g.nodes.filter((n) => !KINDS[n.kind].furniture);
  const inputs = run.filter((n) => n.kind === 'input');
  const outputs = run.filter((n) => n.kind === 'output');
  if (inputs.length === 0)
    issues.push({
      level: 'error',
      code: 'flow.no_input',
      message: 'There is no “Message in” node, so nothing can start.',
    });
  if (inputs.length > 1)
    issues.push({
      level: 'error',
      code: 'flow.many_inputs',
      message: 'There is more than one “Message in” node; keep one.',
    });
  if (outputs.length === 0)
    issues.push({
      level: 'error',
      code: 'flow.no_output',
      message: 'There is no “Answer” node, so nothing reaches you.',
    });

  const seen = reachable(g);
  for (const n of run) {
    if (n.kind !== 'input' && !seen.has(n.id))
      issues.push({
        level: 'warning',
        code: 'flow.unreachable',
        message: `${n.label || n.id} is never reached from your message.`,
        node_id: n.id,
      });
    const ports = outputPorts(n);
    if (KINDS[n.kind].outputs === 'routes')
      for (const p of ports) {
        if (n.kind === 'manager' && p === 'answer') continue;
        if (!g.edges.some((e) => e.from === n.id && (e.label ?? '') === p))
          issues.push({
            level: 'warning',
            code: 'flow.route_unused',
            message: `${n.label || n.id}: the “${p}” route goes nowhere.`,
            node_id: n.id,
          });
      }
    if (KINDS[n.kind].outputs !== 'none' && !g.edges.some((e) => e.from === n.id) && n.kind !== 'output')
      issues.push({
        level: 'warning',
        code: 'flow.dead_end',
        message: `${n.label || n.id} leads nowhere; connect it onwards.`,
        node_id: n.id,
      });
    const m = modelOf(n);
    if (m) {
      const info = models.get(m);
      if (models.size && !info)
        issues.push({
          level: 'error',
          code: 'flow.model_unknown',
          message: `${n.label || n.id} uses ${m}, which is not in your models.`,
          node_id: n.id,
        });
      else if (info?.status === 'needs_key')
        issues.push({
          level: 'error',
          code: 'flow.model_unready',
          message: `${info.name} needs an API key (Settings → Models).`,
          node_id: n.id,
        });
      else if (info?.status === 'disabled')
        issues.push({
          level: 'error',
          code: 'flow.model_unready',
          message: `${info.name} is switched off.`,
          node_id: n.id,
        });
      else if (info?.awake === false)
        issues.push({
          level: 'warning',
          code: 'flow.node_asleep',
          message: `${info.name} is on a sleeping GPU node; the first answer waits for it to wake.`,
          node_id: n.id,
        });
    }
    if (n.kind === 'tool' && !n.params.tool)
      issues.push({
        level: 'error',
        code: 'flow.tool_missing',
        message: `${n.label || n.id} has no tool chosen.`,
        node_id: n.id,
      });
    if (n.kind === 'subflow' && !n.params.flow_id)
      issues.push({
        level: 'error',
        code: 'flow.subflow_missing',
        message: `${n.label || n.id} has no flow chosen.`,
        node_id: n.id,
      });
    if (n.kind === 'model' && n.params.pinned_output)
      issues.push({
        level: 'warning',
        code: 'flow.pinned',
        message: `${n.label || n.id} is pinned: live answers will use its fixed output.`,
        node_id: n.id,
      });
  }

  // Cycles are only allowed through a loop or manager (they bound them).
  const bounded = new Set(run.filter((n) => n.kind === 'loop' || n.kind === 'manager').map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of g.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const nx of adj.get(id) ?? []) {
      if (state.get(nx) === 1) return stack.slice(stack.indexOf(nx));
      if (!state.has(nx)) {
        const c = visit(nx);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const n of run) {
    if (state.has(n.id)) continue;
    const cycle = visit(n.id);
    if (cycle && !cycle.some((id) => bounded.has(id))) {
      issues.push({
        level: 'error',
        code: 'flow.cycle',
        message: `These nodes loop forever: ${cycle.join(' → ')}. Put a Loop node in the circle to cap it.`,
        node_id: cycle[0],
      });
      break;
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues, estimate: { paths: [] } };
}
