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
 *           |  are one assistant message. A tool result always joins the
 *           |  message holding its call, even when something came between
 *           |  them (a notification, a hook's note, a stop, a sync): the
 *           |  entry itself stays where the conversation is, so nothing
 *           |  after it moves. Each step's result says how long it took,
 *           |  from the call's entry to the result's (duration_ms), and
 *           |  an API response spread over several entries is counted
 *           |  once. What Claude Code itself wrote
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
 * Bumped whenever the mapping changes what a session looks like; a thread
 * mapped by an older version is brought up to it on the next sync.
 * 1: first release. 2: Claude Code's own markup (commands,
 * notifications, compaction summary, interruptions, reminders) mapped
 * instead of shown as the person's prompts. 3: full history from the
 * transcript file (transcript.ts): every branch and everything before
 * each compaction, queued prompts included. 4: a tool result joins the
 * message holding its call even when a notification, a hook's note, a
 * stop, an entry it cannot show or a sync came between them (it used to
 * start an answer of its own, nothing but results); each step's result
 * carries how long it took (duration_ms, the transcript's times); an API
 * response whose entries span two messages is counted once.
 * A thread mapped before REBUILT_BELOW is rebuilt, but only when every
 * message in it came in from the transcript. From 3 on a thread is never
 * rebuilt: that would map its live turns again and lose their citations,
 * cost estimates, setup reports and the message ids that fact-checks,
 * branches and summaries point at. It is repaired in place instead
 * (planRepair): results join their calls, steps gain their durations and
 * a response counted twice is counted once, with nothing discarded.
 * Entries and blocks this version does not know are kept and counted (an
 * 'unknown' marker) from 3 on without any of that: what came in before
 * shows its unknown entries as new ones arrive.
 */
export const MAPPER_VERSION = 4;

/** Threads mapped before this version are rebuilt (when that loses nothing); later ones are repaired in place. */
export const REBUILT_BELOW = 3;

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
const isToolCall = (b: Block): b is Block & { id: string } =>
  (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') &&
  typeof b.id === 'string';
const blockText = (b: Block) => (typeof b.text === 'string' ? b.text : '');

/**
 * How long a step took, from the entry that made the call to the one that
 * brought its result (whole milliseconds, never negative). Absent when
 * either time is missing or unreadable.
 */
export function stepMs(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.max(0, Math.round(b - a));
}

/** A tool result with its duration, when its call was made in another entry with a time. */
function timed(p: Part, at: CcSessionMessage, call: CcSessionMessage | undefined): Part {
  if (p.type !== 'tool_result' || p.duration_ms !== undefined || !call || call.uuid === at.uuid) return p;
  const ms = stepMs(call.timestamp, at.timestamp);
  return ms === undefined ? p : { ...p, duration_ms: ms };
}

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
    } else if (isToolCall(b)) {
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
  /**
   * An answer an older mapping started with tool results whose calls an
   * earlier message holds: those results were moved there (planRepair).
   * It stays in the tree as the place its entries hold, so nothing that
   * points at it breaks; with nothing else in it, it shows nothing.
   */
  results_moved_to?: string;
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
  // Each tool call on the chain: the entry that made it (a step's duration runs from there), and
  // the message holding it: mirrored (by id) or planned now.
  const callEntry = new Map<string, CcSessionMessage>();
  const callMirrored = new Map<string, string>();
  const callPlanned = new Map<string, PlannedMessage>();
  // API responses already counted: one response spans several entries, at times two messages.
  const counted = new Set<string>();

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

  /** A mirrored message this sync adds to (one planned extension each). */
  const extend = (id: string, m: MirroredMessage): PlannedMessage => {
    const have = planned.find((p) => p.extends && p.id === id);
    if (have) return have;
    const p: PlannedMessage = {
      ...blank(id, m.role as PlannedMessage['role'], (m.kind as CcKind) ?? null),
      extends: true,
      last_api_id: m.lastApiId,
    };
    // Its last response was counted when it was written.
    if (m.lastApiId) counted.add(m.lastApiId);
    planned.push(p);
    return p;
  };

  /** The answer the previous entry ended, carried on, if nothing hangs off it yet. */
  const carryOn = (): PlannedMessage | null => {
    if (!prevMsg || !prevUuid) return null;
    const m = mirror.messages.get(prevMsg);
    if (m?.role !== 'assistant' || m.lastUuid !== prevUuid || m.hasChildren) return null;
    return extend(prevMsg, m);
  };

  /** Where the conversation is: the message the previous entry went to. */
  const here = (): PlannedMessage | null => {
    if (!prevMsg) return null;
    const id: string = prevMsg;
    const p = planned.findLast((x) => x.id === id);
    if (p) return p;
    const m = mirror.messages.get(id);
    return m ? extend(id, m) : null;
  };

  /** The answer holding tool call `id`, if the chain made it. */
  const homeOf = (id: string): PlannedMessage | null => {
    const p = callPlanned.get(id);
    if (p) return p;
    const mid = callMirrored.get(id);
    const m = mid ? mirror.messages.get(mid) : undefined;
    return mid && m?.role === 'assistant' ? extend(mid, m) : null;
  };

  /** Note the calls an entry makes. */
  const noteCalls = (e: CcSessionMessage, known: string | undefined) => {
    if (e.type !== 'assistant') return;
    const c = contentOf(e);
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!isToolCall(b) || callEntry.has(b.id)) continue;
      callEntry.set(b.id, e);
      if (known) callMirrored.set(b.id, known);
    }
  };

  /** "Stopped by you" after an interrupted tool result; one marker for a run of them. */
  const stopped = (e: CcSessionMessage) => {
    open = null;
    const cur = here();
    if (cur?.kind === 'interrupted') {
      cur.uuids.push(after(e.uuid));
      return;
    }
    const s = start('system', e, 'interrupted');
    s.parts = [{ type: 'text', text: INTERRUPTED_TEXT }];
    s.uuids.push(after(e.uuid));
  };

  for (const e of chain) {
    if (!e || typeof e.uuid !== 'string' || seen.has(e.uuid)) continue;
    seen.add(e.uuid);
    lastUuid = e.uuid;
    const known = mirror.byUuid.get(e.uuid);
    noteCalls(e, known);
    if (known) {
      // Its response was counted where it was written.
      const api = e.type === 'assistant' ? apiIdOf(e) : null;
      if (api) counted.add(api);
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
      // before it. Inside an answer, the answer holds it (the one going on, or the one the previous
      // entry ended: the same whether or not a sync came between). Between turns, one quiet marker
      // per run; but where the message before already has something after it (an entry an older
      // version skipped), the note goes on that message instead of starting a branch.
      const loose = isLoose(e.uuid);
      const before: string | null = prevMsg;
      const last: PlannedMessage | undefined = before ? planned.findLast((p) => p.id === before) : undefined;
      open ??= carryOn();
      let into: PlannedMessage | null =
        open ?? (last && !last.extends && (loose || last.kind === 'unknown') ? last : null);
      const mirrored: MirroredMessage | undefined = !into && before ? mirror.messages.get(before) : undefined;
      if (!into && before && mirrored && (loose || mirrored.hasChildren)) into = extend(before, mirrored);
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
      open ??= carryOn();
      const odd: string[] = [];
      let parts = partsOf(e, RESULT_CAP, odd).map((p) =>
        p.type === 'tool_result' ? timed(p, e, callEntry.get(p.call_id)) : p,
      );
      if (cls.kind === 'tool_result') {
        // A result belongs with its call. When the conversation moved on between them (a
        // notification, a hook's note, a stop, a sync), it joins the answer holding the call.
        let joined: PlannedMessage | null = null;
        const stay: Part[] = [];
        for (const p of parts) {
          const home = p.type === 'tool_result' ? homeOf(p.call_id) : null;
          if (!home || home === open) stay.push(p);
          else {
            home.parts.push(p);
            joined ??= home;
          }
        }
        parts = stay;
        // Nothing of it left for an answer: the entry is held where the conversation is (its
        // place in the session), so what comes after it hangs where it did.
        const at = joined && !parts.length && !open ? (here() ?? joined) : null;
        if (at) {
          noteUnknown(at, e, odd);
          at.uuids.push(e.uuid);
          prevMsg = at.id;
          prevUuid = e.uuid;
          if (cls.interrupted) stopped(e);
          continue;
        }
      }
      if (open?.role !== 'assistant') open = start('assistant', e, null);
      const into: PlannedMessage = open;
      into.parts.push(...parts);
      for (const p of parts) if (p.type === 'tool_call') callPlanned.set(p.call_id, into);
      noteUnknown(into, e, odd);
      into.uuids.push(e.uuid);
      if (cls.kind === 'assistant') {
        into.model_id = modelOf(e) ?? into.model_id;
        const api = apiIdOf(e);
        if (!api || !counted.has(api)) into.usage = addUsage(into.usage, usageOf(e));
        if (api) counted.add(api);
        into.last_api_id = api ?? into.last_api_id;
      }
      if (!into.created_at && e.timestamp) into.created_at = e.timestamp;
      prevMsg = into.id;
      prevUuid = e.uuid;
      if (cls.kind === 'tool_result' && cls.interrupted) stopped(e);
      continue;
    }

    if (cls.kind === 'command_output') {
      // Fold a command's printed output into the command it belongs to.
      const at: string | null = prevMsg;
      const last: PlannedMessage | undefined = at ? planned.findLast((p) => p.id === at) : undefined;
      if (open === null && last && last.kind === 'command') {
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

/** A stored message, as planRepair reads it (threads/repo.ts MessageRecord fits). */
export interface StoredMessage {
  id: string;
  parent_id: string | null;
  role: string;
  parts: Part[];
  usage: Usage | null;
  status?: string;
  provenance?: Record<string, unknown>;
}

/** What bringing a thread up to this mapping in place changes. */
export interface RepairPlan {
  /** Each message that changes: its new parts, usage, or provenance.claude_code (whole). */
  updates: { id: string; parts?: Part[]; usage?: Usage; claude_code?: CcProvenance }[];
  /** Results given a duration, results moved to their calls, answers whose usage was counted again. */
  counts: { timed: number; moved: number; recounted: number };
}

/**
 * Bring the messages of session `sessionId` in a thread mapped by an older
 * version up to this one, in place, from the session's chains (history):
 *
 * - A tool result in an answer that does not hold its call, while an
 *   answer above it on its path does, moves there (once). The answer it
 *   leaves keeps its entries, its place in the tree and everything else;
 *   with nothing left it shows nothing (results_moved_to).
 * - A tool result with no duration gets one from the transcript's times.
 * - An answer that counted an API response another answer already counted
 *   (an older mapping started a new message in the middle of one) has that
 *   response's tokens taken off; nothing else in its usage changes.
 *
 * Nothing is discarded or mapped again, so a live turn keeps its
 * citations, cost estimate, setup report and id. Messages still being
 * written are left alone.
 */
export function planRepair(
  sessionId: string,
  messages: StoredMessage[],
  chains: CcSessionMessage[][],
): RepairPlan {
  // From the transcript: the entry that made each call and the one that brought its result, and
  // the entries that first carry each API response.
  const entries = new Map<string, CcSessionMessage>();
  const callAt = new Map<string, CcSessionMessage>();
  const resultAt = new Map<string, CcSessionMessage>();
  const firstOfApi = new Set<string>();
  for (const chain of chains) {
    const apis = new Set<string>();
    for (const e of chain) {
      if (!e || typeof e.uuid !== 'string') continue;
      if (!entries.has(e.uuid)) entries.set(e.uuid, e);
      const c = contentOf(e);
      for (const b of Array.isArray(c) ? c : []) {
        if (isToolCall(b)) {
          if (!callAt.has(b.id)) callAt.set(b.id, e);
        } else if (isToolResult(b) && typeof b.tool_use_id === 'string' && !resultAt.has(b.tool_use_id))
          resultAt.set(b.tool_use_id, e);
      }
      const api = e.type === 'assistant' ? apiIdOf(e) : null;
      if (api && !apis.has(api)) {
        apis.add(api);
        firstOfApi.add(e.uuid);
      }
    }
  }

  interface Work {
    m: StoredMessage;
    parts: Part[];
    usage: Usage | null;
    cc: CcProvenance | null;
    changed: Set<'parts' | 'usage' | 'cc'>;
  }
  const work = new Map<string, Work>();
  for (const m of messages) {
    const cc = m.provenance?.claude_code;
    work.set(m.id, {
      m,
      parts: Array.isArray(m.parts) ? m.parts : [],
      usage: m.usage,
      cc: isObj(cc) ? ({ ...cc } as unknown as CcProvenance) : null,
      changed: new Set(),
    });
  }
  const settled = (w: Work) => w.m.status !== 'pending' && w.m.status !== 'streaming';
  const own = (w: Work) => w.cc?.session_id === sessionId && settled(w);
  const counts = { timed: 0, moved: 0, recounted: 0 };

  // Durations from the transcript's times.
  for (const w of work.values()) {
    if (!own(w)) continue;
    let n = 0;
    const parts = w.parts.map((p) => {
      if (p.type !== 'tool_result' || p.duration_ms !== undefined) return p;
      const r = resultAt.get(p.call_id);
      const t = r ? timed(p, r, callAt.get(p.call_id)) : p;
      if (t !== p) n++;
      return t;
    });
    if (!n) continue;
    w.parts = parts;
    w.changed.add('parts');
    counts.timed += n;
  }

  // Results to the answers holding their calls.
  const home = new Map<string, string>();
  for (const w of work.values())
    if (w.m.role === 'assistant' && w.cc && settled(w))
      for (const p of w.parts)
        if (p.type === 'tool_call' && !home.has(p.call_id)) home.set(p.call_id, w.m.id);
  const above = (anc: string, id: string): boolean => {
    const seen = new Set<string>();
    let cur = work.get(id)?.m.parent_id ?? null;
    while (cur && !seen.has(cur)) {
      if (cur === anc) return true;
      seen.add(cur);
      cur = work.get(cur)?.m.parent_id ?? null;
    }
    return false;
  };
  for (const w of work.values()) {
    if (w.m.role !== 'assistant' || !own(w) || !w.cc) continue;
    const mine = new Set(w.parts.flatMap((p) => (p.type === 'tool_call' ? [p.call_id] : [])));
    let to: string | null = null;
    const keep = w.parts.filter((p) => {
      if (p.type !== 'tool_result' || mine.has(p.call_id)) return true;
      const h = home.get(p.call_id);
      const host = h ? work.get(h) : undefined;
      if (!h || !host || h === w.m.id || !above(h, w.m.id)) return true;
      // Once: a repair cut short may have moved it already.
      if (!host.parts.some((q) => q.type === 'tool_result' && q.call_id === p.call_id)) {
        host.parts = [...host.parts, p];
        host.changed.add('parts');
        counts.moved++;
      }
      to ??= h;
      return false;
    });
    if (!to) continue;
    w.parts = keep.length ? keep : [{ type: 'text', text: '' }];
    w.cc = { ...w.cc, results_moved_to: to };
    w.changed.add('parts');
    w.changed.add('cc');
  }

  // A response counted twice: the older rule counted an entry whenever its API id differed from
  // the message's last one, so a message started in the middle of a response counted it again.
  // Taken off only where the stored tokens are exactly what that rule counts from these entries,
  // so a message already written by this version (a live turn before its thread's first sync)
  // or one whose numbers came from elsewhere is left as it is.
  for (const w of work.values()) {
    if (w.m.role !== 'assistant' || !own(w) || !w.usage || !w.cc) continue;
    const uuids = (Array.isArray(w.cc.uuids) ? w.cc.uuids : []).filter(
      (u): u is string => typeof u === 'string' && !isLoose(u) && !u.endsWith('+'),
    );
    const es = uuids.map((u) => entries.get(u));
    if (!es.length || es.some((e) => !e)) continue;
    let prev: string | null = null;
    let before: Usage | null = null;
    let over: Usage | null = null;
    for (const e of es as CcSessionMessage[]) {
      if (e.type !== 'assistant') continue;
      const api = apiIdOf(e);
      if (!api || api !== prev) {
        before = addUsage(before, usageOf(e));
        if (api && !firstOfApi.has(e.uuid)) over = addUsage(over, usageOf(e));
      }
      if (api) prev = api;
    }
    if (!over || !before || over.input_tokens + over.output_tokens + over.cached_tokens === 0) continue;
    const u = w.usage;
    if (
      u.input_tokens !== before.input_tokens ||
      u.output_tokens !== before.output_tokens ||
      (u.cached_tokens ?? 0) !== before.cached_tokens
    )
      continue;
    w.usage = {
      ...u,
      input_tokens: Math.max(0, u.input_tokens - over.input_tokens),
      output_tokens: Math.max(0, u.output_tokens - over.output_tokens),
      cached_tokens: Math.max(0, (u.cached_tokens ?? 0) - over.cached_tokens),
    };
    w.changed.add('usage');
    counts.recounted++;
  }

  const updates: RepairPlan['updates'] = [];
  for (const w of work.values()) {
    if (!w.changed.size) continue;
    updates.push({
      id: w.m.id,
      ...(w.changed.has('parts') && { parts: w.parts }),
      ...(w.changed.has('usage') && w.usage && { usage: w.usage }),
      ...(w.changed.has('cc') && w.cc && { claude_code: w.cc }),
    });
  }
  return { updates, counts };
}
