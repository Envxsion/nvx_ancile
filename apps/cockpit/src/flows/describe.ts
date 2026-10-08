/**
 * Plain-words summaries of node settings and context policies, shared by
 * the canvas cards, the edge lens and the Teamwork-style live overlay.
 */
import type { ContextPolicy, FlowNode } from '@nvx/contracts';

export function contextSummary(p: Partial<ContextPolicy> | undefined): string {
  if (!p) return 'Default context';
  const parts: string[] = [];
  const c = p.conversation;
  if (c)
    parts.push(
      c.mode === 'none'
        ? 'No conversation'
        : c.mode === 'last_n'
          ? `Last ${c.n} turns`
          : c.mode === 'branch'
            ? 'This branch'
            : c.mode === 'tldr'
              ? 'Summary only'
              : c.mode === 'siblings'
                ? 'Branch and siblings'
                : 'Whole tree, summarised',
    );
  const s = p.sources;
  if (s)
    parts.push(
      s.mode === 'none'
        ? 'no sources'
        : s.mode === 'retrieved'
          ? `${s.k} passages`
          : `${s.source_ids.length} named sources`,
    );
  if (p.memory)
    parts.push(p.memory === 'none' ? 'no memory' : p.memory === 'pack' ? 'memory' : 'project memory');
  if (p.upstream)
    parts.push(
      p.upstream === 'none'
        ? 'no earlier work'
        : p.upstream === 'plan'
          ? 'the plan'
          : p.upstream === 'previous'
            ? 'previous output'
            : 'all earlier work',
    );
  if (p.budget_tokens) parts.push(`≤ ${Math.round(p.budget_tokens / 1000)}k tokens`);
  return parts.join(' · ') || 'Default context';
}

const firstLine = (s: string, max = 72) => {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One line under a node's title that says what it is set to do. */
export function nodeSummary(n: FlowNode): string {
  switch (n.kind) {
    case 'input':
      return 'Your message, with its branch and notebook';
    case 'output':
      return n.params.template ? firstLine(n.params.template) : 'Passes the answer through';
    case 'model':
      return n.params.pinned_output
        ? 'Pinned: uses a fixed output'
        : n.params.role
          ? firstLine(n.params.role)
          : 'No role prompt';
    case 'router':
      return `${n.params.routes.length} ${n.params.routes.length === 1 ? 'route' : 'routes'} · unsure below ${Math.round(n.params.min_confidence * 100)}%${n.params.multi ? ' · may pick several' : ''}`;
    case 'rule':
      return `${n.params.rules.length} ${n.params.rules.length === 1 ? 'rule' : 'rules'}, first match wins`;
    case 'manager':
      return `Plans and delegates · up to ${n.params.max_rounds} rounds`;
    case 'parallel':
      return 'Sends the work to every connection at once';
    case 'join':
      return n.params.mode === 'all'
        ? 'Keeps every answer'
        : n.params.mode === 'first'
          ? 'Keeps the first to finish'
          : n.params.mode === 'vote'
            ? 'Keeps what most agree on'
            : 'A judge picks the best';
    case 'loop':
      return `Until done, at most ${n.params.max_iterations} times`;
    case 'context':
      return contextSummary(n.params);
    case 'retrieve':
      return `Top ${n.params.k} passages${n.params.rerank ? ', reranked' : ''}`;
    case 'factcheck':
      return `Unsure below ${Math.round(n.params.min_confidence * 100)}%${n.params.caveat ? ', with a caveat' : ''}`;
    case 'tool':
      return n.params.tool ? n.params.tool : 'Choose a tool';
    case 'template':
      return firstLine(n.params.template) || 'Empty template';
    case 'human':
      return firstLine(n.params.question);
    case 'subflow':
      return n.params.flow_id ? 'Runs a saved flow' : 'Choose a flow';
    case 'note':
      return firstLine(n.params.text);
    case 'group':
      return '';
  }
}

export function usd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export function msText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
