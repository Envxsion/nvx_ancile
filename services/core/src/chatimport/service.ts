/**
 * ------------------------------------------------------------------
 *  Title    |  Chat imports
 *  Ref      |  ROADMAP SU1 · packages/contracts/src/chatimport.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Bring conversations from ChatGPT, Claude or Open WebUI
 *           |  in as threads: the file in, progress while it runs, no
 *           |  conversation twice, and a job that carries on after
 *           |  NVX Ancile restarts.
 *  How      |  start() reads the file (a conversations.json, or a zip
 *           |  holding one), checks it is a chat export, keeps the
 *           |  conversations in <data>/imports/<id>.json and records a
 *           |  job. run() goes through them one at a time: empty ones
 *           |  are counted, ones already brought in (by the tool's own
 *           |  id) are left alone, the rest become a thread with its
 *           |  messages in order, at their own times. Progress is saved
 *           |  every few conversations and the event loop is given back
 *           |  between them, so the app stays usable.
 *  Note     |  A restart picks unfinished jobs up at the conversation
 *           |  they reached (resume()); one the crash interrupted is
 *           |  recognised by its item row, not brought in twice.
 *           |  Imported text is data: it never runs anything and never
 *           |  writes memory. Images and files are noted in words.
 * ------------------------------------------------------------------
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AncileError, CHAT_IMPORT_MAX_MB, type ChatImport, type ChatImportOrigin } from '@nvx/contracts';
import { ulid } from 'ulid';
import { logFor } from '../obs/logger';
import type { NewMessage, ThreadRepo } from '../threads/repo';
import { conversationsOf, detectOrigin, type ImportedChat, readChat } from './parse';
import type { ChatImportRecord, ChatImportStore } from './store';
import { isZip, ZipError, zipEntry } from './zip';

const log = logFor('chat-import');

export const MAX_BYTES = CHAT_IMPORT_MAX_MB * 1024 * 1024;
/** Progress is saved after this many conversations, or this long, whichever comes first. */
const SAVE_EVERY = 5;
const SAVE_EVERY_MS = 400;
const CHUNK = 200;

const tooLarge = () =>
  new AncileError({
    code: 'import.too_large',
    title: 'That file is too large to import',
    hint: `Imports hold up to ${CHAT_IMPORT_MAX_MB} MB. Open the export's zip and bring in conversations.json on its own, or export fewer conversations.`,
    status: 413,
    errorClass: 'permanent',
  });

const unreadable = (detail?: string) =>
  new AncileError({
    code: 'import.unreadable',
    title: 'That file is not a chat export',
    hint: 'Pick conversations.json from your ChatGPT or Claude export (or the .zip it came in), or the chats file Open WebUI exports.',
    status: 422,
    errorClass: 'permanent',
    ...(detail && { detail: detail.slice(0, 200) }),
  });

const unknownFormat = () =>
  new AncileError({
    code: 'import.unknown_format',
    title: 'NVX Ancile does not recognise those chats',
    hint: 'It reads exports from ChatGPT, Claude and Open WebUI. Check you picked the conversations file, not another file from the export.',
    status: 422,
    errorClass: 'permanent',
  });

const emptyFile = () =>
  new AncileError({
    code: 'import.empty',
    title: 'That file has no conversations',
    hint: 'The export was empty. Export again from the tool, then pick the new file.',
    status: 422,
    errorClass: 'permanent',
  });

export const importNotFound = () =>
  new AncileError({
    code: 'import.not_found',
    title: 'That import does not exist',
    hint: 'It may be from before NVX Ancile was reset. Start a new import.',
    status: 404,
    errorClass: 'permanent',
  });

export interface ChatImportDeps {
  store: ChatImportStore;
  threads: Pick<ThreadRepo, 'createThread' | 'insertMessages' | 'patchThread' | 'setFields'>;
  workspaceId: string;
  /** Where the conversations of a running job are kept (<data>/imports). */
  dir: string;
  now?: () => number;
  /** Give the event loop back between conversations (tests pass a no-op). */
  breathe?: () => Promise<void>;
}

const publicOf = ({ workspace_id: _w, file_path: _f, ...rest }: ChatImportRecord): ChatImport => rest;

export class ChatImportService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private readonly now: () => number;
  private readonly breathe: () => Promise<void>;

  constructor(private readonly deps: ChatImportDeps) {
    this.now = deps.now ?? Date.now;
    this.breathe = deps.breathe ?? (() => new Promise((r) => setImmediate(r)));
  }

  /** Read, check and keep the file, record the job, and start it. Answers at once. */
  async start(input: {
    file: Buffer;
    fileName: string | null;
    notebookId?: string | null;
  }): Promise<ChatImport> {
    const { file } = input;
    if (file.length > MAX_BYTES) throw tooLarge();
    let raw: Buffer = file;
    if (isZip(file)) {
      try {
        const entry =
          zipEntry(file, (p) => /(^|\/)conversations\.json$/i.test(p), MAX_BYTES) ??
          zipEntry(file, (p) => /(^|\/)[^/]*chats?[^/]*\.json$/i.test(p), MAX_BYTES);
        if (!entry)
          throw new AncileError({
            code: 'import.zip_no_chats',
            title: 'That zip has no conversations in it',
            hint: 'Open the export and pick the zip it came in, or conversations.json from inside it.',
            status: 422,
            errorClass: 'permanent',
          });
        raw = entry;
      } catch (err) {
        if (err instanceof AncileError) throw err;
        if (err instanceof ZipError && err.kind === 'too_large') throw tooLarge();
        throw unreadable(err instanceof Error ? err.message : undefined);
      }
    }
    let list: unknown[] | null;
    try {
      list = conversationsOf(JSON.parse(raw.toString('utf8').replace(/^﻿/, '')));
    } catch (err) {
      throw unreadable(err instanceof Error ? err.message : undefined);
    }
    if (!list) throw unknownFormat();
    if (list.length === 0) throw emptyFile();
    const origin = detectOrigin(list);
    if (!origin) throw unknownFormat();

    const id = `cim_${ulid()}`;
    await mkdir(this.deps.dir, { recursive: true });
    const filePath = join(this.deps.dir, `${id}.json`);
    await writeFile(filePath, raw);
    const rec: ChatImportRecord = {
      id,
      workspace_id: this.deps.workspaceId,
      origin,
      file_name: input.fileName,
      file_path: filePath,
      status: 'queued',
      total: list.length,
      done: 0,
      imported: 0,
      duplicates: 0,
      empty: 0,
      messages: 0,
      notebook_id: input.notebookId ?? null,
      error: null,
      started_at: new Date(this.now()).toISOString(),
      finished_at: null,
    };
    await this.deps.store.create(rec);
    log.info({ import_id: id, origin, conversations: list.length }, 'chat import started');
    this.launch(id);
    return publicOf(rec);
  }

  private launch(id: string): void {
    if (this.running.has(id)) return;
    const p = this.run(id)
      .catch((err: unknown) => log.error({ err, import_id: id }, 'chat import crashed'))
      .finally(() => this.running.delete(id));
    this.running.set(id, p);
  }

  /** After a restart: jobs that were queued or running carry on. */
  async resume(): Promise<number> {
    const jobs = await this.deps.store.unfinished();
    for (const j of jobs) this.launch(j.id);
    return jobs.length;
  }

  async get(id: string): Promise<ChatImport> {
    const r = await this.deps.store.get(id);
    if (!r || r.workspace_id !== this.deps.workspaceId) throw importNotFound();
    return publicOf(r);
  }

  async list(limit = 20): Promise<ChatImport[]> {
    return (await this.deps.store.list(this.deps.workspaceId, limit)).map(publicOf);
  }

  /** Stop after the conversation in hand. What came in stays; starting the file again skips it. */
  async cancel(id: string): Promise<ChatImport> {
    const r = await this.get(id);
    if (r.status === 'queued' || r.status === 'running') this.cancelled.add(id);
    return r;
  }

  /** Resolves when every job started so far has ended (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  stop(): void {
    for (const id of this.running.keys()) this.cancelled.add(`stop:${id}`);
  }

  private async run(id: string): Promise<void> {
    const { store } = this.deps;
    const rec = await store.get(id);
    if (!rec || rec.status === 'done' || rec.status === 'failed' || rec.status === 'cancelled') return;
    await store.update(id, { status: 'running' });
    let list: unknown[];
    try {
      list = conversationsOf(JSON.parse((await readFile(rec.file_path, 'utf8')).replace(/^﻿/, ''))) ?? [];
    } catch (err) {
      await this.fail(id, err, 'The file kept for this import could not be read');
      return;
    }
    const origin: ChatImportOrigin = rec.origin;
    let { done, imported, duplicates, empty, messages } = rec;
    let sinceSave = 0;
    // Conversations met in this pass: the same id twice in one file is a duplicate, not a recovery.
    const met = new Set<string>();
    let lastSave = this.now();
    const save = async () => {
      await store.update(id, { done, imported, duplicates, empty, messages });
      sinceSave = 0;
      lastSave = this.now();
    };
    try {
      for (let i = done; i < list.length; i++) {
        if (this.cancelled.has(id)) {
          this.cancelled.delete(id);
          await save();
          await store.update(id, { status: 'cancelled', finished_at: new Date(this.now()).toISOString() });
          await this.forget(rec);
          return;
        }
        if (this.cancelled.has(`stop:${id}`)) {
          // NVX Ancile is stopping: leave the job as it is, so the next start carries on.
          await save();
          return;
        }
        const chat = readChat(origin, list[i]);
        if (!chat || chat.messages.length === 0) empty++;
        else {
          const known = await store.itemFor(rec.workspace_id, origin, chat.id);
          const again = met.has(chat.id);
          met.add(chat.id);
          if (known && known.import_id === id && !again)
            imported++; // brought in just before a restart
          else if (known) duplicates++;
          else {
            messages += await this.bringIn(rec, chat);
            imported++;
          }
        }
        done = i + 1;
        sinceSave++;
        if (sinceSave >= SAVE_EVERY || this.now() - lastSave >= SAVE_EVERY_MS) await save();
        await this.breathe();
      }
      await save();
      await store.update(id, { status: 'done', finished_at: new Date(this.now()).toISOString() });
      log.info({ import_id: id, imported, duplicates, empty, messages }, 'chat import finished');
      await this.forget(rec);
    } catch (err) {
      await save().catch(() => undefined);
      await this.fail(id, err, 'The import stopped part way');
    }
  }

  private async forget(rec: ChatImportRecord) {
    await rm(rec.file_path, { force: true }).catch(() => undefined);
  }

  private async fail(id: string, err: unknown, title: string) {
    log.warn({ err, import_id: id }, 'chat import failed');
    await this.deps.store.update(id, {
      status: 'failed',
      finished_at: new Date(this.now()).toISOString(),
      error: {
        code: err instanceof AncileError ? err.code : 'import.failed',
        title,
        hint: 'Start the import again with the same file: conversations already brought in are skipped.',
      },
    });
  }

  /** One conversation as a thread; the number of messages written. */
  private async bringIn(rec: ChatImportRecord, chat: ImportedChat): Promise<number> {
    const { threads } = this.deps;
    const threadId = `thr_${ulid()}`;
    await threads.createThread({
      id: threadId,
      workspace_id: rec.workspace_id,
      title: chat.title.slice(0, 200),
      notebook_id: rec.notebook_id,
      settings: {},
    });
    const base = Date.parse(chat.created_at ?? '') || this.now() - chat.messages.length;
    let clock = base;
    let parent: string | null = null;
    let first: string | null = null;
    const rows: NewMessage[] = [];
    for (const m of chat.messages) {
      const id = `msg_${ulid()}`;
      first ??= id;
      // Times keep their order even when the export's do not.
      const at = Date.parse(m.at ?? '');
      clock = Number.isFinite(at) && at > clock ? at : clock + 1;
      rows.push({
        id,
        thread_id: threadId,
        parent_id: parent,
        role: m.role,
        parts: [{ type: 'text', text: m.text }],
        status: 'complete',
        trace_id: rec.id,
        created_at: new Date(clock).toISOString(),
        provenance: {
          imported: {
            origin: rec.origin,
            conversation_id: chat.id,
            import_id: rec.id,
            ...(m.model && { model: m.model }),
          },
        },
      });
      parent = id;
    }
    for (let i = 0; i < rows.length; i += CHUNK) await threads.insertMessages(rows.slice(i, i + CHUNK));
    await threads.patchThread(threadId, {
      root_message_id: first as string,
      active_head_id: parent as string,
    });
    // The rail orders by when a conversation last moved, so an old chat sits where it belongs.
    const last = chat.updated_at ?? new Date(clock).toISOString();
    await threads.setFields(rec.workspace_id, threadId, { updated_at: last });
    await this.deps.store.addItem(rec.workspace_id, rec.origin, chat.id, threadId, rec.id);
    return rows.length;
  }
}
