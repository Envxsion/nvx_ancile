/**
 * ------------------------------------------------------------------
 *  Title    |  Flow validation and estimates
 *  Ref      |  DESIGN.md §16.4, §16.6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say what is wrong with a flow while it is being drawn,
 *           |  in words, pointing at the node or edge, and what each
 *           |  route through it is likely to cost and take.
 *  How      |  Errors stop a flow from being activated or run; warnings
 *           |  never do. Estimates assume about 2,000 tokens in and 600
 *           |  out per model call (a manager counts two rounds), priced
 *           |  from the registry, at roughly 60 tokens a second.
 * ------------------------------------------------------------------
 */

import type { FlowGraph, FlowIssue, FlowNode, ModelConfig } from '@nvx/contracts';
import { buildGraph, canReach, findCycle, flowEdges, modelsOf, paths, reachable } from './graph';

export interface ValidateDeps {
  model(id: string): ModelConfig | undefined;
  status(m: ModelConfig): 'ready' | 'needs_key' | 'disabled';
  tool(name: string): boolean;
  flowExists(id: string): boolean;
  /** The flow being validated (a subflow may not call itself). */
  selfId?: string | null;
  /** The version being checked is (or would be) the published one. */
  published?: boolean;
  /** Route labels a router/rule chose in the last 30 days, by node (absent: no history yet). */
  routeUsage?: Map<string, Set<string>>;
}

/** Strings that look like credentials: API keys, tokens. */
const SECRET =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|rpa_[A-Za-z0-9]{20,})\b/;

function promptsOf(n: FlowNode): string[] {
  switch (n.kind) {
    case 'model':
      return [n.params.role];
    case 'manager':
      return [n.params.role, n.params.instructions];
    case 'router':
      return [n.params.instructions, ...n.params.routes.map((r) => r.when)];
    case 'template':
      return [n.params.template];
    case 'join':
      return [n.params.judge_instructions];
    case 'loop':
      return [n.params.until];
    case 'tool':
      return [n.params.args];
    case 'output':
      return [n.params.template];
    default:
      return [];
  }
}

const IN_TOKENS = 2_000;
const OUT_TOKENS = 600;
const TOKENS_PER_S = 60;

function callCost(m: ModelConfig | undefined): { cost: number; ms: number } {
  if (!m) return { cost: 0, ms: 0 };
  const cost = (IN_TOKENS * m.price.input_per_mtok + OUT_TOKENS * m.price.output_per_mtok) / 1_000_000;
  return { cost, ms: 700 + (OUT_TOKENS / TOKENS_PER_S) * 1000 };
}

export function validateFlow(
  graph: Pick<FlowGraph, 'nodes' | 'edges'>,
  deps: ValidateDeps,
): {
  ok: boolean;
  issues: FlowIssue[];
  estimate: { paths: { nodes: string[]; models: string[]; cost_usd: number; latency_ms: number }[] };
} {
  const issues: FlowIssue[] = [];
  const err = (code: string, message: string, at: { node_id?: string; edge_id?: string } = {}) =>
    issues.push({ level: 'error', code, message, ...at });
  const warn = (code: string, message: string, at: { node_id?: string; edge_id?: string } = {}) =>
    issues.push({ level: 'warning', code, message, ...at });

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) err('flow.duplicate_id', `Two nodes share the id "${n.id}".`, { node_id: n.id });
    ids.add(n.id);
  }
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id))
      err('flow.duplicate_id', `Two connections share the id "${e.id}".`, { edge_id: e.id });
    edgeIds.add(e.id);
    if (!ids.has(e.from) || !ids.has(e.to))
      err('flow.edge_dangling', 'A connection points at a node that is not there.', { edge_id: e.id });
    if (e.from === e.to) err('flow.cycle', 'A node is connected to itself.', { edge_id: e.id });
  }

  const g = buildGraph(graph);
  const inputs = graph.nodes.filter((n) => n.kind === 'input');
  const outputs = graph.nodes.filter((n) => n.kind === 'output');
  if (inputs.length === 0) err('flow.no_input', 'Add an Input node: it is where your message enters.');
  if (inputs.length > 1) err('flow.many_inputs', 'A flow has one Input node.', { node_id: inputs[1]?.id });
  if (outputs.length === 0) err('flow.no_output', 'Add an Output node: it is what you see as the answer.');
  if (outputs.length > 1)
    err('flow.many_outputs', 'A flow has one Output node.', { node_id: outputs[1]?.id });

  const cycle = findCycle(g);
  if (cycle)
    err(
      'flow.cycle',
      `These nodes go round in a loop: ${cycle.join(' → ')}. Use a Manager to ask a node again instead.`,
      { node_id: cycle[0] as string },
    );

  if (g.input) {
    const from = reachable(g, g.input.id);
    for (const n of g.nodes.values())
      if (!from.has(n.id) && !n.disabled)
        warn('flow.unreachable', `Nothing leads to ${n.label ?? n.id}, so it never runs.`, { node_id: n.id });
  }
  if (g.output) {
    const to = canReach(g, g.output.id);
    for (const n of g.nodes.values())
      if (!to.has(n.id) && n.kind !== 'output' && !n.disabled)
        warn('flow.dead_end', `${n.label ?? n.id} leads nowhere: its work never reaches the answer.`, {
          node_id: n.id,
        });
  }

  let modelRefs = 0;
  let readyRefs = 0;
  for (const n of graph.nodes) {
    for (const id of modelsOf(n)) {
      const m = deps.model(id);
      if (!m) {
        err('flow.model_unknown', `There is no model called ${id}.`, { node_id: n.id });
        continue;
      }
      const s = deps.status(m);
      if (!n.disabled) {
        modelRefs++;
        if (s === 'ready') readyRefs++;
      }
      if (s === 'needs_key')
        warn('flow.model_unready', `${m.display_name} needs its key. Add it in Settings → Models.`, {
          node_id: n.id,
        });
      else if (s === 'disabled')
        warn('flow.model_unready', `${m.display_name} is switched off in Settings → Models.`, {
          node_id: n.id,
        });
      if (m.via === 'controller')
        warn(
          'flow.gpu_node',
          `${m.display_name} runs on a GPU node; if it is asleep, the first answer waits while it wakes.`,
          {
            node_id: n.id,
          },
        );
    }
    // "Use a cloud model instead" falls through to the next model in a step's
    // chain; with only GPU models there is nothing to fall to, so the button
    // is not offered and a sleeping node can only be waited for.
    {
      const chain = modelsOf(n).map((id) => deps.model(id));
      if (
        !n.disabled &&
        chain[0]?.via === 'controller' &&
        !chain.slice(1).some((m) => m && m.via !== 'controller')
      )
        warn(
          'flow.gpu_no_fallback',
          `${n.label ?? n.id} has no cloud model to fall back to, so while its GPU node wakes you cannot switch to the cloud. Add a fallback model.`,
          { node_id: n.id },
        );
    }
    if (n.kind === 'router' || n.kind === 'rule') {
      const labels =
        n.kind === 'router' ? n.params.routes.map((r) => r.label) : n.params.rules.map((r) => r.label);
      const outs = (g.out.get(n.id) ?? []).map((e) => e.label).filter((l): l is string => !!l);
      for (const l of labels)
        if (!outs.includes(l))
          warn('flow.route_unconnected', `The route "${l}" has no connection, so choosing it ends nowhere.`, {
            node_id: n.id,
          });
      for (const e of g.out.get(n.id) ?? [])
        if (e.label && !labels.includes(e.label))
          err(
            'flow.route_mismatch',
            `This connection is labelled "${e.label}", which is not one of the routes.`,
            {
              edge_id: e.id,
            },
          );
      const def = n.params.default_route;
      if (def && !labels.includes(def))
        err('flow.route_mismatch', `The default route "${def}" is not one of the routes.`, { node_id: n.id });
    }
    if (n.kind === 'manager' && ![...(g.out.get(n.id) ?? [])].some((e) => g.workerEdges.has(e.id)))
      warn(
        'flow.manager_alone',
        'This Manager has no workers. Connect it to the models it should hand work to.',
        {
          node_id: n.id,
        },
      );
    if (n.kind === 'join' && n.params.mode === 'judge' && !n.params.judge_model)
      err('flow.judge_missing', 'Pick the model that judges which answer is best.', { node_id: n.id });
    if (n.kind === 'tool' && !deps.tool(n.params.tool))
      err('flow.tool_unknown', `There is no tool called ${n.params.tool}.`, { node_id: n.id });
    if (n.kind === 'tool') {
      try {
        JSON.parse(n.params.args.replace(/\{\{\w+\}\}/g, '""'));
      } catch {
        err('flow.tool_args', 'The tool arguments are not valid JSON.', { node_id: n.id });
      }
    }
    if (promptsOf(n).some((t) => SECRET.test(t)))
      err(
        'flow.secret_in_prompt',
        'This node has something that looks like a key in its text. Keys belong in Settings → Models, never in a prompt.',
        {
          node_id: n.id,
        },
      );
    if (
      (n.kind === 'model' || n.kind === 'manager') &&
      n.params.pinned_output !== undefined &&
      deps.published
    )
      warn(
        'flow.pinned_published',
        'This node answers with a pinned output instead of calling its model. Unpin it before relying on this flow.',
        {
          node_id: n.id,
        },
      );
    if (n.kind === 'model' || n.kind === 'manager') {
      const m = deps.model(n.params.model);
      const budget = (g.in.get(n.id) ?? []).map((e) => e.context?.budget_tokens).find((b) => b !== undefined);
      if (m && budget && budget > m.context_window)
        warn(
          'flow.context_too_big',
          `Up to ${budget.toLocaleString('en-GB')} tokens can reach ${m.display_name}, more than its ${m.context_window.toLocaleString('en-GB')}-token window. Lower the budget on its connection.`,
          {
            node_id: n.id,
          },
        );
    }
    if (n.kind === 'loop') {
      if (!(g.out.get(n.id) ?? []).some((e) => e.label === 'body'))
        err('flow.loop_body', "Connect what this Loop repeats with a connection labelled 'body'.", {
          node_id: n.id,
        });
      if (!n.params.until_model)
        warn(
          'flow.loop_uncapped',
          `No model judges when this Loop is done, so it always runs all ${n.params.max_iterations} times.`,
          {
            node_id: n.id,
          },
        );
    }
    if ((n.kind === 'router' || n.kind === 'rule') && deps.routeUsage?.has(n.id)) {
      const used = deps.routeUsage.get(n.id) as Set<string>;
      const labels =
        n.kind === 'router' ? n.params.routes.map((r) => r.label) : n.params.rules.map((r) => r.label);
      for (const l of labels)
        if (!used.has(l))
          warn('flow.route_unused', `The route "${l}" has not been chosen in 30 days.`, { node_id: n.id });
    }
    if (n.kind === 'factcheck' && !(g.out.get(n.id) ?? []).some((e) => e.label === 'unsure'))
      warn(
        'flow.factcheck_unsure',
        "Nothing is connected to 'unsure': an answer below the threshold goes the same way as one above it.",
        {
          node_id: n.id,
        },
      );
    if (n.kind === 'subflow') {
      if (deps.selfId && n.params.flow_id === deps.selfId)
        err('flow.subflow_self', 'A flow cannot run itself as a subflow.', { node_id: n.id });
      else if (!deps.flowExists(n.params.flow_id))
        err('flow.subflow_missing', 'The flow this node runs no longer exists.', { node_id: n.id });
    }
  }
  // Every answer would fail: the activate route refuses a flow like this.
  if (modelRefs > 0 && readyRefs === 0)
    warn(
      'flow.no_model_ready',
      'None of the models in this flow can answer yet. Add a key in Settings → Models, or choose models you have set up.',
    );

  // Estimates per path.
  const estimate = paths(g).map((p) => {
    let cost = 0;
    let ms = 0;
    const models: string[] = [];
    for (const id of p) {
      const n = g.nodes.get(id);
      if (!n || n.disabled) continue;
      const own = modelsOf(n)[0];
      const rounds = n.kind === 'manager' ? 2 : 1;
      if (own) {
        const c = callCost(deps.model(own));
        cost += c.cost * rounds;
        ms += c.ms * rounds;
        models.push(own);
      }
      if (n.kind === 'manager')
        for (const e of g.out.get(id) ?? []) {
          if (!g.workerEdges.has(e.id)) continue;
          const w = g.nodes.get(e.to);
          const wm = w ? modelsOf(w)[0] : undefined;
          if (!wm) continue;
          const c = callCost(deps.model(wm));
          cost += c.cost;
          ms += c.ms;
          models.push(wm);
        }
    }
    return {
      nodes: p,
      models: [...new Set(models)],
      cost_usd: Math.round(cost * 1e6) / 1e6,
      latency_ms: Math.round(ms),
    };
  });
  if (g.input && g.output && estimate.length === 0 && !cycle)
    err('flow.no_path', 'There is no route from Input to Output.');

  // An edge the scheduler follows from a node with nothing after it except a worker call is fine; the
  // flow is ok when it has no errors.
  void flowEdges;
  return { ok: !issues.some((i) => i.level === 'error'), issues, estimate: { paths: estimate } };
}
