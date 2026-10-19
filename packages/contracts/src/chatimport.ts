/**
 * ------------------------------------------------------------------
 *  Title    |  Bringing in chats from other tools
 *  Ref      |  ROADMAP SU1 · docs/api.md (Chat imports)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes behind "Bring my chats" on first run: an
 *           |  export from ChatGPT, Claude or Open WebUI becomes
 *           |  threads, with progress, and without bringing the same
 *           |  conversation in twice.
 *  How      |  POST /imports/chats takes the file (the export's
 *           |  conversations.json, or the .zip that holds it) and
 *           |  answers a ChatImport at once; the work runs in the
 *           |  background. GET /imports/chats/:id follows it.
 *           |  A job that was running when NVX Ancile stopped carries
 *           |  on from the conversation it reached.
 *  Note     |  A conversation brought in once is recognised by the
 *           |  tool's own id and left alone the next time.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const ChatImportOrigin = z.enum(['chatgpt', 'claude', 'openwebui']);
export type ChatImportOrigin = z.infer<typeof ChatImportOrigin>;

export const CHAT_ORIGIN_LABEL: Record<ChatImportOrigin, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  openwebui: 'Open WebUI',
};

export const ChatImportStatus = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type ChatImportStatus = z.infer<typeof ChatImportStatus>;

export const ChatImport = z.object({
  id: z.string(),
  origin: ChatImportOrigin,
  file_name: z.string().nullable(),
  status: ChatImportStatus,
  /** Conversations in the file. */
  total: z.number().int().nonnegative(),
  /** Conversations looked at so far (brought in, already here, or empty). */
  done: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  /** Already brought in by an earlier import, so left alone. */
  duplicates: z.number().int().nonnegative(),
  /** Had no messages to keep. */
  empty: z.number().int().nonnegative(),
  /** Messages written across the new threads. */
  messages: z.number().int().nonnegative(),
  notebook_id: z.string().nullable(),
  error: z.object({ code: z.string(), title: z.string(), hint: z.string() }).nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});
export type ChatImport = z.infer<typeof ChatImport>;

export const ChatImportList = z.object({ items: z.array(ChatImport) });
export type ChatImportList = z.infer<typeof ChatImportList>;

/** The largest file in MB, as sent and once opened. A bigger export is better brought in as conversations.json out of its zip, or in parts. */
export const CHAT_IMPORT_MAX_MB = 300;
