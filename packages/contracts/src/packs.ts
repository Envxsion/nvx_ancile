/**
 * ------------------------------------------------------------------
 *  Title    |  Context packs (Pro)
 *  Ref      |  docs/notebooks.md (Context packs) · DESIGN.md §9
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  A saved, named bundle of context: chosen sources, notes,
 *           |  a thread's summary, memory entries and instructions. It
 *           |  attaches to any thread or notebook in one click, and
 *           |  travels as a signed file with a manifest.
 *  How      |  The shapes only. The implementation is Pro's; the free
 *           |  build answers every pack route with 402
 *           |  pro.feature_required (feature `context_packs`).
 *  Note     |  A pack keeps where each item came from. Attaching it,
 *           |  and every turn that reads it, passes the same scope
 *           |  checks a context link does: a pack made from a private
 *           |  notebook never reaches a cloud model.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Where an item was taken from: the scope of that place travels with it. */
export const PackOrigin = z.object({ kind: z.enum(['notebook', 'thread']), id: z.string() });
export type PackOrigin = z.infer<typeof PackOrigin>;

export const PackItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('source'),
    source_id: z.string(),
    title: z.string(),
    content_hash: z.string().nullable(),
    /** The notebook it was taken from: a turn searches it there. */
    notebook_id: z.string().nullable(),
    /** Only in an exported file: the source's text, so it can be added on import. */
    text: z.string().optional(),
  }),
  z.object({ kind: z.literal('note'), title: z.string(), content_md: z.string() }),
  z.object({ kind: z.literal('summary'), thread_title: z.string(), text: z.string() }),
  z.object({ kind: z.literal('memory'), path: z.string(), text: z.string() }),
  z.object({ kind: z.literal('instructions'), instructions: z.string(), persona: z.string() }),
]);
export type PackItem = z.infer<typeof PackItem>;

export const PackTarget = z.object({ kind: z.enum(['thread', 'notebook']), id: z.string() });
export type PackTarget = z.infer<typeof PackTarget>;

export const ContextPack = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  items: z.array(PackItem),
  /** Taken from somewhere nothing may leave this machine: only attaches where that also holds. */
  local_only: z.boolean(),
  origins: z.array(PackOrigin),
  attached: z.array(PackTarget),
  /** Imported from a file: who signed it (a key fingerprint). */
  imported_from: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ContextPack = z.infer<typeof ContextPack>;

export const ContextPackList = z.object({ items: z.array(ContextPack) });
export type ContextPackList = z.infer<typeof ContextPackList>;

/** POST /pro/context-packs: pick what goes in by id; Pro reads each item now. */
export const CreateContextPackRequest = z
  .object({
    /** The notebook or thread the pack is made from: its sources and notes are the ones offered. */
    from: z.object({ kind: z.enum(['thread', 'notebook']), id: z.string() }),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(400).default(''),
    source_ids: z.array(z.string()).max(50).default([]),
    note_ids: z.array(z.string()).max(50).default([]),
    summary_thread_id: z.string().nullable().default(null),
    memory_entry_ids: z.array(z.string()).max(50).default([]),
    /** Take the instructions and persona of this notebook or thread. */
    instructions_from: PackTarget.nullable().default(null),
  })
  .strict();
export type CreateContextPackRequest = z.input<typeof CreateContextPackRequest>;

/** POST /pro/context-packs/:id/attach and /detach. */
export const AttachContextPackRequest = z.object({ target: PackTarget }).strict();
export type AttachContextPackRequest = z.infer<typeof AttachContextPackRequest>;

export const PACK_FORMAT = 'nvx-ancile.context-pack';

/** What a pack file says it holds. Signed with the exporting install's key. */
export const PackManifest = z.object({
  format: z.literal(PACK_FORMAT),
  version: z.literal(1),
  name: z.string(),
  description: z.string(),
  created_at: z.string(),
  local_only: z.boolean(),
  items: z.array(
    z.object({
      kind: z.enum(['source', 'note', 'summary', 'memory', 'instructions']),
      title: z.string(),
      bytes: z.number().int(),
      sha256: z.string(),
    }),
  ),
  signer: z.object({ key_id: z.string(), public_key: z.string() }),
});
export type PackManifest = z.infer<typeof PackManifest>;

/** GET /pro/context-packs/:id/export: the file. */
export const PackFile = z.object({
  manifest: PackManifest,
  items: z.array(PackItem),
  /** Ed25519 over the canonical JSON of the manifest (base64url). */
  signature: z.string(),
});
export type PackFile = z.infer<typeof PackFile>;

/** POST /pro/context-packs/import/preview: what a file holds, before anything is added. */
export const PackImportPreview = z.object({
  manifest: PackManifest,
  /** The signature matches the manifest, and every item matches its hash. */
  verified: z.boolean(),
  /** Signed by this install's own key. */
  own_key: z.boolean(),
  fingerprint: z.string(),
  problems: z.array(z.string()),
});
export type PackImportPreview = z.infer<typeof PackImportPreview>;
