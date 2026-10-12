/**
 * ------------------------------------------------------------------
 *  Title    |  Notebook merge and context links
 *  Ref      |  docs/notebooks.md · docs/scopes.md · ROADMAP.md track C
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Two ways notebooks and threads come together. Merge
 *           |  folds notebook B into notebook A for good (with an undo
 *           |  window). A context link lets a thread or a notebook draw
 *           |  on another's context without moving anything: a
 *           |  notebook's sources, or a thread's summary.
 *  How      |  Merge is preview first, then apply. The preview names
 *           |  everything that moves, every source that is deduplicated
 *           |  and every scope field that narrows. A link is
 *           |  directional and listed on both ends; every read across
 *           |  it passes the reading side's scope and the linked side's.
 *  Note     |  A merge never widens a scope: the merged notebook takes
 *           |  the narrower value of every field, and private wins.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import { AncileInstructions } from './engines';
import { ScopeDenyCode, ScopeField, ScopePatch } from './scopes';

/* ---- Notebook merge ------------------------------------------------------ */

const Ref = z.object({ id: z.string(), title: z.string() });

/** One scope field as each notebook has it, and as the merged notebook will. */
export const MergeScopeChange = z.object({
  field: ScopeField,
  into: z.unknown(),
  from: z.unknown(),
  merged: z.unknown(),
  /** The merged value is narrower than what the notebook merged into had. */
  narrows_into: z.boolean(),
  /** The merged value is narrower than what the notebook merged away had. */
  narrows_from: z.boolean(),
  /** In words, for the dialog ("Tools: only the ones both allow"). */
  note: z.string(),
});
export type MergeScopeChange = z.infer<typeof MergeScopeChange>;

/** GET /notebooks/:id/merge-preview?from=…: everything a merge would do, before it does it. */
export const NotebookMergePreview = z.object({
  into: Ref,
  from: Ref,
  threads: z.array(z.object({ id: z.string(), title: z.string(), cwd: z.string().nullable() })),
  notes: z.array(Ref),
  sources: z.object({
    /** B's sources that join A. */
    move: z.array(Ref),
    /** Already in both notebooks: nothing to do. */
    already: z.array(Ref),
    /** Same content as one of A's sources: B's copy is merged into A's, and citations still resolve. */
    duplicates: z.array(Ref.extend({ into_id: z.string(), into_title: z.string() })),
    /** Same address or title with different content: both are kept. */
    versions: z.array(Ref.extend({ into_id: z.string() })),
  }),
  memory: z.object({
    from_path: z.string().nullable(),
    into_path: z.string().nullable(),
    /** Entries in B's notebook memory that would be added to A's. */
    entries: z.number().int(),
  }),
  flows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      active: z.boolean(),
      /** A already has an active flow, so this one arrives switched off. */
      switched_off: z.boolean(),
    }),
  ),
  instructions: z.object({ into: AncileInstructions, from: AncileInstructions, same: z.boolean() }),
  scope: z.object({
    private: z.object({ into: z.boolean(), from: z.boolean(), merged: z.boolean() }),
    /** Every field whose value differs between the two notebooks. */
    changes: z.array(MergeScopeChange),
    /** What the merged notebook stores. */
    merged: ScopePatch,
  }),
  tool_presets: z.object({
    into: z.string().nullable(),
    from: z.string().nullable(),
    merged: z.string().nullable(),
    /** Both chose different presets: the other preset's rules are folded into the notebook's own tool fields. */
    folded: z.boolean(),
  }),
  /** Claude Code folders bound to each notebook. After a merge, A holds them all; threads keep their own folder. */
  folders: z.object({ into: z.array(z.string()), from: z.array(z.string()) }),
  links: z.object({
    /** Context links to or from B that will point at A. */
    retarget: z.number().int(),
    /** Links between A and B that would point at A itself: removed. */
    dropped: z.number().int(),
  }),
  /** Remembered approvals scoped to B. They stay with B and are not carried over: that would widen A. */
  grants_left_behind: z.number().int(),
  undo_hours: z.number().int(),
  warnings: z.array(z.string()),
});
export type NotebookMergePreview = z.infer<typeof NotebookMergePreview>;

/** How the merged notebook's instructions and persona are chosen. */
export const MergeInstructionsChoice = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('into') }),
  z.object({ choice: z.literal('from') }),
  z.object({
    choice: z.literal('combined'),
    instructions: AncileInstructions.shape.instructions,
    persona: AncileInstructions.shape.persona,
  }),
]);
export type MergeInstructionsChoice = z.infer<typeof MergeInstructionsChoice>;

/** POST /notebooks/:id/merge: merge `from_id` into this notebook. */
export const MergeNotebookRequest = z
  .object({
    from_id: z.string().min(1).max(100),
    instructions: MergeInstructionsChoice.default({ choice: 'into' }),
  })
  .strict();
export type MergeNotebookRequest = z.input<typeof MergeNotebookRequest>;

/** A merge as history keeps it. */
export const NotebookMerge = z.object({
  id: z.string(),
  into_id: z.string(),
  from_id: z.string(),
  from_title: z.string(),
  merged_at: z.string(),
  undo_until: z.string(),
  undone_at: z.string().nullable(),
  can_undo: z.boolean(),
  counts: z.object({
    threads: z.number().int(),
    notes: z.number().int(),
    sources_moved: z.number().int(),
    sources_deduplicated: z.number().int(),
    flows: z.number().int(),
    folders: z.number().int(),
    links: z.number().int(),
  }),
  /** Scope fields that became narrower for the notebook merged into. */
  scope_narrowed: z.array(ScopeField),
});
export type NotebookMerge = z.infer<typeof NotebookMerge>;

export const NotebookMergeList = z.object({ items: z.array(NotebookMerge) });
export type NotebookMergeList = z.infer<typeof NotebookMergeList>;

/* ---- Knowledge side of a merge (Core ↔ Knowledge) ------------------------ */

export const KnMergePreview = z.object({
  move: z.array(Ref),
  already: z.array(Ref),
  duplicates: z.array(Ref.extend({ into_id: z.string(), into_title: z.string() })),
  versions: z.array(Ref.extend({ into_id: z.string() })),
});
export type KnMergePreview = z.infer<typeof KnMergePreview>;

/** What the knowledge service did, kept so the merge can be undone. */
export const KnMergeRecord = z.object({
  moved: z.array(z.object({ source_id: z.string(), context_level: z.string() })),
  already: z.array(z.object({ source_id: z.string(), context_level: z.string() })),
  merged: z.array(
    z.object({
      source_id: z.string(),
      into_id: z.string(),
      title: z.string(),
      kind: z.string().nullable(),
      context_level: z.string(),
      /** The duplicate was in no other notebook, so it was removed (soft) in favour of A's copy. */
      deleted: z.boolean(),
    }),
  ),
});
export type KnMergeRecord = z.infer<typeof KnMergeRecord>;

/* ---- Context links ------------------------------------------------------- */

/** sources: read a notebook's sources. summary: see a thread's summary. */
export const ContextLinkKind = z.enum(['sources', 'summary']);
export type ContextLinkKind = z.infer<typeof ContextLinkKind>;

export const ContextLinkEnd = z.object({
  kind: z.enum(['thread', 'notebook']),
  id: z.string(),
  /** Null when that end is gone. */
  title: z.string().nullable(),
});
export type ContextLinkEnd = z.infer<typeof ContextLinkEnd>;

export const ContextLinkStatus = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: ScopeDenyCode, reason: z.string() }),
]);
export type ContextLinkStatus = z.infer<typeof ContextLinkStatus>;

export const ContextLink = z.object({
  id: z.string(),
  kind: ContextLinkKind,
  from: ContextLinkEnd,
  to: ContextLinkEnd,
  created_at: z.string(),
  /** Whether a read across it is allowed now, from both scopes as they are now. */
  status: ContextLinkStatus,
});
export type ContextLink = z.infer<typeof ContextLink>;

/** GET /threads/:id/links and GET /notebooks/:id/links: both ends. */
export const ContextLinkList = z.object({
  /** This side reads from these. */
  outgoing: z.array(ContextLink),
  /** These read from this side. */
  incoming: z.array(ContextLink),
});
export type ContextLinkList = z.infer<typeof ContextLinkList>;

/** POST /threads/:id/links and POST /notebooks/:id/links. */
export const CreateContextLinkRequest = z
  .object({
    to_kind: z.enum(['notebook', 'thread']),
    to_id: z.string().min(1).max(100),
  })
  .strict();
export type CreateContextLinkRequest = z.infer<typeof CreateContextLinkRequest>;

/** What the Why view shows for each link a turn considered. */
export const ExplainLink = z.object({
  /** The link's id, or a context pack's (Pro). */
  link_id: z.string(),
  kind: z.enum(['sources', 'summary', 'pack']),
  /** Where the link was made, or the pack attached: on this thread, or on its notebook. */
  via: z.enum(['thread', 'notebook']),
  to_kind: z.enum(['notebook', 'thread', 'pack']),
  to_id: z.string(),
  title: z.string(),
  /** used: it gave passages or a summary. empty: nothing matched. refused: a scope said no. */
  state: z.enum(['used', 'empty', 'refused']),
  passages: z.number().int(),
  cited: z.number().int(),
  code: ScopeDenyCode.nullable(),
  reason: z.string().nullable(),
});
export type ExplainLink = z.infer<typeof ExplainLink>;
