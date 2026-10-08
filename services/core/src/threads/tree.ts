/**
 * ------------------------------------------------------------------
 *  Title    |  The branch tree view
 *  Ref      |  DESIGN.md §8.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The whole thread as the tree panel draws it: linear runs
 *           |  folded into one node with a count, so a 400-message
 *           |  thread with six forks is about a dozen nodes.
 *  How      |  Pure. A node starts at a root or at the first message
 *           |  after a fork, and folds in everything below it while
 *           |  there is exactly one child: one node per stretch between
 *           |  forks (root + 2 per fork). Each node knows where its run
 *           |  ends (where "jump here" lands) and how many children
 *           |  that end has.
 * ------------------------------------------------------------------
 */

import type { Branch, BranchTree, BranchTreeNode, Part } from '@nvx/contracts';
import { childrenIndex } from './path';
import { asTree, type MessageRecord, type TreeRecord } from './repo';

/** First meaningful line of a message, for a node label. */
/** Flows (Phase 5b): the flow that answered a message, from its provenance. */
function flowOf(m: { provenance?: unknown }): { id: string; name: string; version: number } | null {
  const f = (m.provenance as { flow?: { flow_id?: unknown; name?: unknown; version?: unknown } } | null)
    ?.flow;
  if (!f || typeof f.flow_id !== 'string') return null;
  return { id: f.flow_id, name: String(f.name ?? ''), version: Number(f.version ?? 0) };
}

export function previewOf(parts: Part[], max = 96): string {
  const text = parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('')
    .split('\n')
    .map((l) => l.replace(/^#+\s*|^>\s*|[*_`]/g, '').trim())
    .find(Boolean);
  if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const call = parts.find((p) => p.type === 'tool_call');
  if (call?.type === 'tool_call') return `Used ${call.tool}`;
  if (parts.some((p) => p.type === 'image')) return 'Image';
  if (parts.some((p) => p.type === 'file')) return 'File';
  return '';
}

/** Root → leaf: follow the newest child from `id`, as the path route does. */
export function deepestFrom(kids: Map<string | null, TreeRecord[]>, id: string): string {
  let cur = id;
  for (;;) {
    const next = kids.get(cur)?.at(-1);
    if (!next) return cur;
    cur = next.id;
  }
}

export function buildTree(
  threadId: string,
  msgs: MessageRecord[],
  branches: Branch[],
  activeHead: string | null,
): BranchTree {
  const all = asTree(msgs);
  const kids = childrenIndex(all);
  const byId = new Map(all.map((m) => [m.id, m] as const));
  const nKids = (id: string) => kids.get(id)?.length ?? 0;
  // A node starts at a root or right after a fork, and runs down while there is exactly one child.
  const shown = (m: TreeRecord) => m.parentId === null || (kids.get(m.parentId)?.length ?? 0) > 1;

  // The active path, extended to its leaf.
  const headStart = activeHead && byId.has(activeHead) ? activeHead : (kids.get(null)?.at(-1)?.id ?? null);
  const head = headStart ? deepestFrom(kids, headStart) : null;
  const activePath: string[] = [];
  for (let cur = head; cur; cur = byId.get(cur)?.parentId ?? null) activePath.push(cur);
  activePath.reverse();
  const onPath = new Set(activePath);

  const owner = new Map<string, string>();
  const nodes: BranchTreeNode[] = [];
  for (const m of all) {
    if (!shown(m)) continue;
    // Walk down the run this node owns.
    let end = m;
    let folded = 0;
    owner.set(m.id, m.id);
    for (;;) {
      const only = nKids(end.id) === 1 ? kids.get(end.id)?.[0] : undefined;
      if (!only || shown(only)) break;
      end = only;
      folded++;
      owner.set(end.id, m.id);
    }
    // Nearest shown ancestor.
    let parent: string | null = m.parentId;
    while (parent !== null) {
      const p = byId.get(parent);
      if (!p || shown(p)) break;
      parent = p.parentId;
    }
    nodes.push({
      id: m.id,
      parent_id: parent,
      role: m.role,
      preview: previewOf(m.parts),
      model_id: m.model_id,
      status: m.status,
      collapsed: folded,
      end_id: end.id,
      children: nKids(end.id),
      branch_ids: [],
      active: onPath.has(m.id),
      created_at: m.created_at,
      // Flows (Phase 5b): which flow answered this stretch, if one did.
      flow: flowOf(end) ?? flowOf(m),
    });
  }
  const byNode = new Map(nodes.map((n) => [n.id, n] as const));
  for (const b of branches) {
    const n = byNode.get(owner.get(b.head_message_id) ?? '');
    if (n) n.branch_ids.push(b.id);
  }
  return {
    thread_id: threadId,
    active_head_id: head,
    active_path: activePath,
    nodes,
    branches,
    total: all.length,
  };
}
