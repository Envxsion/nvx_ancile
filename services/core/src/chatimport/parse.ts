/**
 * ------------------------------------------------------------------
 *  Title    |  Chat export parsers
 *  Ref      |  ROADMAP SU1 · packages/contracts/src/chatimport.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read the conversations out of a ChatGPT, Claude or
 *           |  Open WebUI export and turn each into a plain list of
 *           |  messages (who said it, what, when), so they can become
 *           |  threads.
 *  How      |  Pure functions over parsed JSON. detectOrigin() looks
 *           |  at the first conversations for each tool's own shape;
 *           |  conversationsOf() lists the raw conversations;
 *           |  readChat() turns one into an ImportedChat or null when
 *           |  it holds nothing to keep. A tool that stores a tree
 *           |  (ChatGPT's mapping, Open WebUI's history) is followed
 *           |  from its current message back to the start: the
 *           |  branch the person was last on is kept, and the number
 *           |  of other branches left behind is counted.
 *  Note     |  Written from each tool's exported files, as people
 *           |  receive them. Only user and assistant text is kept:
 *           |  system prompts, tool output, hidden context and images
 *           |  are left out, and an image or file the person attached
 *           |  is noted in words rather than carried.
 * ------------------------------------------------------------------
 */

import type { ChatImportOrigin } from '@nvx/contracts';

export interface ImportedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** ISO time, when the export gives one. */
  at: string | null;
  /** The model's own name for itself in the export ("gpt-4o"), for assistant messages. */
  model: string | null;
}

export interface ImportedChat {
  /** The tool's own id for the conversation: what makes a second import recognise it. */
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  messages: ImportedMessage[];
  /** Branches of the conversation that were not kept. */
  branches_left: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Seconds (ChatGPT, Open WebUI) or an ISO string (Claude) as ISO, or null. */
function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // Seconds since 1970 in these exports; a value past year 3000 in seconds is milliseconds.
    const ms = v > 32_503_680_000 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

const clean = (s: string) => s.replaceAll(String.fromCharCode(0), '').replace(/\r\n?/g, '\n').trim();

/* ---- Which tool wrote it --------------------------------------------------------- */

/** The conversations in a parsed export, or null when it is not a list of them. */
export function conversationsOf(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  // Some Open WebUI versions wrap the list.
  const o = obj(json);
  if (o && Array.isArray(o.chats)) return o.chats as unknown[];
  return null;
}

export function detectOrigin(list: unknown[]): ChatImportOrigin | null {
  for (const raw of list.slice(0, 20)) {
    const c = obj(raw);
    if (!c) continue;
    if (obj(c.mapping)) return 'chatgpt';
    if (Array.isArray(c.chat_messages)) return 'claude';
    if (obj(c.chat)) return 'openwebui';
    if (obj(c.history) || Array.isArray(c.messages)) return 'openwebui';
  }
  return null;
}

/* ---- ChatGPT ------------------------------------------------------------------------ */

function chatgptText(content: Json | null): string {
  if (!content) return '';
  const type = str(content.content_type);
  // Text, and the prompts of code runs and browsing, are words a person can read; the rest is not.
  if (type && !['text', 'multimodal_text'].includes(type)) return '';
  const parts = arr(content.parts);
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p === 'string') out.push(p);
    else {
      const o = obj(p);
      if (o && str(o.content_type)?.includes('image')) out.push('[An image was attached here.]');
      else if (o && typeof o.text === 'string') out.push(o.text);
    }
  }
  return clean(out.join('\n'));
}

function readChatgpt(c: Json): ImportedChat | null {
  const mapping = obj(c.mapping);
  const id = str(c.conversation_id) ?? str(c.id);
  if (!mapping || !id) return null;
  // From the message the person was last on, back to the start.
  let cur: string | null = str(c.current_node);
  if (!cur || !mapping[cur]) {
    // No current node recorded: the latest-created leaf.
    let best: { id: string; t: number } | null = null;
    for (const [nid, n] of Object.entries(mapping)) {
      const node = obj(n);
      if (!node || arr(node.children).length) continue;
      const t = Number(obj(node.message)?.create_time ?? 0);
      if (!best || t >= best.t) best = { id: nid, t };
    }
    cur = best?.id ?? null;
  }
  const path: Json[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = obj(mapping[cur]);
    if (!node) break;
    path.push(node);
    cur = str(node.parent);
  }
  path.reverse();
  const messages: ImportedMessage[] = [];
  for (const node of path) {
    const m = obj(node.message);
    if (!m) continue;
    const role = str(obj(m.author)?.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const meta = obj(m.metadata);
    // ChatGPT keeps its own hidden context and memory notes as user turns.
    if (meta?.is_visually_hidden_from_conversation === true) continue;
    const text = chatgptText(obj(m.content));
    if (!text) continue;
    messages.push({
      role,
      text,
      at: iso(m.create_time),
      model: role === 'assistant' ? str(meta?.model_slug) : null,
    });
  }
  const branchPoints = Object.values(mapping).filter((n) => arr(obj(n)?.children).length > 1).length;
  return {
    id,
    title: clean(str(c.title) ?? '') || 'Imported chat',
    created_at: iso(c.create_time),
    updated_at: iso(c.update_time),
    messages,
    branches_left: branchPoints,
  };
}

/* ---- Claude -------------------------------------------------------------------------- */

function claudeText(m: Json): string {
  const content = arr(m.content);
  const out: string[] = [];
  for (const b of content) {
    const o = obj(b);
    if (o && o.type === 'text' && typeof o.text === 'string') out.push(o.text);
  }
  const joined = clean(out.join('\n\n'));
  if (joined) return joined;
  return clean(str(m.text) ?? '');
}

function readClaude(c: Json): ImportedChat | null {
  const id = str(c.uuid) ?? str(c.id);
  if (!id) return null;
  const messages: ImportedMessage[] = [];
  for (const raw of arr(c.chat_messages)) {
    const m = obj(raw);
    if (!m) continue;
    const sender = str(m.sender);
    const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const text = claudeText(m);
    const files = arr(m.attachments).length + arr(m.files).length;
    const body = text || (files ? '[A file was attached here.]' : '');
    if (!body) continue;
    messages.push({
      role,
      text:
        text && files
          ? `${text}\n\n[${files} attached ${files === 1 ? 'file was' : 'files were'} not brought in.]`
          : body,
      at: iso(m.created_at),
      model: null,
    });
  }
  return {
    id,
    title: clean(str(c.name) ?? '') || 'Imported chat',
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
    messages,
    branches_left: 0,
  };
}

/* ---- Open WebUI ---------------------------------------------------------------------- */

function webuiText(m: Json): string {
  const content = m.content;
  if (typeof content === 'string') return clean(content);
  // Newer versions keep a list of typed parts.
  return clean(
    arr(content)
      .map((p) => {
        const o = obj(p);
        return o && typeof o.text === 'string' ? o.text : '';
      })
      .join('\n'),
  );
}

function readWebui(c: Json): ImportedChat | null {
  // Exports nest the chat under "chat"; some older ones are the chat itself.
  const chat = obj(c.chat) ?? c;
  const id = str(c.id) ?? str(chat.id);
  if (!id) return null;
  const list: Json[] = [];
  let branches = 0;
  const history = obj(chat.history);
  const byId = obj(history?.messages);
  if (byId) {
    let cur: string | null = str(history?.currentId);
    if (!cur || !byId[cur]) {
      // The newest message with nothing after it.
      const leaves = Object.values(byId)
        .map(obj)
        .filter((m): m is Json => !!m && !arr(m.childrenIds).length);
      leaves.sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
      cur = str(leaves[0]?.id);
    }
    const seen = new Set<string>();
    const path: Json[] = [];
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const m = obj(byId[cur]);
      if (!m) break;
      path.push(m);
      cur = str(m.parentId);
    }
    list.push(...path.reverse());
    branches = Object.values(byId).filter((m) => arr(obj(m)?.childrenIds).length > 1).length;
  } else {
    for (const m of arr(chat.messages)) {
      const o = obj(m);
      if (o) list.push(o);
    }
  }
  const messages: ImportedMessage[] = [];
  for (const m of list) {
    const role = str(m.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const text = webuiText(m);
    if (!text) continue;
    messages.push({ role, text, at: iso(m.timestamp), model: role === 'assistant' ? str(m.model) : null });
  }
  return {
    id,
    title: clean(str(c.title) ?? str(chat.title) ?? '') || 'Imported chat',
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
    messages,
    branches_left: branches,
  };
}

/** One raw conversation as an ImportedChat, or null when it cannot be read as one. */
export function readChat(origin: ChatImportOrigin, raw: unknown): ImportedChat | null {
  const c = obj(raw);
  if (!c) return null;
  try {
    if (origin === 'chatgpt') return readChatgpt(c);
    if (origin === 'claude') return readClaude(c);
    return readWebui(c);
  } catch {
    return null;
  }
}
