/**
 * ------------------------------------------------------------------
 *  Title    |  Files (the code editor)
 *  Ref      |  docs/api.md (Files)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Reading and saving one text file from the Cockpit's
 *           |  editor: files a thread refers to (Claude Code edits,
 *           |  lab files, repository files).
 *  How      |  GET /files?path=…&thread_id=… reads; PUT /files saves.
 *           |  Both run through permissions/decide on the real path
 *           |  (fs.read, fs.write). A save the gate would ask about
 *           |  answers 409 files.needs_confirm with the reason; the
 *           |  Cockpit asks the person and sends confirmed: true. A
 *           |  save on top of a file that changed since it was read
 *           |  answers 409 files.changed.
 *  Note     |  Only folders NVX Ancile already knows are reachable:
 *           |  the workspace (labs included), registered repositories
 *           |  and Claude Code project folders.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Largest file the editor opens or saves. */
export const FILE_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

export const FileRootKind = z.enum(['workspace', 'repo', 'claude_code']);
export type FileRootKind = z.infer<typeof FileRootKind>;

export const FileContent = z.object({
  /** The path as asked, resolved to an absolute path on this machine. */
  path: z.string(),
  /** File name only. */
  name: z.string(),
  root: z.object({ kind: FileRootKind, path: z.string(), label: z.string() }),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  modified_at: z.string(),
  /** Not valid UTF-8 text: shown read-only, never saved from the editor. */
  binary: z.boolean(),
});
export type FileContent = z.infer<typeof FileContent>;

export const FileWriteRequest = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(FILE_EDITOR_MAX_BYTES),
  /** The sha256 the editor opened; null for a new file. A mismatch is files.changed. */
  base_sha256: z.string().nullable(),
  thread_id: z.string().nullable().optional(),
  /** The person confirmed a save the gate asked about. */
  confirmed: z.boolean().default(false),
});
export type FileWriteRequest = z.infer<typeof FileWriteRequest>;

export const FileWriteResult = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  modified_at: z.string(),
});
export type FileWriteResult = z.infer<typeof FileWriteResult>;
