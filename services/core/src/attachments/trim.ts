/**
 * ------------------------------------------------------------------
 *  Title    |  Keeping the relevant pages of an attached file
 *  Ref      |  ROADMAP.md CH6 (Pro half) · attachments/service.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When a message with attached files is over the
 *           |  model's context budget, Pro may keep only the pages
 *           |  that matter to the message. This file is the public
 *           |  shape of that question and its answer, and the one
 *           |  place Core applies the answer to the file parts.
 *  How      |  engines/index.ts builds a TrimQuery from the message,
 *           |  the chosen model's context window and the held files,
 *           |  asks the Pro hook (ProHooks.trimAttachments) and calls
 *           |  applyTrim. A hook that fails, or answers nothing for a
 *           |  file, leaves that file whole: trimming never stops a
 *           |  message from sending.
 *  Note     |  Nothing here reads a model or the network. A Claude
 *           |  Code thread never gets here: it is given a path, so
 *           |  there is nothing to trim (attachment.claude_code).
 * ------------------------------------------------------------------
 */

import type { FilePart } from '@nvx/contracts';

/** One attached file, as Pro sees it. */
export interface TrimFile {
  id: string;
  name: string;
  kind: 'pdf' | 'text';
  /** The text that would go to the model. */
  text: string;
  /** PDF only. */
  pages: number | null;
  /** PDF only: [start, end) of each page within `text`. Null: the reader gave none (a text file). */
  spans: [number, number][] | null;
}

export interface TrimQuery {
  threadId: string;
  /** The notebook the thread is in; null for a loose thread. */
  notebookId: string | null;
  /** The message the files go with. Data, never an instruction. */
  message: string;
  /** The message's parent: the history before it counts against the budget. */
  parentId: string | null;
  /** The chosen model's context window in tokens; null when it is not known (nothing is trimmed). */
  contextWindow: number | null;
  files: TrimFile[];
}

/** What stays of one file. */
export interface TrimmedFile {
  id: string;
  text: string;
  kept: NonNullable<FilePart['kept']>;
}

/** Files Pro kept part of; a file not listed goes whole. */
export type TrimResult = TrimmedFile[];

/**
 * The file parts with Pro's choice applied, in the same order. `ids` and `files` line up (partsFor
 * answers in the order asked), so a part is matched to its answer by position.
 */
export function applyTrim(files: FilePart[], ids: string[], result: TrimResult): FilePart[] {
  const byId = new Map(result.map((r) => [r.id, r]));
  return files.map((f, i) => {
    const t = byId.get(ids[i] ?? '');
    if (!t?.text.trim() || t.text.length >= (f.text?.length ?? 0)) return f;
    return { ...f, text: t.text, kept: t.kept };
  });
}
