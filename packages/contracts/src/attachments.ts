/**
 * ------------------------------------------------------------------
 *  Title    |  Per-message attachments
 *  Ref      |  ROADMAP.md CH6 · docs/errors.md (attachment.*)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes Core and the Cockpit share for a file that
 *           |  goes with one message: PDF, text, code and CSV, read
 *           |  for this message only and shown as a chip.
 *  How      |  POST /threads/:id/attachments takes the file, reads it
 *           |  and answers with an AttachmentRecord (no text: the chip
 *           |  needs a name and a page count, not the file). The turn
 *           |  names it by id (attachment_ids); Core puts the text on
 *           |  the user message as a FilePart. Nothing is added to a
 *           |  notebook unless the person turns "Keep in notebook" on,
 *           |  which is a separate, explicit source upload.
 *  Note     |  TODO(phase-0.1.1): Pro adds a token estimate per chip
 *           |  and trims to the relevant pages when a file is over
 *           |  budget. AttachmentRecord has room for `tokens`; the
 *           |  free build leaves it out.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const ATTACHMENT_LIMITS = {
  /** One file, as uploaded. */
  bytes: 25 * 1024 * 1024,
  /** Characters of one file that go to the model; a longer file keeps its start and says so. */
  chars: 200_000,
  /** Files on one message. */
  perTurn: 5,
  /** How long an attached file waits for its message (ms). */
  keepMs: 60 * 60 * 1000,
} as const;

/** Text and code the composer reads as text (by extension, or a text/* type). */
export const ATTACHMENT_TEXT_EXTENSIONS: readonly string[] = [
  ...['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'css'],
  ...['log', 'ini', 'cfg', 'sql', 'sh', 'ps1', 'bat', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go'],
  ...['rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'lua', 'r', 'tex', 'bib'],
];

export const AttachmentKind = z.enum(['pdf', 'text']);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** What the composer holds for a file once Core has read it. */
export const AttachmentRecord = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  kind: AttachmentKind,
  bytes: z.number().int().nonnegative(),
  /** PDF only. */
  pages: z.number().int().positive().nullable(),
  /** Characters that will go to the model. */
  chars: z.number().int().nonnegative(),
  /** The file was longer than ATTACHMENT_LIMITS.chars: only its start goes. */
  truncated: z.boolean(),
  /** Pro: a rough token count for the chip (not sent by the free build). */
  tokens: z.number().int().nonnegative().optional(),
});
export type AttachmentRecord = z.infer<typeof AttachmentRecord>;

/** What kind of attachment a file is, or null when the composer cannot read it as one. */
export function attachableKind(name: string, mime: string): AttachmentKind | null {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  if (['application/json', 'application/xml', 'application/x-yaml', 'application/toml'].includes(mime))
    return 'text';
  return ATTACHMENT_TEXT_EXTENSIONS.includes(ext) ? 'text' : null;
}
