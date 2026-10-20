/**
 * ------------------------------------------------------------------
 *  Title    |  Memory API
 *  Ref      |  DESIGN.md §6, §4.1 (Memory routes)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes the Cockpit and Core agree on for memory:
 *           |  files and their entries, history and diffs, the inbox
 *           |  of proposals, the pack injected into a model call, and
 *           |  moving memory in and out (export; import for review).
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
  /** Brought in from an export (NVX Ancile, Claude Code, ChatGPT, notes): always waits for a yes. */
  'imported',
]);
export const ProposalOp = z.enum(['add', 'update', 'supersede']);
export const ProposalStatus = z.enum([
  'proposed',
  'applied',
  'rejected',
  'auto_applied',
  'undone',
  /** M8: seen once, written down with its uncertainty, waiting for a second sighting. */
  'watching',
  /** M8: a watch item that was not seen again within its time. */
  'expired',
]);
export const ProposalProvenance = z.enum([
  'user_message',
  'run_outcome',
  'tool_output',
  'source_content',
  /** A file or a paste the person chose to import: outside content, so only ever proposed. */
  'import',
]);

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
  /** The import it came from (kind imported); absent otherwise. */
  import_id: z.string().nullable().optional(),
  /** M8: times the same lesson has been seen. A lesson needs two (or verified evidence) before it is a rule. */
  sightings: z.number().int().optional(),
  /** M8: a watch item lapses on this date if it is not seen again. */
  expires_at: z.string().nullable().optional(),
  /** M8: what is not yet known about a watch item, in words. */
  uncertainty: z.string().nullable().optional(),
  /** M3: where it was learned, resolved when the list is read. */
  source: z
    .object({
      thread_id: z.string(),
      thread_title: z.string().nullable(),
      /** The thread has been deleted, so there is nothing to open. */
      thread_deleted: z.boolean(),
      message_id: z.string().nullable(),
      /** The notebook the thread is in; title is null when that notebook has been deleted. */
      notebook: z.object({ id: z.string(), title: z.string().nullable() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

export const MemoryProposalList = z.object({ items: z.array(MemoryProposal), pending: z.number().int() });
export type MemoryProposalList = z.infer<typeof MemoryProposalList>;

export const ProposalScope = z.enum(['user', 'notebook', 'everywhere']);
export type ProposalScope = z.infer<typeof ProposalScope>;

export const ProposalDecisionRequest = z
  .object({
    /** undo reverts an applied or auto-applied proposal's commit. */
    decision: z.enum(['approve', 'reject', 'undo']),
    /** Approve with the text edited first. */
    text: z.string().min(1).max(2_000).optional(),
    /**
     * M1: where to keep it when approving. user is USER.md, notebook is the notebook
     * the thread belongs to, everywhere is AGENTS.md. Absent: where it was proposed.
     */
    scope: ProposalScope.optional(),
    /** M1: or a specific memory file. Wins over scope. */
    path: z.string().min(1).max(200).optional(),
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
  .object({
    capture: z.enum(['auto_confident', 'propose_all', 'off']),
    /** Learn from things said in passing (on when absent). Private notebooks follow Settings → Private notebooks. */
    passive: z.boolean().optional(),
  })
  .strict();
export type MemorySettings = z.infer<typeof MemorySettings>;

/* ---- Export and import (ROADMAP final run, track E) ------------------------------ */

/**
 * zip: the files as they are now (git archive). bundle: the whole repository,
 * history included (git bundle). markdown: one readable file. Exports are made
 * on this computer and handed to the browser to save; nothing is uploaded.
 */
export const MemoryExportFormat = z.enum(['zip', 'bundle', 'markdown']);
export type MemoryExportFormat = z.infer<typeof MemoryExportFormat>;

/** What an export would hold, so the Cockpit can say before you save it. */
export const MemoryExportPlan = z.object({
  head: z.string(),
  files: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  notebooks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      path: z.string(),
      /** PROJECTS/<slug>.md exists. */
      exists: z.boolean(),
      private: z.boolean(),
    }),
  ),
});
export type MemoryExportPlan = z.infer<typeof MemoryExportPlan>;

/** Where an import comes from. Only open, documented or plain-text formats. */
export const MemoryImportOrigin = z.enum(['ancile', 'claude_code', 'chatgpt', 'markdown']);
export type MemoryImportOrigin = z.infer<typeof MemoryImportOrigin>;

/** Which memory file the entries go to (an NVX Ancile export keeps its own paths). */
export const MemoryImportTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('agents') }).strict(),
  z.object({ kind: z.literal('notebook'), notebook_id: z.string().min(1) }).strict(),
]);
export type MemoryImportTarget = z.infer<typeof MemoryImportTarget>;

export const MemoryImportRequest = z
  .object({
    origin: MemoryImportOrigin,
    /** The file's name as picked, for the commit message. Never a path on this computer. */
    filename: z.string().max(255).optional(),
    /** A text file or a paste (Markdown, CLAUDE.md, a ChatGPT list or JSON). */
    text: z.string().max(5_000_000).optional(),
    /** A zip or a git bundle made by NVX Ancile's export, base64. */
    data_base64: z.string().max(28_000_000).optional(),
    target: MemoryImportTarget.default({ kind: 'user' }),
    /** On create: the preview items to propose, by index. Absent: every new one. */
    include: z.array(z.number().int().nonnegative()).max(5_000).optional(),
  })
  .strict()
  .refine((r) => !!r.text?.trim() || !!r.data_base64, { message: 'send text or data_base64' });
export type MemoryImportRequest = z.infer<typeof MemoryImportRequest>;

export const MemoryImportItem = z.object({
  index: z.number().int().nonnegative(),
  target_path: z.string(),
  section: z.string(),
  text: z.string(),
  /** new: not remembered yet. duplicate: already in memory. repeated: earlier in this import. */
  status: z.enum(['new', 'duplicate', 'repeated']),
  /** The entry was longer than an entry may be, and was cut. */
  clipped: z.boolean(),
  /**
   * Why the entry is not ticked by default although it is new: it reads like
   * instructions to an AI (the same check Auto mode runs on tool input).
   */
  flag: z.string().nullable().optional(),
});
export type MemoryImportItem = z.infer<typeof MemoryImportItem>;

export const MemoryImportPreview = z.object({
  origin: MemoryImportOrigin,
  /** "ChatGPT memory", "CLAUDE.md", "NVX Ancile export". */
  label: z.string(),
  filename: z.string().nullable(),
  items: z.array(MemoryImportItem),
  /** Lines left out because they are not entries (code, tables, Claude Code @imports). */
  skipped: z.number().int().nonnegative(),
  /** Plain sentences about what was left out or changed. */
  notes: z.array(z.string()),
  files: z.array(z.object({ path: z.string(), exists: z.boolean() })),
});
export type MemoryImportPreview = z.infer<typeof MemoryImportPreview>;

export const MemoryImportSummary = z.object({
  id: z.string(),
  origin: MemoryImportOrigin,
  label: z.string(),
  filename: z.string().nullable(),
  created_at: z.string(),
  /** reviewing: suggestions still wait for a yes or a no. */
  status: z.enum(['reviewing', 'done']),
  counts: z.object({
    proposed: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    undone: z.number().int().nonnegative(),
  }),
});
export type MemoryImportSummary = z.infer<typeof MemoryImportSummary>;

export const MemoryImportView = MemoryImportSummary.extend({ proposals: z.array(MemoryProposal) });
export type MemoryImportView = z.infer<typeof MemoryImportView>;

export const MemoryImportList = z.object({ items: z.array(MemoryImportSummary) });
export type MemoryImportList = z.infer<typeof MemoryImportList>;

/** Accept some or all of an import's suggestions: they are committed together, once. */
export const MemoryImportDecision = z
  .object({
    accept: z.union([z.literal('all'), z.array(z.string()).max(5_000)]).default([]),
    /** rest: everything still waiting that was not accepted. */
    reject: z.union([z.literal('rest'), z.array(z.string()).max(5_000)]).default([]),
    /** Accept with the text edited first, by proposal id. */
    edits: z.record(z.string(), z.string().min(1).max(2_000)).optional(),
  })
  .strict();
export type MemoryImportDecision = z.infer<typeof MemoryImportDecision>;

export const MemoryImportDecisionResult = z.object({
  import: MemoryImportView,
  /** The one commit the accepted entries went into; null when nothing was accepted. */
  commit_sha: z.string().nullable(),
  applied: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
export type MemoryImportDecisionResult = z.infer<typeof MemoryImportDecisionResult>;

/** M9: the result of a hindsight pass. It only proposes; nothing here has been written to memory. */
export const HindsightResponse = z.object({
  /** True when the review found nothing worth keeping. A valid answer. */
  nothing_worth_keeping: z.boolean(),
  /** What the review makes of the session, in a sentence or two. */
  note: z.string(),
  proposals: z.array(MemoryProposal),
  /** Turns (user questions and answers) looked at. */
  turns_reviewed: z.number().int(),
  /** The session was long, so it was summarised first. */
  summarised: z.boolean(),
});
export type HindsightResponse = z.infer<typeof HindsightResponse>;

/* ---- Standards: compare your work with one ------------------------------------------ */

export const CompareRequest = z
  .object({
    /** The message whose text is the person's work. */
    message_id: z.string().min(1),
    /** A standard to use (STANDARDS/manager.md); absent: the closest one. */
    path: z.string().min(1).max(200).optional(),
    key: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CompareRequest = z.infer<typeof CompareRequest>;

export const CompareResponse = z.object({
  /** The standard entry the comparison cites. */
  standard: z.object({ path: z.string(), key: z.string(), text: z.string(), commit: z.string() }),
  summary: z.string(),
  differences: z.array(z.object({ point: z.string(), yours: z.string(), standard: z.string() })),
  suggestions: z.array(z.string()),
});
export type CompareResponse = z.infer<typeof CompareResponse>;

/** "Update memory" under a note that nothing changed: save what the person said in that message. */
export const UpdateFromMessageRequest = z.object({ message_id: z.string().min(1) }).strict();
export type UpdateFromMessageRequest = z.infer<typeof UpdateFromMessageRequest>;
