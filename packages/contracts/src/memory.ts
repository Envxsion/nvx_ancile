/**
 * ------------------------------------------------------------------
 *  Title    |  Memory API
 *  Ref      |  DESIGN.md §6, §4.1 (Memory routes)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes the Cockpit and Core agree on for memory:
 *           |  files and their entries, history and diffs, the inbox
 *           |  of proposals, and the pack injected into a model call.
 *  Note     |  `MemoryProvenance` is what an assistant message carries
 *           |  in provenance.memory; /explain and the "why" panel read
 *           |  exactly this shape.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const MemoryKind = z.enum(['agents', 'user', 'projects', 'failures', 'models', 'other']);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemoryEntryView = z.object({
  key: z.string(),
  text: z.string(),
  section: z.string().nullable(),
  superseded: z.boolean(),
  confidence: z.number().nullable(),
  /** Message or run the entry came from, when it was learned. */
  src: z.string().nullable(),
  at: z.string().nullable(),
  superseded_by: z.string().nullable(),
});
export type MemoryEntryView = z.infer<typeof MemoryEntryView>;

export const MemoryFileSummary = z.object({
  path: z.string(),
  kind: MemoryKind,
  title: z.string(),
  /** The file's last commit. */
  version: z.string(),
  updated_at: z.string(),
  bytes: z.number().int(),
  entries: z.number().int(),
  /** False for files Ancile never writes on its own (AGENTS.md). */
  auto: z.boolean(),
});
export type MemoryFileSummary = z.infer<typeof MemoryFileSummary>;

export const MemoryFileList = z.object({
  items: z.array(MemoryFileSummary),
  /** HEAD of the memory repository. */
  head: z.string(),
});
export type MemoryFileList = z.infer<typeof MemoryFileList>;

export const MemoryFileContent = z.object({
  path: z.string(),
  content: z.string(),
  version: z.string(),
  entries: z.array(MemoryEntryView),
});
export type MemoryFileContent = z.infer<typeof MemoryFileContent>;

export const PutMemoryFileRequest = z
  .object({
    content: z.string().max(1_000_000),
    /** The version the edit started from; null for a new file. */
    base_sha: z.string().nullable(),
    message: z.string().max(200).optional(),
  })
  .strict();
export type PutMemoryFileRequest = z.infer<typeof PutMemoryFileRequest>;

export const PutMemoryFileResponse = z.object({
  version: z.string(),
  /** An automatic change landed meanwhile and was merged in cleanly. */
  merged: z.boolean(),
  changed: z.boolean(),
});
export type PutMemoryFileResponse = z.infer<typeof PutMemoryFileResponse>;

/** error.context of a 409 `memory.conflict`. */
export const MemoryConflictContext = z.object({
  path: z.string(),
  base: z.string().nullable(),
  current: z.string(),
  current_content: z.string(),
  /** Both sides with git conflict markers, ready to resolve by hand. */
  merged_with_markers: z.string(),
});
export type MemoryConflictContext = z.infer<typeof MemoryConflictContext>;

export const MemoryCommit = z.object({
  sha: z.string(),
  at: z.string(),
  author: z.string(),
  /** First line of the commit message. */
  summary: z.string(),
  body: z.string(),
  /** Written by Ancile on its own, or by a person in the editor. */
  automatic: z.boolean(),
  proposal_id: z.string().nullable(),
});
export type MemoryCommit = z.infer<typeof MemoryCommit>;

export const MemoryHistory = z.object({ path: z.string(), items: z.array(MemoryCommit) });
export type MemoryHistory = z.infer<typeof MemoryHistory>;

export const MemoryDiff = z.object({
  a: z.string(),
  b: z.string(),
  path: z.string().nullable(),
  /** Unified diff text. */
  patch: z.string(),
});
export type MemoryDiff = z.infer<typeof MemoryDiff>;

export const MemoryRevertRequest = z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }).strict();
export const MemoryRevertResponse = z.object({ version: z.string() });

export const ProposalKind = z.enum([
  'preference',
  'failure_lesson',
  'project_finding',
  'model_quirk',
  'manual',
]);
export const ProposalOp = z.enum(['add', 'update', 'supersede']);
export const ProposalStatus = z.enum(['proposed', 'applied', 'rejected', 'auto_applied', 'undone']);
export const ProposalProvenance = z.enum(['user_message', 'run_outcome', 'tool_output', 'source_content']);

export const MemoryProposal = z.object({
  id: z.string(),
  kind: ProposalKind,
  target_path: z.string(),
  op: ProposalOp,
  section: z.string(),
  text: z.string(),
  /** Entry being updated or superseded. */
  target_key: z.string().nullable(),
  /** Text of that entry when the proposal was made. */
  target_text: z.string().nullable(),
  rationale: z.string(),
  confidence: z.number(),
  provenance: ProposalProvenance,
  evidence: z.array(
    z.object({
      thread_id: z.string().optional(),
      message_id: z.string().optional(),
      run_id: z.string().optional(),
      quote: z.string().optional(),
    }),
  ),
  status: ProposalStatus,
  commit_sha: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

export const MemoryProposalList = z.object({ items: z.array(MemoryProposal), pending: z.number().int() });
export type MemoryProposalList = z.infer<typeof MemoryProposalList>;

export const ProposalDecisionRequest = z
  .object({
    /** undo reverts an applied or auto-applied proposal's commit. */
    decision: z.enum(['approve', 'reject', 'undo']),
    /** Approve with the text edited first. */
    text: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type ProposalDecisionRequest = z.infer<typeof ProposalDecisionRequest>;

/** One file's share of an injected pack. */
export const InjectedMemoryFile = z.object({
  path: z.string(),
  commit: z.string(),
  entries: z.array(z.string()),
  tokens: z.number().int(),
  dropped: z.number().int(),
});
export type InjectedMemoryFile = z.infer<typeof InjectedMemoryFile>;

/** provenance.memory on an assistant message. */
export const MemoryProvenance = z.object({
  files: z.array(InjectedMemoryFile),
  tokens: z.number().int(),
  truncated: z.number().int(),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;

export const MemoryPreview = MemoryProvenance.extend({
  text: z.string(),
  budget: z.number().int(),
  model_id: z.string().nullable(),
});
export type MemoryPreview = z.infer<typeof MemoryPreview>;

export const MemorySearchResult = z.object({
  items: z.array(z.object({ path: z.string(), key: z.string(), text: z.string(), score: z.number() })),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;

/** How capture behaves; set in onboarding, changed in Settings or on the Memory page. */
export const MemorySettings = z
  .object({ capture: z.enum(['auto_confident', 'propose_all', 'off']) })
  .strict();
export type MemorySettings = z.infer<typeof MemorySettings>;
