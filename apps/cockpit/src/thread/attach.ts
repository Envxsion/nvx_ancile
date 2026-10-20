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
 *           |  Pro (CH6) adds a token estimate to the chip (Core sends
 *           |  `tokens` only when Pro is on) and, when a message is
 *           |  over the model's budget, keeps the relevant pages: the
 *           |  sent file then says "Pages 3–7 of 40 kept"
 *           |  (thread/Parts.tsx). Without Pro the chip says what it
 *           |  holds and one quiet line says what Pro adds
 *           |  (thread/AttachPro.tsx).
 * ------------------------------------------------------------------
 */

import type { AttachmentRecord } from '@nvx/contracts';
import { ATTACHMENT_LIMITS, attachableKind } from '@nvx/contracts/attachments';
import { CLIENT_ID_HEADER } from '@nvx/contracts/engines';
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

/** Why a chip says "start only": shown on hover, not always on screen (QU1). */
export function cutNote(r: Pick<AttachmentRecord, 'truncated'>): string | undefined {
  return r.truncated
    ? `Only the first ${ATTACHMENT_LIMITS.chars.toLocaleString('en-GB')} characters were read.`
    : undefined;
}

/**
 * What a chip says about its file: "12 pages", "start only", or nothing for a short text file. With
 * Pro, "about 8,400 tokens" too, so you can see what the file costs before you send.
 */
export function chipWords(
  r: Pick<AttachmentRecord, 'kind' | 'pages' | 'truncated'> & { tokens?: number | undefined },
): string {
  const pages = r.pages ? `${r.pages} ${r.pages === 1 ? 'page' : 'pages'}` : '';
  const tokens = r.tokens !== undefined ? `about ${r.tokens.toLocaleString('en-GB')} tokens` : '';
  return [pages, r.truncated ? 'start only' : '', tokens].filter(Boolean).join(', ');
}
