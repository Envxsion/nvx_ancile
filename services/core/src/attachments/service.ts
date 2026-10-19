/**
 * ------------------------------------------------------------------
 *  Title    |  Files for one message
 *  Ref      |  ROADMAP.md CH6 · packages/contracts/src/attachments.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read a PDF, text, code or CSV file the person attached
 *           |  to a message, hold its text until that message is sent,
 *           |  and hand it to the turn as a file part. It is for that
 *           |  message only: never a source, never indexed, never
 *           |  written to memory.
 *  How      |  Text and code are decoded here (UTF-8, a binary file is
 *           |  refused). A PDF goes to the knowledge service's reader
 *           |  (POST /kn/v1/attachments/extract), the same one sources
 *           |  use, so page counts agree. Parsed text waits in memory
 *           |  for an hour, per thread, and is dropped when sent or
 *           |  discarded; a restart of Core loses what was waiting, and
 *           |  the next send says to attach the file again. A long file
 *           |  keeps its first ATTACHMENT_LIMITS.chars characters and
 *           |  says so on the chip and to the model.
 *  Note     |  GR2: the text is data. The gateway wraps it as a quoted
 *           |  attachment (gateway/convert.ts); nothing in it is
 *           |  followed as an instruction.
 *           |  TODO(phase-0.1.1): Pro adds a token estimate per chip
 *           |  and trims to the relevant pages over budget.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  ATTACHMENT_LIMITS,
  type AttachmentRecord,
  attachableKind,
  type FilePart,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import type { KnowledgeClient } from '../knowledge/client';
import { logFor } from '../obs/logger';

const log = logFor('attachments');

const fail = (code: string, title: string, hint: string, status: number) =>
  new AncileError({ code, title, hint, status, errorClass: 'permanent' });

export const tooLarge = (name: string) =>
  fail(
    'attachment.too_large',
    `${name} is too large to attach`,
    `A file can be up to ${Math.round(ATTACHMENT_LIMITS.bytes / 1024 / 1024)} MB. Attach a smaller copy, or add it to a notebook as a source.`,
    413,
  );
export const notReadable = (name: string) =>
  fail(
    'attachment.type_not_allowed',
    `${name} is not a file a message can carry`,
    'Attach a PDF, or a text, code or CSV file. For other files, add them to a notebook as sources.',
    415,
  );
export const unreadable = (name: string) =>
  fail(
    'attachment.unreadable',
    `${name} could not be read as text`,
    'It looks like a binary file. Attach a text copy, or add it to a notebook as a source.',
    422,
  );
export const goneOrOther = () =>
  fail(
    'attachment.not_found',
    'An attached file is no longer here',
    'Files wait an hour for their message, and Core forgets them when it restarts. Attach the file again.',
    404,
  );
export const tooMany = () =>
  fail(
    'attachment.too_many',
    `Up to ${ATTACHMENT_LIMITS.perTurn} files go with one message`,
    'Send this message, then attach the rest to the next.',
    422,
  );
export const claudeCodeFiles = () =>
  fail(
    'attachment.claude_code',
    'Claude Code reads files from its folder',
    'Put the file in the session folder and name its path in your message.',
    422,
  );

interface Held {
  record: AttachmentRecord;
  threadId: string;
  text: string;
  expires: number;
}

/** At most this many files wait at once; the oldest go first. */
const MAX_HELD = 200;

export interface IncomingFile {
  name: string;
  mime: string;
  bytes: Buffer;
}

export class AttachmentService {
  private readonly held = new Map<string, Held>();
  constructor(
    private readonly deps: {
      knowledge: Pick<KnowledgeClient, 'stream'>;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private sweep() {
    const t = this.now();
    for (const [id, h] of this.held) if (h.expires <= t) this.held.delete(id);
    while (this.held.size > MAX_HELD) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
  }

  async add(threadId: string, file: IncomingFile): Promise<AttachmentRecord> {
    const name =
      file.name
        .replace(/[\\/]+/g, '/')
        .split('/')
        .pop()
        ?.trim() || 'File';
    if (file.bytes.length > ATTACHMENT_LIMITS.bytes) throw tooLarge(name);
    const kind = attachableKind(name, file.mime);
    if (!kind) throw notReadable(name);
    if (file.bytes.length === 0)
      throw fail('attachment.empty', `${name} is empty`, 'Choose the file again.', 422);

    let text: string;
    let pages: number | null = null;
    if (kind === 'pdf') {
      const form = new FormData();
      form.set('file', new File([new Uint8Array(file.bytes)], name, { type: 'application/pdf' }));
      const res = await this.deps.knowledge.stream('POST', '/attachments/extract', { body: form });
      const out = (await res.json()) as { markdown?: string; pages?: number };
      text = (out.markdown ?? '').replace(/\r\n/g, '\n');
      pages = out.pages && out.pages > 0 ? out.pages : null;
    } else {
      // A text file with NUL bytes or a high share of replacement characters is a binary one.
      if (file.bytes.subarray(0, 8_192).includes(0)) throw unreadable(name);
      text = new TextDecoder('utf-8').decode(file.bytes).replace(/^﻿/, '').replace(/\r\n/g, '\n');
      const bad = (text.slice(0, 8_192).match(/�/g) ?? []).length;
      if (bad > 8) throw unreadable(name);
    }
    if (!text.trim()) throw unreadable(name);
    const truncated = text.length > ATTACHMENT_LIMITS.chars;
    if (truncated) text = text.slice(0, ATTACHMENT_LIMITS.chars);

    this.sweep();
    const record: AttachmentRecord = {
      id: `att_${ulid()}`,
      name,
      mime: kind === 'pdf' ? 'application/pdf' : file.mime || 'text/plain',
      kind,
      bytes: file.bytes.length,
      pages,
      chars: text.length,
      truncated,
    };
    this.held.set(record.id, { record, threadId, text, expires: this.now() + ATTACHMENT_LIMITS.keepMs });
    log.info({ kind, bytes: record.bytes, pages, truncated }, 'a file was attached to a message');
    return record;
  }

  /** The file parts for these ids, in order. Throws attachment.not_found for one that is gone or another thread's. */
  partsFor(threadId: string, ids: string[]): FilePart[] {
    if (ids.length > ATTACHMENT_LIMITS.perTurn) throw tooMany();
    this.sweep();
    return ids.map((id) => {
      const h = this.held.get(id);
      if (!h || h.threadId !== threadId) throw goneOrOther();
      return {
        type: 'file' as const,
        name: h.record.name,
        mime: h.record.mime,
        url: '',
        text: h.text,
        ...(h.record.pages && { pages: h.record.pages }),
        ...(h.record.truncated && { truncated: true }),
      };
    });
  }

  /** A sent message no longer needs the waiting copy: its text is on the message. */
  release(ids: string[]): void {
    for (const id of ids) this.held.delete(id);
  }

  discard(threadId: string, id: string): boolean {
    const h = this.held.get(id);
    if (!h || h.threadId !== threadId) return false;
    return this.held.delete(id);
  }
}
