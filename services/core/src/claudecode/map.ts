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
 *           |  are one assistant message; the summary Claude Code writes
 *           |  when it compacts is a system message whose provenance
 *           |  kind is 'compact_boundary' (the UI draws a divider).
 *           |  Each message lists the entry uuids it holds in
 *           |  provenance.claude_code.uuids, which is how a sync knows
 *           |  what is already mirrored. An entry whose predecessor is
 *           |  mirrored hangs off that message, so rewinding in Claude
 *           |  Code becomes a branch in Ancile.
 *  Note     |  Very large tool results are cut to RESULT_CAP characters
 *           |  with a note. Images up to IMAGE_CAP bytes are kept as
 *           |  data URLs; larger ones become a short text note.
 * ------------------------------------------------------------------
 */

import type { Part, Usage } from '@nvx/contracts';
import type { CcSessionMessage } from './bridge-protocol';

export const RESULT_CAP = 64 * 1024;
export const IMAGE_CAP = 512 * 1024;
const SUB_TEXT_CAP = 4 * 1024;
const SUB_TURNS_CAP = 300;

type Block = Record<string, unknown>;

export type EntryKind = 'prompt' | 'assistant' | 'tool_result' | 'compact' | 'skip';

const isObj = (v: unknown): v is Block => !!v && typeof v === 'object' && !Array.isArray(v);

function contentOf(e: CcSessionMessage): string | Block[] | null {
  const m = e.message;
  if (!isObj(m)) return null;
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(isObj);
  return null;
}

export function kindOf(e: CcSessionMessage): EntryKind {
  if (e.type === 'system') return 'skip';
  if (e.type === 'assistant') return 'assistant';
  if (e.isCompactSummary) return 'compact';
  if (e.is_meta) return 'skip';
  const c = contentOf(e);
  if (c === null) return 'skip';
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result' || String(b.type).endsWith('_tool_result')))
    return 'tool_result';
  return 'prompt';
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
        return JSON.stringify(b);
      })
      .join('\n');
    return cut(text, cap);
  }
  if (content === undefined || content === null) return '';
  return cut(JSON.stringify(content), cap);
}

/** One entry's content blocks as Ancile parts. */
export function partsOf(e: CcSessionMessage, cap = RESULT_CAP): Part[] {
  const c = contentOf(e);
  if (c === null) return [];
  if (typeof c === 'string') return c ? [{ type: 'text', text: cut(c, cap * 4) }] : [];
  const out: Part[] = [];
  for (const b of c) {
    const t = String(b.type);
    if (t === 'text' && typeof b.text === 'string') {
      if (b.text) out.push({ type: 'text', text: cut(b.text, cap * 4) });
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
    } else if ((t === 'tool_result' || t.endsWith('_tool_result')) && typeof b.tool_use_id === 'string') {
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

/** Provenance kept on every mirrored message. */
export interface CcProvenance {
  session_id: string;
  /** The last entry this message holds. */
  uuid: string;
  uuids: string[];
  /** 'compact_boundary' where Claude Code compacted the conversation. */
  kind?: 'compact_boundary';
  /** The API message id of the last assistant entry, so usage is counted once. */
  last_api_id?: string | null;
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
  compact: boolean;
  last_api_id: string | null;
}

/** What is already mirrored: entry uuid → message, and each message's last entry. */
export interface MirrorState {
  byUuid: Map<string, string>;
  /** message id → { role, last uuid, has children, last api id } */
  messages: Map<string, { role: string; lastUuid: string; hasChildren: boolean; lastApiId: string | null }>;
}

export interface PlanResult {
  planned: PlannedMessage[];
  /** The message the session's current entry is in (the thread's new head). */
  head: string | null;
  /** The last entry of the chain, mirrored or not. */
  lastUuid: string | null;
}

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

  const start = (role: PlannedMessage['role'], e: CcSessionMessage, compact: boolean): PlannedMessage => {
    const p: PlannedMessage = {
      id: newId(),
      extends: false,
      parent_id: prevMsg ?? (planned.length === 0 && mirror.byUuid.size === 0 ? null : fallbackParent),
      role,
      parts: [],
      uuids: [],
      created_at: e.timestamp ?? null,
      model_id: null,
      usage: null,
      compact,
      last_api_id: null,
    };
    planned.push(p);
    return p;
  };

  for (const e of chain) {
    if (!e || typeof e.uuid !== 'string' || seen.has(e.uuid)) continue;
    seen.add(e.uuid);
    lastUuid = e.uuid;
    const known = mirror.byUuid.get(e.uuid);
    if (known) {
      open = null;
      prevMsg = known;
      prevUuid = e.uuid;
      continue;
    }
    const kind = kindOf(e);
    if (kind === 'skip') continue;

    if (kind === 'assistant' || kind === 'tool_result') {
      if (!open && prevMsg && prevUuid) {
        const m = mirror.messages.get(prevMsg);
        // Carry on the assistant message the previous entry ended, if nothing hangs off it yet.
        if (m && m.role === 'assistant' && m.lastUuid === prevUuid && !m.hasChildren) {
          open = {
            id: prevMsg,
            extends: true,
            parent_id: null,
            role: 'assistant',
            parts: [],
            uuids: [],
            created_at: null,
            model_id: null,
            usage: null,
            compact: false,
            last_api_id: m.lastApiId,
          };
          planned.push(open);
        }
      }
      if (open?.role !== 'assistant') open = start('assistant', e, false);
      open.parts.push(...partsOf(e));
      open.uuids.push(e.uuid);
      if (kind === 'assistant') {
        open.model_id = modelOf(e) ?? open.model_id;
        const api = apiIdOf(e);
        if (!api || api !== open.last_api_id) open.usage = addUsage(open.usage, usageOf(e));
        open.last_api_id = api ?? open.last_api_id;
      }
      if (!open.created_at && e.timestamp) open.created_at = e.timestamp;
    } else {
      open = null;
      const p = start(kind === 'compact' ? 'system' : 'user', e, kind === 'compact');
      const parts = partsOf(e);
      // The summary stays as text; provenance kind 'compact_boundary' marks the divider.
      p.parts = kind === 'compact' ? parts.filter((x) => x.type === 'text') : parts;
      p.uuids.push(e.uuid);
    }
    const cur = planned[planned.length - 1] as PlannedMessage;
    prevMsg = cur.id;
    prevUuid = e.uuid;
    if (kind === 'prompt' || kind === 'compact') open = null;
  }
  // A user message with no parts (an empty prompt) still needs a part to render.
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
  const turns = planned.slice(0, SUB_TURNS_CAP).map((p) => ({
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
