/**
 * ------------------------------------------------------------------
 *  Title    |  Files for one message
 *  Ref      |  ROADMAP.md CH6 · contracts attachments.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Attach a PDF, text, code or CSV file to the next
 *           |  message, read for that message only, and say in words
 *           |  what the chip holds.
 *  How      |  A multipart POST to /threads/:id/attachments; Core reads
 *           |  the file and answers with its name, kind, page count and
 *           |  length. The turn names it by id. A refusal rejects with
 *           |  Core's own { title, hint }.
 *  Note     |  Nothing here adds to a notebook. "Keep in notebook" on a
 *           |  chip is the ordinary source upload (sources/uploads),
 *           |  made after the message has gone.
 *           |  TODO(phase-0.1.1): Pro shows a token estimate on the chip
 *           |  and trims to the relevant pages when over budget.
 * ------------------------------------------------------------------
 */

import { type AttachmentRecord, attachableKind, CLIENT_ID_HEADER } from '@nvx/contracts';
import { API_BASE, WINDOW_ID } from '../lib/api';

/** Can the composer attach this file to a message (not an image: images have their own path)? */
export const isAttachableFile = (f: File): boolean => attachableKind(f.name, f.type) !== null;

/** Upload one file for the next message. Rejects with Core's { title, hint } on a refusal. */
export async function attachFile(threadId: string, file: File): Promise<AttachmentRecord> {
  const form = new FormData();
  form.append('file', file, file.name || 'file');
  const res = await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/attachments`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', [CLIENT_ID_HEADER]: WINDOW_ID },
    body: form,
  });
  const body = (await res.json().catch(() => null)) as
    | AttachmentRecord
    | { error?: { title?: string; hint?: string } }
    | null;
  if (!res.ok) {
    const err = (body as { error?: { title?: string; hint?: string } } | null)?.error;
    throw Object.assign(new Error(err?.title ?? 'That file could not be attached.'), {
      hint: err?.hint ?? 'Check the file opens on this computer, then try again.',
    });
  }
  return body as AttachmentRecord;
}

/** Forget a file that will not be sent. Best effort: Core drops it after an hour anyway. */
export function discardAttachment(threadId: string, id: string): void {
  void fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { [CLIENT_ID_HEADER]: WINDOW_ID },
  }).catch(() => undefined);
}

/** What a chip says about its file: "12 pages", "start only", or nothing for a short text file. */
export function chipWords(r: Pick<AttachmentRecord, 'kind' | 'pages' | 'truncated'>): string {
  const pages = r.pages ? `${r.pages} ${r.pages === 1 ? 'page' : 'pages'}` : '';
  if (r.truncated) return pages ? `${pages}, start only` : 'start only';
  return pages;
}
