/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code transcripts as Ancile messages
 *  Ref      |  docs/claude-code.md (How sessions look in a thread)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a Claude Code session's entries into Ancile message
 *           |  rows, and work out what a sync must add.
 *  How      |  Claude Code writes one entry per content block (text,
 *           |  thinking, each tool call, each tool result). Ancile keeps
 *           |  a turn in one message, with tool calls and their results
 *           |  side by side, so entries are grouped: a prompt is a user
 *           |  message; the assistant entries and tool results after it
 *           |  are one assistant message. What Claude Code itself wrote
 *           |  on the user side (markup.ts) is not shown as the person's
 *           |  words: a slash command is one user message of kind
 *           |  'command' (its printed output folded in), notifications
 *           |  and hand-backs are system messages of kind
 *           |  'notification', a compaction is a 'compact_boundary'
 *           |  divider followed by a 'compact_summary', and an
 *           |  interruption is a system message of kind 'interrupted'.
 *           |  Each message lists the entry uuids it holds in
 *           |  provenance.claude_code.uuids, which is how a sync knows
 *           |  what is already mirrored. An entry whose predecessor is
 *           |  mirrored hangs off that message, so rewinding in Claude
 *           |  Code becomes a branch in Ancile.
 *           |  What this version does not know (an entry of a new kind,
 *           |  or a content block it has no part for) is never dropped
 *           |  silently: the message that holds it says how many entries
 *           |  it cannot show yet (provenance.claude_code.unknown), a run
 *           |  of unknown entries between turns is one quiet 'unknown'
 *           |  system message, and each entry's raw text rides along in
 *           |  `raws` for the store (claude_code_unknown_entries).
 *  Note     |  Very large tool results are cut to RESULT_CAP characters
 *           |  with a note. Images up to IMAGE_CAP bytes are kept as
 *           |  data URLs; larger ones become a short text note.
 *           |  MAPPER_VERSION goes up whenever the result changes.
 * ------------------------------------------------------------------
 */

import type { Part, Usage } from '@nvx/contracts';
import type { CcSessionMessage } from './bridge-protocol';
import {
  type CcCommand,
  type CcNotification,
  classifyUser,
  commandLine,
  isInterruption,
  joinOutput,
  stripReminders,
  type UserClass,
} from './markup';

export const RESULT_CAP = 64 * 1024;
export const IMAGE_CAP = 512 * 1024;
const SUB_TEXT_CAP = 4 * 1024;
const SUB_TURNS_CAP = 300;

/**
 * Bumped whenever the mapping changes what a session looks like. A
 * thread mapped by an older version (and holding nothing written in
 * Ancile) is rebuilt on the next auto-import pass.
 * 1: first release. 2: Claude Code's own markup (commands,
 * notifications, compaction summary, interruptions, reminders) mapped
 * instead of shown as the person's prompts. 3: full history from the
 * transcript file (transcript.ts): every branch and everything before
 * each compaction, queued prompts included.
 * Entries and blocks this version does not know are kept and counted (an
 * 'unknown' marker) from 3 on without a rebuild: a rebuild would map the
 * live turns of a thread again and lose their citations, so what came in
 * before shows its unknown entries as new ones arrive.
 */
export const MAPPER_VERSION = 3;

export const INTERRUPTED_TEXT = 'Stopped by you';

/** The quiet marker for entries this version cannot show. */
export const unknownText = (n: number) =>
  `${n} ${n === 1 ? 'entry' : 'entries'} this version of NVX Ancile can't show yet`;

/** provenance.claude_code.kind; prompts and answers have none. */
export type CcKind =
  | 'command'
  | 'notification'
  | 'compact_boundary'
  | 'compact_summary'
  | 'interrupted'
  | 'unknown';

/** How many entries a message holds that this version cannot show, and their kinds (never content). */
export interface UnknownNote {
  count: number;
  types: string[];
}

/** One unknown entry's raw text, for the store. */
export interface UnknownRaw {
  uuid: string;
  type: string;
  raw: string;
}

type Block = Record<string, unknown>;

export type EntryClass =
  | { kind: 'assistant' }
  | { kind: 'tool_result'; interrupted: boolean }
  | { kind: 'skip' }
  | { kind: 'unknown'; type: string }
  | UserClass;

const isObj = (v: unknown): v is Block => !!v && typeof v === 'object' && !Array.isArray(v);

function contentOf(e: CcSessionMessage): string | Block[] | null {
  const m = e.message;
  if (!isObj(m)) return null;
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(isObj);
  return null;
}

/** A message whose content is there but in a shape this version does not read. */
const oddContent = (e: CcSessionMessage) =>
  isObj(e.message) && e.message.content !== undefined && e.message.content !== null && contentOf(e) === null;

const isToolResult = (b: Block) => b.type === 'tool_result' || String(b.type).endsWith('_tool_result');
const blockText = (b: Block) => (typeof b.text === 'string' ? b.text : '');

/** What one transcript entry is. */
export function classify(e: CcSessionMessage): EntryClass {
  const type = e.type as string;
  if (e.unknown) return { kind: 'unknown', type: e.unknown.type };
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return { kind: 'unknown', type };
  if (e.type === 'system') return { kind: 'skip' };
  if (e.type === 'assistant') return { kind: 'assistant' };
  const c = contentOf(e);
  if (e.isCompactSummary) {
    const text = typeof c === 'string' ? c : (c ?? []).map(blockText).join('');
    return { kind: 'compact', text: stripReminders(text).trim() };
  }
  if (c === null) return oddContent(e) ? { kind: 'unknown', type: 'user_content' } : { kind: 'skip' };
  if (Array.isArray(c)) {
    if (c.some(isToolResult))
      return {
        kind: 'tool_result',
        interrupted: c.some((b) => b.type === 'text' && isInterruption(blockText(b))),
      };
    // Only text blocks: read them as one string. Anything else (a pasted image) is a prompt.
    if (!c.every((b) => b.type === 'text'))
      return e.is_meta ? { kind: 'skip' } : { kind: 'prompt', text: '' };
    return classifyUser(c.map(blockText).join('\n'), e.origin, !!e.is_meta);
  }
  return classifyUser(c, e.origin, !!e.is_meta);
}

function cut(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n\n[${(text.length - cap).toLocaleString('en-GB')} more characters not brought in from Claude Code]`;
}

function imagePart(b: Block): Part {
  const src = isObj(b.source) ? b.source : {};
  const mime = typeof src.media_type === 'string' ? src.media_type : 'image/png';
  if (src.type === 'base64' && typeof src.data === 'string') {
    const bytes = Math.floor((src.data.length * 3) / 4);
    if (bytes <= IMAGE_CAP) return { type: 'image', url: `data:${mime};base64,${src.data}`, mime };
    return {
      type: 'text',
      text: `[An image (${mime}, ${Math.round(bytes / 1024)} KB) from Claude Code, too large to bring in]`,
    };
  }
  if (src.type === 'url' && typeof src.url === 'string') return { type: 'image', url: src.url, mime };
  return { type: 'text', text: '[An image from Claude Code]' };
}

/** A tool result's content as text (images inside it become a note). */
function resultText(content: unknown, cap: number): string {
  if (typeof content === 'string') return cut(content, cap);
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        if (!isObj(b)) return '';
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image') return '[image]';
        // A web search hit: its title and link (the encrypted page content is for the model only).
        if (b.type === 'web_search_result')
          return JSON.stringify({ title: b.title ?? null, url: b.url ?? null });
        return JSON.stringify(b);
      })
      .join('\n');
    return cut(text, cap);
  }
  if (content === undefined || content === null) return '';
  return cut(JSON.stringify(content), cap);
}

/**
 * One entry's content blocks as Ancile parts. On the user side,
 * <system-reminder> blocks and interruption notes are left out. A block
 * of a kind this version has no part for is named in `unknown`.
 */
export function partsOf(e: CcSessionMessage, cap = RESULT_CAP, unknown?: string[]): Part[] {
  const c = contentOf(e);
  if (c === null) {
    if (oddContent(e)) unknown?.push(`${e.type}_content`);
    return [];
  }
  const userSide = e.type === 'user';
  const clean = (t: string) => (userSide ? stripReminders(t) : t);
  if (typeof c === 'string') {
    const t = clean(c);
    return t.trim() ? [{ type: 'text', text: cut(t, cap * 4) }] : [];
  }
  const out: Part[] = [];
  for (const b of c) {
    const t = String(b.type);
    if (t === 'text' && typeof b.text === 'string') {
      const text = clean(b.text);
      if (userSide && isInterruption(text)) continue;
      if (text.trim()) out.push({ type: 'text', text: cut(text, cap * 4) });
    } else if (t === 'thinking' && typeof b.thinking === 'string') {
      out.push({
        type: 'reasoning',
        text: b.thinking,
        ...(typeof b.signature === 'string' && { provider_meta: { anthropic: { signature: b.signature } } }),
      });
    } else if (t === 'redacted_thinking') {
      out.push({
        type: 'reasoning',
        text: '',
        provider_meta: { anthropic: { redacted: typeof b.data === 'string' ? b.data : '' } },
      });
    } else if (
      (t === 'tool_use' || t === 'server_tool_use' || t === 'mcp_tool_use') &&
      typeof b.id === 'string'
    ) {
      out.push({ type: 'tool_call', call_id: b.id, tool: String(b.name ?? 'tool'), args: b.input ?? {} });
    } else if (isToolResult(b) && typeof b.tool_use_id === 'string') {
      out.push({
        type: 'tool_result',
        call_id: b.tool_use_id,
        ok: b.is_error !== true,
        result: resultText(b.content, cap),
      });
    } else if (t === 'image') {
      out.push(imagePart(b));
    } else if (t === 'document') {
      out.push({ type: 'text', text: '[A document attached in Claude Code]' });
    } else {
      unknown?.push(t);
    }
  }
  return out;
}

/** "claude-opus-5-5" → "claude-code/claude-opus-5-5"; synthetic entries have none. */
export function modelOf(e: CcSessionMessage): string | null {
  const m = e.message;
  if (!isObj(m) || typeof m.model !== 'string' || !m.model || m.model.startsWith('<')) return null;
  return `claude-code/${m.model}`;
}

/** The API message id (one API response spans several entries). */
export function apiIdOf(e: CcSessionMessage): string | null {
  const m = e.message;
  return isObj(m) && typeof m.id === 'string' ? m.id : null;
}

/**
 * Usage from an assistant entry. Input counts what was sent fresh plus
 * what was written to the cache; cached counts cache reads. Cost stays 0:
 * Claude Code bills the account it is signed into, and Ancile does not
 * invent prices. TODO(phase-4): show a list-price estimate, marked as such.
 */
export function usageOf(e: CcSessionMessage): Usage | null {
  const m = e.message;
  if (!isObj(m) || !isObj(m.usage)) return null;
  const u = m.usage;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    input_tokens: n(u.input_tokens) + n(u.cache_creation_input_tokens),
    output_tokens: n(u.output_tokens),
    cached_tokens: n(u.cache_read_input_tokens),
    cost_usd: 0,
  };
}

export function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

/**
 * Provenance kept on every mirrored message (provenance.claude_code).
 * A marker Ancile adds after an entry (the divider before a compaction
 * summary, "Stopped by you" after an interrupted tool call) holds the
 * entry's uuid with a "+" suffix, or none, so it is never written twice.
 */
export interface CcProvenance {
  session_id: string;
  /** The last entry this message holds. */
  uuid: string;
  uuids: string[];
  kind?: CcKind;
  /** kind 'command'. */
  command?: CcCommand;
  /** kind 'notification'. */
  notification?: CcNotification;
  /** The API message id of the last assistant entry, so usage is counted once. */
  last_api_id?: string | null;
  /** Entries in this message this version cannot show yet (kept raw in the store). */
  unknown?: UnknownNote;
  /** Written by a live turn in NVX Ancile (not brought in from the transcript). */
  live?: boolean;
}

/** A message a sync will write: new, or more entries for an existing one. */
export interface PlannedMessage {
  id: string;
  /** Existing message being extended (its parts and usage are appended to). */
  extends: boolean;
  parent_id: string | null;
  role: 'user' | 'assistant' | 'system';
  parts: Part[];
  uuids: string[];
  created_at: string | null;
  model_id: string | null;
  usage: Usage | null;
  kind: CcKind | null;
  command?: CcCommand;
  notification?: CcNotification;
  /** Extending a mirrored command: output to add to it. */
  output?: string | null;
  last_api_id: string | null;
  /** Entries it holds that this version cannot show yet. */
  unknown?: UnknownNote;
  /** Their raw text, for the store (never put in the message). */
  raws?: UnknownRaw[];
}

/** One mirrored message: its role, last entry, whether anything hangs off it, last api id, kind. */
export interface MirroredMessage {
  role: string;
  lastUuid: string;
  hasChildren: boolean;
  lastApiId: string | null;
  kind?: string | null;
}

/** What is already mirrored: entry uuid → message, and each message's last entry. */
export interface MirrorState {
  byUuid: Map<string, string>;
  /** message id → what is known about it */
  messages: Map<string, MirroredMessage>;
}

export interface PlanResult {
  planned: PlannedMessage[];
  /** The message the session's current entry is in (the thread's new head). */
  head: string | null;
  /** The last entry of the chain, mirrored or not. */
  lastUuid: string | null;
}

/**
 * The id a transcript line with no uuid of its own is kept under
 * (transcript.ts lineId). It is never a place Claude Code can go on from.
 */
export const LOOSE_UUID_PREFIX = 'unknown-';
export const isLoose = (uuid: string) => uuid.startsWith(LOOSE_UUID_PREFIX);

/** A message's place in the session: its last entry that Claude Code can go on from. */
export const placeOf = (uuids: string[]): string | undefined =>
  uuids.findLast((u) => !isLoose(u)) ?? uuids.at(-1);

/** The provenance a planned (new) message is written with. */
export function provenanceOf(sessionId: string, p: PlannedMessage): CcProvenance {
  return {
    session_id: sessionId,
    uuid: placeOf(p.uuids) ?? '',
    uuids: p.uuids,
    ...(p.kind && { kind: p.kind }),
    ...(p.command && { command: p.command }),
    ...(p.notification && { notification: p.notification }),
    ...(p.last_api_id && { last_api_id: p.last_api_id }),
    ...(p.unknown && { unknown: p.unknown }),
  };
}

/** Add one entry this version cannot show to a planned message. */
function noteUnknown(p: PlannedMessage, e: CcSessionMessage, types: string[]): void {
  if (!types.length) return;
  const u = p.unknown ?? { count: 0, types: [] };
  u.count += 1;
  for (const t of types) if (!u.types.includes(t) && u.types.length < 10) u.types.push(t.slice(0, 80));
  p.unknown = u;
  let raw = e.unknown?.raw;
  if (raw === undefined)
    try {
      raw = JSON.stringify(e);
    } catch {
      raw = '';
    }
  p.raws = [...(p.raws ?? []), { uuid: e.uuid, type: (types[0] as string).slice(0, 80), raw }];
}

/** Merge two notes (a message extended by a later sync). */
export function mergeUnknown(
  a: UnknownNote | undefined,
  b: UnknownNote | undefined,
): UnknownNote | undefined {
  if (!a) return b;
  if (!b) return a;
  return { count: a.count + b.count, types: [...new Set([...a.types, ...b.types])].slice(0, 10) };
}

/** The marker key for something Ancile adds after entry `uuid`. */
const after = (uuid: string) => `${uuid}+`;

/**
 * Work out the messages to write for `chain` (the session's current
 * entries, oldest first). `fallbackParent` is where a chain that starts
 * fresh hangs (after compaction): the thread's current head.
 */
export function planSync(
  chain: CcSessionMessage[],
  mirror: MirrorState,
  newId: () => string,
  fallbackParent: string | null,
): PlanResult {
  const planned: PlannedMessage[] = [];
  const seen = new Set<string>();
  let prevMsg: string | null = null;
  let prevUuid: string | null = null;
  let open: PlannedMessage | null = null;
  let lastUuid: string | null = null;

  const blank = (id: string, role: PlannedMessage['role'], kind: CcKind | null): PlannedMessage => ({
    id,
    extends: false,
    parent_id: null,
    role,
    parts: [],
    uuids: [],
    created_at: null,
    model_id: null,
    usage: null,
    kind,
    last_api_id: null,
  });

  const start = (role: PlannedMessage['role'], e: CcSessionMessage, kind: CcKind | null): PlannedMessage => {
    const p = blank(newId(), role, kind);
    p.parent_id = prevMsg ?? (planned.length === 0 && mirror.byUuid.size === 0 ? null : fallbackParent);
    p.created_at = e.timestamp ?? null;
    planned.push(p);
    prevMsg = p.id;
    return p;
  };

  for (const e of chain) {
    if (!e || typeof e.uuid !== 'string' || seen.has(e.uuid)) continue;
    seen.add(e.uuid);
    lastUuid = e.uuid;
    const known = mirror.byUuid.get(e.uuid);
    if (known) {
      // A line with no uuid of its own rides on the message before it: it changes nothing here.
      if (isLoose(e.uuid)) continue;
      open = null;
      prevMsg = mirror.byUuid.get(after(e.uuid)) ?? known;
      prevUuid = e.uuid;
      continue;
    }
    const cls = classify(e);
    if (cls.kind === 'skip') continue;

    if (cls.kind === 'unknown') {
      // A line with no uuid of its own is never a place to go on from: it rides on the message
      // before it. Inside an answer, the answer holds it. Between turns, one quiet marker per run;
      // but where the message before already has something after it (an entry an older version
      // skipped), the note goes on that message instead of starting a branch.
      const loose = isLoose(e.uuid);
      const last = planned.at(-1);
      let into: PlannedMessage | null =
        open ??
        (last && !last.extends && last.id === prevMsg && (loose || last.kind === 'unknown') ? last : null);
      const before: string | null = prevMsg;
      const mirrored: MirroredMessage | undefined = !into && before ? mirror.messages.get(before) : undefined;
      if (!into && before && mirrored && (loose || mirrored.hasChildren)) {
        const id: string = before;
        into = planned.find((p) => p.extends && p.id === id) ?? null;
        if (!into) {
          into = {
            ...blank(id, mirrored.role as PlannedMessage['role'], (mirrored.kind as CcKind) ?? null),
            extends: true,
            last_api_id: mirrored.lastApiId,
          };
          planned.push(into);
        }
      }
      if (into) {
        noteUnknown(into, e, [cls.type]);
        into.uuids.push(e.uuid);
        if (into.kind === 'unknown' && !into.extends)
          into.parts = [{ type: 'text', text: unknownText(into.unknown?.count ?? 1) }];
        if (!loose) {
          prevMsg = into.id;
          prevUuid = e.uuid;
        }
        continue;
      }
      const s = start('system', e, 'unknown');
      noteUnknown(s, e, [cls.type]);
      s.parts = [{ type: 'text', text: unknownText(1) }];
      s.uuids.push(e.uuid);
      if (!loose) prevUuid = e.uuid;
      continue;
    }

    if (cls.kind === 'assistant' || cls.kind === 'tool_result') {
      if (!open && prevMsg && prevUuid) {
        const m = mirror.messages.get(prevMsg);
        // Carry on the assistant message the previous entry ended, if nothing hangs off it yet.
        if (m && m.role === 'assistant' && m.lastUuid === prevUuid && !m.hasChildren) {
          open = { ...blank(prevMsg, 'assistant', null), extends: true, last_api_id: m.lastApiId };
          planned.push(open);
        }
      }
      if (open?.role !== 'assistant') open = start('assistant', e, null);
      const odd: string[] = [];
      open.parts.push(...partsOf(e, RESULT_CAP, odd));
      noteUnknown(open, e, odd);
      open.uuids.push(e.uuid);
      if (cls.kind === 'assistant') {
        open.model_id = modelOf(e) ?? open.model_id;
        const api = apiIdOf(e);
        if (!api || api !== open.last_api_id) open.usage = addUsage(open.usage, usageOf(e));
        open.last_api_id = api ?? open.last_api_id;
      }
      if (!open.created_at && e.timestamp) open.created_at = e.timestamp;
      prevMsg = open.id;
      prevUuid = e.uuid;
      if (cls.kind === 'tool_result' && cls.interrupted) {
        open = null;
        const s = start('system', e, 'interrupted');
        s.parts = [{ type: 'text', text: INTERRUPTED_TEXT }];
        s.uuids.push(after(e.uuid));
      }
      continue;
    }

    if (cls.kind === 'command_output') {
      // Fold a command's printed output into the command it belongs to.
      const last = planned.at(-1);
      if (open === null && last && last.kind === 'command' && last.id === prevMsg) {
        if (last.extends || !last.command) last.output = joinOutput(last.output ?? null, cls.output);
        else last.command.output = joinOutput(last.command.output, cls.output);
        last.uuids.push(e.uuid);
        prevUuid = e.uuid;
        continue;
      }
      const m = prevMsg ? mirror.messages.get(prevMsg) : undefined;
      if (prevMsg && m?.kind === 'command' && m.lastUuid === prevUuid && !m.hasChildren) {
        const ext: PlannedMessage = {
          ...blank(prevMsg, 'user', 'command'),
          extends: true,
          output: cls.output,
          uuids: [e.uuid],
        };
        planned.push(ext);
        open = null;
        prevUuid = e.uuid;
        continue;
      }
      // Output with no command before it: shown as a note.
      open = null;
      const n = start('system', e, 'notification');
      n.notification = { source: 'system', title: 'Command output' };
      n.parts = [{ type: 'text', text: cls.output ?? '' }];
      n.uuids.push(e.uuid);
      prevUuid = e.uuid;
      continue;
    }

    open = null;
    if (cls.kind === 'compact') {
      // A divider, then Claude Code's summary of what came before.
      // The divider holds no entry: on a later sync the summary's entry is known, so it is not redone.
      start('system', e, 'compact_boundary');
      const s = start('system', e, 'compact_summary');
      s.parts = cls.text ? [{ type: 'text', text: cls.text }] : [];
      s.uuids.push(e.uuid);
    } else if (cls.kind === 'interrupted') {
      const s = start('system', e, 'interrupted');
      s.parts = [{ type: 'text', text: INTERRUPTED_TEXT }];
      s.uuids.push(e.uuid);
    } else if (cls.kind === 'command') {
      const s = start('user', e, 'command');
      s.command = { ...cls.command };
      s.parts = [{ type: 'text', text: commandLine(cls.command) }];
      s.uuids.push(e.uuid);
    } else if (cls.kind === 'notification') {
      const s = start('system', e, 'notification');
      s.notification = cls.notification;
      s.parts = cls.body ? [{ type: 'text', text: cut(cls.body, RESULT_CAP * 4) }] : [];
      s.uuids.push(e.uuid);
    } else {
      const s = start('user', e, null);
      const odd: string[] = [];
      s.parts = partsOf(e, RESULT_CAP, odd);
      noteUnknown(s, e, odd);
      s.uuids.push(e.uuid);
    }
    prevUuid = e.uuid;
  }
  // A message with no parts (an empty prompt, a divider) still needs a part to render.
  for (const p of planned) if (!p.extends && p.parts.length === 0) p.parts = [{ type: 'text', text: '' }];
  return { planned, head: prevMsg, lastUuid };
}

/**
 * A subagent's conversation, collapsed onto the message holding the Task
 * call that started it (provenance.claude_code.subagent).
 */
export interface SubagentDigest {
  call_id: string | null;
  agent_id: string;
  description: string | null;
  /** Transcript entries seen, so a sync only redoes a subagent that grew. */
  count: number;
  messages: { role: 'user' | 'assistant'; parts: Part[] }[];
  truncated: boolean;
}

export function digestSubagent(agentId: string, msgs: CcSessionMessage[]): SubagentDigest {
  const callId = msgs.find((m) => m.parent_tool_use_id)?.parent_tool_use_id ?? null;
  let n = 0;
  const { planned } = planSync(msgs, { byUuid: new Map(), messages: new Map() }, () => `t${n++}`, null);
  const turns = planned
    .filter((p) => p.kind !== 'compact_boundary')
    .slice(0, SUB_TURNS_CAP)
    .map((p) => ({
      role: p.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      parts: p.parts.map((x): Part => {
        if (x.type === 'text') return { type: 'text', text: cut(x.text, SUB_TEXT_CAP) };
        if (x.type === 'reasoning') return { type: 'reasoning', text: cut(x.text, SUB_TEXT_CAP) };
        if (x.type === 'tool_result')
          return { ...x, result: typeof x.result === 'string' ? cut(x.result, SUB_TEXT_CAP / 2) : x.result };
        if (x.type === 'image') return { type: 'text', text: '[image]' };
        return x;
      }),
    }));
  return {
    call_id: callId,
    agent_id: agentId,
    description: null,
    count: msgs.length,
    messages: turns,
    truncated: planned.length > SUB_TURNS_CAP,
  };
}

/** A session's title: its name (custom title) first, then summary, then first prompt. */
export function titleOf(info: { customTitle?: string; summary?: string; firstPrompt?: string }): string {
  const pick = [info.customTitle, info.summary, info.firstPrompt].find(
    (s) => typeof s === 'string' && s.trim(),
  );
  const line = (pick ?? 'Claude Code session').trim().split(/\r?\n/)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line || 'Claude Code session';
}

/**
 * Fold a plan that was just written into the mirror, so the next chain
 * (another branch of the same session) is planned against it without
 * reading the thread again.
 */
export function applyToMirror(mirror: MirrorState, plan: PlanResult): void {
  for (const p of plan.planned) {
    const cur = mirror.messages.get(p.id);
    for (const u of p.uuids) mirror.byUuid.set(u, p.id);
    if (p.extends && cur) {
      cur.lastUuid = p.uuids.some((u) => !isLoose(u)) ? (placeOf(p.uuids) ?? cur.lastUuid) : cur.lastUuid;
      cur.lastApiId = p.last_api_id ?? cur.lastApiId;
      continue;
    }
    mirror.messages.set(p.id, {
      role: p.role,
      lastUuid: placeOf(p.uuids) ?? '',
      hasChildren: false,
      lastApiId: p.last_api_id,
      kind: p.kind,
    });
    const parent = p.parent_id ? mirror.messages.get(p.parent_id) : undefined;
    if (parent) parent.hasChildren = true;
  }
}
