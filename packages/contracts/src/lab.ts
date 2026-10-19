/**
 * ------------------------------------------------------------------
 *  Title    |  Coding lab settings
 *  Ref      |  ROADMAP LB3 · docs/api.md (Lab)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  What a person can set about the coding lab:
 *           |  whether files a run edited are formatted with the
 *           |  project's own formatter. GET and PUT /lab/settings.
 *  Note     |  Off by default: running a formatter runs the project's
 *           |  own tools, and each command still asks the permission
 *           |  gate first.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const LabSettings = z.object({
  /** Run the project's formatter on the files a lab run edited. */
  format_on_edit: z.boolean(),
});
export type LabSettings = z.infer<typeof LabSettings>;

export const PatchLabSettings = z.object({ format_on_edit: z.boolean().optional() }).strict();
export type PatchLabSettings = z.infer<typeof PatchLabSettings>;

/** POST /lab/init: draft an AGENTS.md for a registered repository. Writes nothing. */
export const LabInitRequest = z.object({ repo_id: z.string().min(1).max(200) }).strict();
export type LabInitRequest = z.infer<typeof LabInitRequest>;

export const LabInitDraft = z.object({
  /** Where it would be saved: <repository>/AGENTS.md. */
  path: z.string(),
  content: z.string(),
  /** An AGENTS.md is already there. The draft is never written over it; the diff is for reading. */
  exists: z.boolean(),
  /** The existing file's hash, for the editor's save. Null when there is none. */
  existing_sha256: z.string().nullable(),
  diff: z.string().nullable(),
});
export type LabInitDraft = z.infer<typeof LabInitDraft>;
