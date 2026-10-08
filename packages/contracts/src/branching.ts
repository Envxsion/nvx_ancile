/**
 * ------------------------------------------------------------------
 *  Title    |  Branching contracts
 *  Ref      |  DESIGN.md §8, §4.1 (Threads, Branches)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes for the conversation as a tree: the tree
 *           |  view, named branches, the context budget of a path,
 *           |  compaction, compare, merge and subtree delete.
 *  How      |  A branch is any root-to-leaf path; the rows here only
 *           |  *name* heads. Everything else is computed from the
 *           |  message tree on read.
 * ------------------------------------------------------------------
 */
import { z } from 'zod';

/** Colours a branch can take: the identity ramp, never signal. */
export const BranchColor = z.enum(['azure', 'jade', 'amber', 'coral', 'magenta', 'cyan', 'chalk']);
export type BranchColor = z.infer<typeof BranchColor>;

export const Branch = z.object({
  id: z.string(),
  thread_id: z.string(),
  name: z.string(),
  color: BranchColor,
  head_message_id: z.string(),
  fork_message_id: z.string(),
  created_by: z.enum(['user', 'suggestion']),
  archived_at: z.string().nullable(),
  created_at: z.string(),
});
export type Branch = z.infer<typeof Branch>;

export const CreateBranchRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    color: BranchColor.optional(),
    created_by: z.enum(['user', 'suggestion']).optional(),
  })
  .strict();

export const PatchBranchRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    color: BranchColor.optional(),
    archived: z.boolean().optional(),
  })
  .strict();

/** One node of the collapsed tree (DESIGN.md §8.2). */
export const BranchTreeNode = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  /** First line of the message, trimmed. */
  preview: z.string(),
  model_id: z.string().nullable(),
  status: z.enum(['pending', 'streaming', 'complete', 'stopped', 'error']),
  /** Linear messages folded into this node, not counting itself. */
  collapsed: z.number().int(),
  /** The last message of the folded run: where Enter lands. */
  end_id: z.string(),
  /** Children in the full tree (a fork when more than one). */
  children: z.number().int(),
  /** Named branches whose head is inside this node's run. */
  branch_ids: z.array(z.string()),
  /** This node's run is on the active path. */
  active: z.boolean(),
  created_at: z.string(),
  /** Flows: the flow that answered this node, if any. */
  flow: z.object({ id: z.string(), name: z.string(), version: z.number().int() }).nullable().optional(),
});
export type BranchTreeNode = z.infer<typeof BranchTreeNode>;

export const BranchTree = z.object({
  thread_id: z.string(),
  active_head_id: z.string().nullable(),
  /** Every message on the active path, root first. */
  active_path: z.array(z.string()),
  nodes: z.array(BranchTreeNode),
  branches: z.array(Branch),
  /** Messages in the thread, before folding. */
  total: z.number().int(),
});
export type BranchTree = z.infer<typeof BranchTree>;

/** GET /threads/:id/context-budget (DESIGN.md §8.4). */
export const PathBudget = z.object({
  head_id: z.string().nullable(),
  model_id: z.string().nullable(),
  window: z.number().int(),
  used: z.object({
    system: z.number().int(),
    memory: z.number().int(),
    retrieval: z.number().int(),
    history: z.number().int(),
    reserve_output: z.number().int(),
  }),
  total: z.number().int(),
  ratio: z.number(),
  level: z.enum(['ok', 'warn', 'critical']),
  /** The compaction this path would use, if one exists. */
  compaction: z
    .object({
      summary_id: z.string(),
      upto_message_id: z.string(),
      replaced_messages: z.number().int(),
      tokens: z.number().int(),
    })
    .nullable(),
  /** Messages a compaction now could replace (everything but the latest turns). */
  compactable: z.number().int(),
});
export type PathBudget = z.infer<typeof PathBudget>;

export const CompactRequest = z.object({ head: z.string().optional() }).strict();
export const CompactResult = z.object({
  summary_id: z.string(),
  upto_message_id: z.string(),
  replaced_messages: z.number().int(),
  tokens_before: z.number().int(),
  tokens_after: z.number().int(),
  model_id: z.string().nullable(),
  /** An existing summary already covered this prefix; nothing new was written. */
  reused: z.boolean(),
});
export type CompactResult = z.infer<typeof CompactResult>;

/** Recorded on an assistant message whose context used a compaction. */
export const CompactionProvenance = z.object({
  summary_id: z.string(),
  upto_message_id: z.string(),
  tokens_before: z.number().int(),
  tokens_after: z.number().int(),
  /** Compacted automatically at the critical line, rather than on request. */
  auto: z.boolean().optional(),
});
export type CompactionProvenance = z.infer<typeof CompactionProvenance>;

export const CompareBranchesRequest = z.object({ a: z.string(), b: z.string() }).strict();

export const BranchSideMetrics = z.object({
  messages: z.number().int(),
  models: z.array(z.string()),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number(),
  /** Mean fact-check confidence over the side's answers, when checked. */
  confidence: z.number().nullable(),
});

export const BranchComparison = z.object({
  summary: z.string(),
  differences: z.array(z.object({ aspect: z.string(), a: z.string(), b: z.string() })),
  better_for: z.object({ a: z.string(), b: z.string() }),
});
export type BranchComparison = z.infer<typeof BranchComparison>;

export const CompareResult = z.object({
  thread_id: z.string(),
  lca_id: z.string().nullable(),
  /** Messages both sides share, root to the fork. */
  shared: z.number().int(),
  a: z.object({ head_id: z.string(), message_ids: z.array(z.string()), metrics: BranchSideMetrics }),
  b: z.object({ head_id: z.string(), message_ids: z.array(z.string()), metrics: BranchSideMetrics }),
  /** Null when the sides are identical or no model could write it. */
  comparison: BranchComparison.nullable(),
  comparison_model: z.string().nullable(),
});
export type CompareResult = z.infer<typeof CompareResult>;

export const MergeThreadsRequest = z
  .object({
    thread_id: z.string(),
    a: z.string(),
    b: z.string(),
    strategy: z.enum(['manual', 'synthesize']),
    /** Manual: the messages to carry, in order, from either side after the fork. */
    picks: z.array(z.string()).max(400).default([]),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type MergeThreadsRequest = z.infer<typeof MergeThreadsRequest>;

export const MergeResult = z.object({
  thread_id: z.string(),
  head_id: z.string(),
  copied: z.number().int(),
  model_id: z.string().nullable(),
});
export type MergeResult = z.infer<typeof MergeResult>;

/** Where a merged message came from. */
export const MergedFrom = z.object({
  thread_id: z.string(),
  message_id: z.string(),
  side: z.enum(['shared', 'a', 'b']).optional(),
});

export const DeleteMessageResult = z.object({
  deleted: z.number().int(),
  /** Until when POST /messages/:id/restore brings it back. */
  undo_until: z.string(),
  head_id: z.string().nullable(),
});
export type DeleteMessageResult = z.infer<typeof DeleteMessageResult>;
