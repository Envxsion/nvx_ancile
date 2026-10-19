/**
 * SU1: bring chats in from ChatGPT, Claude and Open WebUI. Each export is
 * read as the tool writes it (branches followed to the last message, hidden
 * context left out), an import runs with progress, never brings the same
 * conversation in twice, carries on after a restart, and says plainly when
 * the file is not a chat export.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { ChatImport } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { conversationsOf, detectOrigin, readChat } from '../../src/chatimport/parse';
import { chatImportRoutes } from '../../src/chatimport/routes';
import { ChatImportService } from '../../src/chatimport/service';
import { MemoryChatImportStore } from '../../src/chatimport/store';
import { isZip, zipEntry } from '../../src/chatimport/zip';
import { errorHandler } from '../../src/obs/errors';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_test';

/* ---- the three exports, as the tools write them ---------------------------------- */

const chatgpt = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  conversation_id: id,
  title,
  create_time: 1_760_000_000,
  update_time: 1_760_000_900,
  current_node: 'a2',
  mapping: {
    root: { id: 'root', parent: null, children: ['sys'], message: null },
    sys: {
      id: 'sys',
      parent: 'root',
      children: ['u1'],
      message: {
        author: { role: 'system' },
        create_time: 1_760_000_001,
        content: { content_type: 'text', parts: ['You are ChatGPT'] },
        metadata: { is_visually_hidden_from_conversation: true },
      },
    },
    u1: {
      id: 'u1',
      parent: 'sys',
      children: ['a1', 'a2'],
      message: {
        author: { role: 'user' },
        create_time: 1_760_000_010,
        content: { content_type: 'text', parts: ['What is a tide table?'] },
      },
    },
    a1: {
      id: 'a1',
      parent: 'u1',
      children: [],
      message: {
        author: { role: 'assistant' },
        create_time: 1_760_000_020,
        content: { content_type: 'text', parts: ['An older answer that was regenerated.'] },
        metadata: { model_slug: 'gpt-4o' },
      },
    },
    a2: {
      id: 'a2',
      parent: 'u1',
      children: [],
      message: {
        author: { role: 'assistant' },
        create_time: 1_760_000_030,
        content: { content_type: 'text', parts: ['A tide table lists high and low water.'] },
        metadata: { model_slug: 'gpt-4o' },
      },
    },
  },
  ...over,
});

const claude = (uuid: string, name: string) => ({
  uuid,
  name,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-01T10:05:00.000Z',
  chat_messages: [
    {
      uuid: `${uuid}-1`,
      sender: 'human',
      created_at: '2026-09-01T10:00:00.000Z',
      text: 'Summarise this',
      content: [{ type: 'text', text: 'Summarise this' }],
      attachments: [{ file_name: 'a.pdf' }],
    },
    {
      uuid: `${uuid}-2`,
      sender: 'assistant',
      created_at: '2026-09-01T10:00:30.000Z',
      text: '',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Here is a summary.' },
      ],
    },
  ],
});

const webui = (id: string, title: string) => ({
  id,
  title,
  created_at: 1_760_100_000,
  updated_at: 1_760_100_500,
  chat: {
    id,
    title,
    history: {
      currentId: 'm2',
      messages: {
        m1: {
          id: 'm1',
          parentId: null,
          childrenIds: ['m2'],
          role: 'user',
          content: 'Hello',
          timestamp: 1_760_100_001,
        },
        m2: {
          id: 'm2',
          parentId: 'm1',
          childrenIds: [],
          role: 'assistant',
          content: 'Hi there',
          model: 'llama3.2:3b',
          timestamp: 1_760_100_002,
        },
      },
    },
  },
});

const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));

/** A one-entry zip, deflated, as the tools send their exports. */
function zipOf(name: string, data: Buffer): Buffer {
  const comp = deflateRawSync(data);
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nm.length, 28);
  central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nm, comp]);
  const cd = Buffer.concat([central, nm]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}

/* ---- parsing ------------------------------------------------------------------------ */

describe('reading each export', () => {
  it('ChatGPT: follows the branch the person ended on, and leaves hidden context out', () => {
    const list = conversationsOf([chatgpt('c1', 'Tides')]) ?? [];
    expect(detectOrigin(list)).toBe('chatgpt');
    const c = readChat('chatgpt', list[0]);
    expect(c?.title).toBe('Tides');
    expect(c?.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What is a tide table?'],
      ['assistant', 'A tide table lists high and low water.'],
    ]);
    expect(c?.messages[1]?.model).toBe('gpt-4o');
    expect(c?.messages[0]?.at).toBe('2025-10-09T08:53:30.000Z');
    expect(c?.branches_left).toBe(1);
  });

  it('Claude: human and assistant text, thinking left out, attachments noted in words', () => {
    const list = conversationsOf([claude('k1', 'Summary')]) ?? [];
    expect(detectOrigin(list)).toBe('claude');
    const c = readChat('claude', list[0]);
    expect(c?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(c?.messages[0]?.text).toContain('Summarise this');
    expect(c?.messages[0]?.text).toContain('1 attached file was not brought in');
    expect(c?.messages[1]?.text).toBe('Here is a summary.');
  });

  it('Open WebUI: follows history from the current message, in an export or a wrapped list', () => {
    expect(detectOrigin(conversationsOf({ chats: [webui('w1', 'Chat')] }) ?? [])).toBe('openwebui');
    const c = readChat('openwebui', webui('w1', 'Hello chat'));
    expect(c?.messages.map((m) => m.text)).toEqual(['Hello', 'Hi there']);
    expect(c?.messages[1]?.model).toBe('llama3.2:3b');
  });

  it('a conversation with nothing to keep reads as empty, and junk reads as nothing', () => {
    const c = readChat('claude', { uuid: 'x', name: 'Blank', chat_messages: [] });
    expect(c?.messages).toEqual([]);
    expect(readChat('chatgpt', 'nope')).toBeNull();
    expect(readChat('claude', { name: 'no id' })).toBeNull();
    expect(detectOrigin([{ something: 'else' }])).toBeNull();
    expect(conversationsOf({ not: 'a list' })).toBeNull();
  });

  it('opens conversations.json out of a zip', () => {
    const z = zipOf('export/conversations.json', bytes([claude('k1', 'T')]));
    expect(isZip(z)).toBe(true);
    const entry = zipEntry(z, (p) => p.endsWith('conversations.json'), 1_000_000);
    expect(JSON.parse(entry?.toString('utf8') ?? '[]')).toHaveLength(1);
    expect(zipEntry(z, (p) => p.endsWith('other.json'), 1_000_000)).toBeNull();
    expect(() => zipEntry(z, () => true, 10)).toThrow(/too large/);
  });
});

/* ---- the service -------------------------------------------------------------------- */

let dir: string;
let threads: MemoryThreadRepo;
let store: MemoryChatImportStore;
let svc: ChatImportService;

const make = () =>
  new ChatImportService({ store, threads, workspaceId: WS, dir, breathe: async () => undefined });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-import-test-'));
  threads = new MemoryThreadRepo();
  store = new MemoryChatImportStore();
  svc = make();
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const titles = async () => (await threads.listThreads(WS)).map((t) => t.title).sort();

describe('an import', () => {
  it('brings each conversation in as a thread with its messages in order, and counts them', async () => {
    const job = await svc.start({
      file: bytes([chatgpt('c1', 'Tides'), chatgpt('c2', 'Moon'), { id: 'c3', mapping: {}, title: 'Empty' }]),
      fileName: 'conversations.json',
    });
    expect(job).toMatchObject({ origin: 'chatgpt', total: 3, status: 'queued' });
    await svc.settled();
    const done = await svc.get(job.id);
    expect(done).toMatchObject({
      status: 'done',
      done: 3,
      imported: 2,
      duplicates: 0,
      empty: 1,
      messages: 4,
    });
    expect(await titles()).toEqual(['Moon', 'Tides']);
    const t = (await threads.listThreads(WS)).find((x) => x.title === 'Tides');
    const msgs = await threads.messages(t?.id ?? '');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]?.parent_id).toBe(msgs[0]?.id);
    expect(msgs[1]?.parts).toEqual([{ type: 'text', text: 'A tide table lists high and low water.' }]);
    // The thread opens on the last message and sits where the conversation last moved.
    const rec = await threads.getThread(t?.id ?? '');
    expect(rec?.active_head_id).toBe(msgs[1]?.id);
    expect(rec?.root_message_id).toBe(msgs[0]?.id);
    expect(rec?.updated_at).toBe('2025-10-09T09:08:20.000Z');
    // The kept copy of the file goes once the job has finished.
    expect(await readdir(dir)).toEqual([]);
  });

  it('never brings a conversation in twice: not in the same file, not in a later export', async () => {
    const first = await svc.start({
      file: bytes([claude('k1', 'One'), claude('k1', 'One again')]),
      fileName: null,
    });
    await svc.settled();
    expect(await svc.get(first.id)).toMatchObject({ imported: 1, duplicates: 1 });
    const second = await svc.start({
      file: bytes([claude('k1', 'One'), claude('k2', 'Two')]),
      fileName: null,
    });
    await svc.settled();
    expect(await svc.get(second.id)).toMatchObject({ imported: 1, duplicates: 1 });
    expect(await titles()).toEqual(['One', 'Two']);
  });

  it('puts the threads in a notebook when asked', async () => {
    const job = await svc.start({ file: bytes([webui('w1', 'Hello')]), fileName: null, notebookId: 'nb_1' });
    await svc.settled();
    expect((await svc.get(job.id)).notebook_id).toBe('nb_1');
    expect((await threads.listThreads(WS))[0]?.notebook_id).toBe('nb_1');
  });

  it('carries on after a restart from the conversation it reached, without doubling any', async () => {
    const file = bytes([claude('k1', 'One'), claude('k2', 'Two'), claude('k3', 'Three')]);
    let breaths = 0;
    // The first Core stops after one conversation.
    const first = new ChatImportService({
      store,
      threads,
      workspaceId: WS,
      dir,
      breathe: async () => {
        if (++breaths === 1) first.stop();
      },
    });
    const job = await first.start({ file, fileName: null });
    await first.settled();
    const mid = await first.get(job.id);
    expect(mid.status).toBe('running');
    expect(mid.done).toBe(1);
    // A conversation written just before the crash, whose progress was never saved, is recognised.
    await store.update(job.id, { done: 0, imported: 0, messages: 0 });
    const next = make();
    expect(await next.resume()).toBe(1);
    await next.settled();
    expect(await next.get(job.id)).toMatchObject({ status: 'done', done: 3, imported: 3, duplicates: 0 });
    expect(await titles()).toEqual(['One', 'Three', 'Two']);
  });

  it('can be stopped, keeping what came in', async () => {
    let n = 0;
    const s = new ChatImportService({
      store,
      threads,
      workspaceId: WS,
      dir,
      breathe: async () => {
        if (++n === 1) await s.cancel(job.id);
      },
    });
    const job = await s.start({
      file: bytes([claude('a', 'A'), claude('b', 'B'), claude('c', 'C')]),
      fileName: null,
    });
    await s.settled();
    expect(await s.get(job.id)).toMatchObject({ status: 'cancelled', done: 1, imported: 1 });
  });
});

describe('a file that is not a chat export', () => {
  const code = async (file: Buffer) =>
    svc.start({ file, fileName: null }).catch((e: { code: string }) => e.code);

  it('says what it was, in a code the interface words', async () => {
    expect(await code(Buffer.from('not json at all'))).toBe('import.unreadable');
    expect(await code(bytes({ hello: 'world' }))).toBe('import.unknown_format');
    expect(await code(bytes([{ a: 1 }]))).toBe('import.unknown_format');
    expect(await code(bytes([]))).toBe('import.empty');
    expect(await code(zipOf('notes.txt', Buffer.from('x')))).toBe('import.zip_no_chats');
  });
});

describe('routes', () => {
  const app = () => {
    const a = new Hono<AppEnv>();
    a.route('/', chatImportRoutes({ imports: svc, notebookExists: async (id) => id === 'nb_1' }));
    a.onError(errorHandler);
    return a;
  };
  const upload = (data: Buffer, name = 'conversations.json', extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(data)], name));
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return app().request('/imports/chats', { method: 'POST', body: form });
  };

  it('takes a file, answers 202 with the job, and follows it to the end', async () => {
    const res = await upload(zipOf('conversations.json', bytes([claude('k1', 'One')])), 'data.zip');
    expect(res.status).toBe(202);
    const job = (await res.json()) as ChatImport;
    expect(job).toMatchObject({ origin: 'claude', file_name: 'data.zip', total: 1 });
    await svc.settled();
    const got = (await (await app().request(`/imports/chats/${job.id}`)).json()) as ChatImport;
    expect(got.status).toBe('done');
    const list = (await (await app().request('/imports/chats')).json()) as { items: ChatImport[] };
    expect(list.items.map((i) => i.id)).toEqual([job.id]);
  });

  it('refuses a missing file, an unknown notebook and an unknown import in plain words', async () => {
    const none = await app().request('/imports/chats', { method: 'POST', body: new FormData() });
    expect(none.status).toBe(400);
    expect((await upload(bytes([claude('k', 'T')]), 'c.json', { notebook_id: 'nb_9' })).status).toBe(404);
    const missing = await app().request('/imports/chats/cim_nope');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('import.not_found');
    const bad = await upload(Buffer.from('nope'));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { hint: string } }).error.hint).toContain('conversations.json');
  });
});
