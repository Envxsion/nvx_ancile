/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code transcripts, in full
 *  Ref      |  docs/claude-code.md (Nothing lost: full history)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read every message of a Claude Code session, every
 *           |  branch a rewind left and everything before each
 *           |  compaction, from the person's own transcript file. The
 *           |  Agent SDK gives only the current chain from the last
 *           |  compaction on.
 *  How      |  Read-only and tolerant. The file is found by session id
 *           |  among the folders of Claude Code's projects folder (the
 *           |  folder name encoding is Claude Code's, never re-derived
 *           |  here), and read up to the size it had when we looked,
 *           |  so a session being appended to is read as a snapshot; a
 *           |  half-written last line is left for the next read. Each
 *           |  line is one JSON entry. A line this reader does not know
 *           |  (a kind of entry a newer Claude Code writes, or a line
 *           |  that is not JSON) is never dropped: it is kept with its
 *           |  raw text as an `unknown` entry where it was written, so
 *           |  the thread can say "1 entry this version of NVX Ancile
 *           |  can't show yet" and the line is stored as it was.
 *           |  Entries form a tree by uuid → parentUuid. A compaction
 *           |  writes a `system/compact_boundary` entry with no parent
 *           |  and `logicalParentUuid` pointing at the last entry
 *           |  before it, so the tree is joined back through it. The
 *           |  active path is the one ending at the last entry written.
 *           |  Parallel tool calls make "branches" that are not
 *           |  branches: each tool_use block is its own entry, chained
 *           |  one after another, and each result hangs off its own
 *           |  call (`sourceToolAssistantUUID`). A leaf whose own part
 *           |  holds only such results, more blocks of an API message
 *           |  already on a path, attachments, system or meta entries,
 *           |  is folded back into the path that holds its source; any
 *           |  other leaf (a new prompt or answer after a rewind) is a
 *           |  real branch, read root to leaf.
 *           |  The result is a list of chains, old branches first and
 *           |  the active path last, each in the shape the SDK returns
 *           |  (CcSessionMessage), so map.ts treats them alike.
 *  Note     |  Never writes. Sidechain entries (subagents) are left to
 *           |  the SDK's subagent calls. TRANSCRIPT_READER_VERSION goes
 *           |  up whenever what this returns changes.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CcSessionMessage } from './bridge-protocol';
import { LOOSE_UUID_PREFIX } from './map';

/** 2: lines it does not know are kept as `unknown` entries, never skipped. */
export const TRANSCRIPT_READER_VERSION = 2;

/** More lines that are not JSON than this share, and the reader's answer is not trusted. */
export const MAX_UNKNOWN_SHARE = 0.02;

/** Entry kinds the reader knows (others are counted as unknown). */
const KNOWN = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
  'summary',
  'last-prompt',
  'mode',
  'permission-mode',
  'agent-name',
  'custom-title',
  'ai-title',
  'atis-latch',
  'bridge-session',
  'frame-link',
  'queue-operation',
  'file-history-delta',
  'file-history-snapshot',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'cost-state',
  'tag',
  'progress',
]);

export interface RawEntry {
  type: string;
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string | null;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  sessionId?: string;
  timestamp?: string;
  message?: unknown;
  origin?: unknown;
  sourceToolAssistantUUID?: string;
  /** A queued prompt (attachment queued_command): read as a user message. */
  queued?: { uuid: string; prompt: string; origin: unknown };
  /** Position in the file, for order. */
  seq: number;
  /** A kind of entry this reader does not know (or "not_json"): kept, with its raw line. */
  unknownType?: string;
  raw?: string;
  /** An unknown line with no uuid of its own: not part of the tree, placed after `anchor`. */
  pseudo?: boolean;
  /** The last entry with a uuid written before it. */
  anchor?: string | null;
}

export interface ReadStats {
  lines: number;
  /** Lines that were not JSON, or not a kind of entry the reader knows (kept as unknown entries). */
  unknown: number;
  /** Of those, lines that were not JSON at all. */
  unreadable: number;
  entries: number;
  compactions: number;
  /** Branches beyond the active path. */
  branches: number;
  /** Leaves folded back into a path (parallel tool results and the like). */
  folded: number;
  /** A half-written last line, left for next time. */
  partialTail: boolean;
}

export type ReadResult =
  | { ok: true; chains: CcSessionMessage[][]; stats: ReadStats; path: string }
  | { ok: false; reason: string; stats?: ReadStats; path?: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Read the lines of a file up to the size it has now; a last line without its newline is left out. */
export async function readSnapshot(
  path: string,
): Promise<{ lines: string[]; partialTail: boolean; size: number }> {
  const { size } = await stat(path);
  if (size === 0) return { lines: [], partialTail: false, size };
  const lines: string[] = [];
  const stream = createReadStream(path, { start: 0, end: size - 1, encoding: 'utf8', flags: 'r' });
  // The last byte decides whether the final line is complete.
  let lastChar = '';
  stream.on('data', (chunk) => {
    const s = String(chunk);
    if (s.length) lastChar = s[s.length - 1] as string;
  });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) lines.push(line);
  const partialTail = lastChar !== '\n' && lines.length > 0;
  if (partialTail) lines.pop();
  return { lines, partialTail, size };
}

/** A stable id for a line with no uuid of its own (the same line gets the same id on every read). */
export function lineId(line: string): string {
  return `${LOOSE_UUID_PREFIX}${createHash('sha256').update(line).digest('hex').slice(0, 24)}`;
}

/**
 * Parse lines into entries with a uuid; count what is not understood.
 * A line of a kind the reader does not know, or one that is not JSON, is
 * kept as an entry with `unknownType` and its raw text, never dropped.
 */
export function parseEntries(lines: string[]): {
  entries: RawEntry[];
  unknown: number;
  unreadable: number;
  lines: number;
} {
  const entries: RawEntry[] = [];
  let unknown = 0;
  let unreadable = 0;
  let n = 0;
  let anchor: string | null = null;
  const keepLoose = (line: string, type: string) => {
    entries.push({
      type: 'unknown',
      uuid: lineId(line),
      parentUuid: null,
      unknownType: type,
      raw: line,
      pseudo: true,
      anchor,
      seq: entries.length,
    });
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    n++;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      unknown++;
      unreadable++;
      keepLoose(line, 'not_json');
      continue;
    }
    if (!isObj(j) || typeof j.type !== 'string') {
      unknown++;
      unreadable++;
      keepLoose(line, isObj(j) ? 'no_type' : 'not_an_object');
      continue;
    }
    const known = KNOWN.has(j.type);
    if (!known) unknown++;
    if (typeof j.uuid !== 'string' || !j.uuid) {
      if (!known) keepLoose(line, j.type);
      continue;
    }
    // A prompt typed while Claude Code was working is delivered as an
    // attachment; the SDK shows it as a user message with the source's uuid.
    const queued =
      j.type === 'attachment' &&
      isObj(j.attachment) &&
      j.attachment.type === 'queued_command' &&
      typeof j.attachment.prompt === 'string' &&
      j.attachment.isMeta !== true
        ? j.attachment
        : null;
    entries.push({
      ...(queued && {
        queued: {
          uuid: typeof queued.source_uuid === 'string' ? queued.source_uuid : j.uuid,
          prompt: queued.prompt as string,
          origin: queued.origin,
        },
      }),
      type: j.type,
      uuid: j.uuid,
      parentUuid: typeof j.parentUuid === 'string' ? j.parentUuid : null,
      ...(typeof j.logicalParentUuid === 'string' && { logicalParentUuid: j.logicalParentUuid }),
      ...(typeof j.subtype === 'string' && { subtype: j.subtype }),
      ...(j.isSidechain === true && { isSidechain: true }),
      ...(j.isMeta === true && { isMeta: true }),
      ...(j.isCompactSummary === true && { isCompactSummary: true }),
      ...(typeof j.sessionId === 'string' && { sessionId: j.sessionId }),
      ...(typeof j.timestamp === 'string' && { timestamp: j.timestamp }),
      ...(j.message !== undefined && { message: j.message }),
      ...(j.origin !== undefined && { origin: j.origin }),
      ...(typeof j.sourceToolAssistantUUID === 'string' && {
        sourceToolAssistantUUID: j.sourceToolAssistantUUID,
      }),
      ...(!known && { unknownType: j.type, raw: line }),
      seq: entries.length,
    });
    anchor = j.uuid;
  }
  return { entries, unknown, unreadable, lines: n };
}

const blocks = (e: RawEntry): Record<string, unknown>[] => {
  const c = isObj(e.message) ? e.message.content : undefined;
  return Array.isArray(c) ? c.filter(isObj) : [];
};
const isToolResultEntry = (e: RawEntry) =>
  e.type === 'user' &&
  blocks(e).some((b) => b.type === 'tool_result' || String(b.type).endsWith('_tool_result'));
const apiId = (e: RawEntry): string | null =>
  e.type === 'assistant' && isObj(e.message) && typeof e.message.id === 'string' ? e.message.id : null;

/** Turn one raw entry into the shape the SDK returns. */
export function toSdkShape(e: RawEntry, sessionId: string): CcSessionMessage {
  if (e.unknownType)
    return {
      type: 'unknown',
      uuid: e.uuid,
      session_id: e.sessionId ?? sessionId,
      message: e.message,
      parent_tool_use_id: null,
      ...(e.timestamp && { timestamp: e.timestamp }),
      unknown: { type: e.unknownType, raw: e.raw ?? '' },
    };
  if (e.queued)
    return {
      type: 'user',
      uuid: e.queued.uuid,
      session_id: e.sessionId ?? sessionId,
      message: { role: 'user', content: e.queued.prompt },
      parent_tool_use_id: null,
      ...(e.timestamp && { timestamp: e.timestamp }),
      ...(e.queued.origin !== undefined && { origin: e.queued.origin }),
    };
  return {
    type: e.type as CcSessionMessage['type'],
    uuid: e.uuid,
    session_id: e.sessionId ?? sessionId,
    message: e.message,
    parent_tool_use_id: null,
    ...(e.timestamp && { timestamp: e.timestamp }),
    ...(e.isCompactSummary && { isCompactSummary: true }),
    ...(e.isMeta && { is_meta: true }),
    ...(e.origin !== undefined && { origin: e.origin }),
  };
}

/**
 * Build the chains (old branches first, the active path last) from the
 * entries of one session file.
 */
export function buildChains(
  all: RawEntry[],
  sessionId: string,
): { chains: CcSessionMessage[][]; compactions: number; branches: number; folded: number } {
  // Later writes of the same uuid win, at the place it was first written.
  const byUuid = new Map<string, RawEntry>();
  const loose = all.filter((e) => e.pseudo);
  for (const e of all) {
    if (e.isSidechain || e.pseudo) continue;
    const prev = byUuid.get(e.uuid);
    byUuid.set(e.uuid, prev ? { ...e, seq: prev.seq } : e);
  }
  const entries = [...byUuid.values()].sort((a, b) => a.seq - b.seq);
  if (!entries.length && !loose.length) return { chains: [], compactions: 0, branches: 0, folded: 0 };
  const parentOf = (e: RawEntry): string | null => {
    const p = e.parentUuid ?? e.logicalParentUuid ?? null;
    return p && byUuid.has(p) ? p : null;
  };
  const kids = new Map<string, RawEntry[]>();
  let compactions = 0;
  for (const e of entries) {
    if (e.subtype === 'compact_boundary') compactions++;
    const p = parentOf(e);
    if (p) kids.set(p, [...(kids.get(p) ?? []), e]);
  }
  const pathTo = (leaf: RawEntry): RawEntry[] => {
    const out: RawEntry[] = [];
    const seen = new Set<string>();
    let cur: RawEntry | undefined = leaf;
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      out.push(cur);
      const p = parentOf(cur);
      cur = p ? byUuid.get(p) : undefined;
    }
    return out.reverse();
  };

  // The active path ends at the last entry written, unless that is an unknown entry with no
  // place in the tree (it is folded in after what it follows instead).
  const leaf = entries.findLast((e) => !e.unknownType || parentOf(e)) ?? entries.at(-1);
  const active = leaf ? pathTo(leaf) : [];
  const covered = new Set(active.map((e) => e.uuid));
  const coveredApi = new Set(active.map(apiId).filter((x): x is string => !!x));
  const chosen: RawEntry[][] = [];
  let folded = 0;

  // A leaf's own part: from the leaf up to (not including) the first entry already covered.
  const ownPart = (leaf: RawEntry): RawEntry[] => {
    const out: RawEntry[] = [];
    let cur: RawEntry | undefined = leaf;
    const seen = new Set<string>();
    while (cur && !covered.has(cur.uuid) && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      out.push(cur);
      const p = parentOf(cur);
      cur = p ? byUuid.get(p) : undefined;
    }
    return out;
  };
  const meaningful = (e: RawEntry, recovered: Set<string>, api: Set<string>): boolean => {
    if (e.queued) return true;
    if (e.type === 'attachment' || e.type === 'system' || e.type === 'summary') return false;
    if (e.type === 'assistant') {
      const id = apiId(e);
      return !(id && api.has(id));
    }
    if (e.type === 'user') {
      if (e.isCompactSummary) return true;
      if (isToolResultEntry(e))
        return !(
          e.sourceToolAssistantUUID &&
          (covered.has(e.sourceToolAssistantUUID) || recovered.has(e.sourceToolAssistantUUID))
        );
      return !e.isMeta;
    }
    return false;
  };

  const leaves = entries.filter((e) => !kids.has(e.uuid) && !covered.has(e.uuid));
  for (const leaf of leaves) {
    const part = ownPart(leaf);
    if (!part.length) continue;
    // Read it top-down, so a recovered assistant block vouches for the results below it.
    const recovered = new Set<string>();
    const api = new Set(coveredApi);
    let real = false;
    for (const e of [...part].reverse()) {
      if (meaningful(e, recovered, api)) {
        real = true;
        break;
      }
      recovered.add(e.uuid);
      const id = apiId(e);
      if (id) api.add(id);
    }
    if (!real) {
      folded++;
      continue;
    }
    const path = pathTo(leaf);
    chosen.push(path);
    for (const e of path) {
      covered.add(e.uuid);
      const id = apiId(e);
      if (id) coveredApi.add(id);
    }
  }

  // Fold the orphans back in: results of a call on a path, and more blocks of an API message on it.
  const onChain = new Set<string>();
  for (const c of [...chosen, active]) for (const e of c) onChain.add(e.uuid);
  const orphans = entries.filter(
    (e) => !onChain.has(e.uuid) && (e.type === 'assistant' || isToolResultEntry(e) || !!e.unknownType),
  );
  orphans.push(...loose);
  orphans.sort((a, b) => a.seq - b.seq);
  // Where an unknown entry goes: after its parent, or (no uuid of its own) after the entry before it.
  const unknownAnchor = (o: RawEntry): string | null => (o.pseudo ? (o.anchor ?? null) : parentOf(o));
  const withOrphans = (chain: RawEntry[]): RawEntry[] => {
    const out = [...chain];
    const here = new Set(out.map((e) => e.uuid));
    const apis = new Set(out.map(apiId).filter((x): x is string => !!x));
    for (let round = 0; round < 8; round++) {
      let added = 0;
      for (const o of orphans) {
        if (here.has(o.uuid)) continue;
        const id = apiId(o);
        let anchor = -1;
        if (o.unknownType) {
          const a = unknownAnchor(o);
          if (a && here.has(a)) anchor = out.findIndex((e) => e.uuid === a);
        } else if (o.type === 'assistant' && id && apis.has(id))
          anchor = out.findLastIndex((e) => apiId(e) === id);
        else if (o.sourceToolAssistantUUID && here.has(o.sourceToolAssistantUUID))
          anchor = out.findIndex((e) => e.uuid === o.sourceToolAssistantUUID);
        if (anchor < 0) continue;
        // After the anchor and anything already folded in behind it that was written earlier.
        let at = anchor + 1;
        while (
          at < out.length &&
          !onChain.has((out[at] as RawEntry).uuid) &&
          (out[at] as RawEntry).seq < o.seq
        )
          at++;
        out.splice(at, 0, o);
        here.add(o.uuid);
        if (id) apis.add(id);
        added++;
      }
      if (!added) break;
    }
    return out;
  };

  const keep = (e: RawEntry) => e.type === 'user' || e.type === 'assistant' || !!e.queued || !!e.unknownType;
  const built = [...chosen, active].map(withOrphans);
  // An unknown entry with no place on any chain is never dropped: it goes on the active path,
  // after what was written before it.
  const placed = new Set<string>();
  for (const c of built) for (const e of c) placed.add(e.uuid);
  const last = built.at(-1) as RawEntry[];
  for (const o of orphans) {
    if (!o.unknownType || placed.has(o.uuid)) continue;
    const at = last.findLastIndex((e) => e.seq < o.seq);
    last.splice(at + 1, 0, o);
    placed.add(o.uuid);
  }
  const chains = built.map((c) => c.filter(keep).map((e) => toSdkShape(e, sessionId)));
  return { chains, compactions, branches: chosen.length, folded };
}

/** Find a session's transcript among Claude Code's project folders. */
export async function findTranscript(projectsDir: string, sessionId: string): Promise<string | null> {
  if (!/^[\w-]{8,200}$/.test(sessionId) || !existsSync(projectsDir)) return null;
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(projectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read a session's full history: every branch, everything before compactions. */
export async function readTranscript(path: string, sessionId: string): Promise<ReadResult> {
  let snap: Awaited<ReturnType<typeof readSnapshot>>;
  try {
    snap = await readSnapshot(path);
  } catch (err) {
    return {
      ok: false,
      reason: `could not read the file: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      path,
    };
  }
  const parsed = parseEntries(snap.lines);
  const built = buildChains(parsed.entries, sessionId);
  const stats: ReadStats = {
    lines: parsed.lines,
    unknown: parsed.unknown,
    unreadable: parsed.unreadable,
    entries: parsed.entries.length,
    compactions: built.compactions,
    branches: built.branches,
    folded: built.folded,
    partialTail: snap.partialTail,
  };
  // Kinds of entry it does not know are kept (as unknown entries); more than a few lines that
  // are not JSON at all mean the file is not what the reader expects.
  if (parsed.lines > 0 && parsed.unreadable / parsed.lines > MAX_UNKNOWN_SHARE)
    return { ok: false, reason: 'too many lines that are not JSON', stats, path };
  const active = (built.chains.at(-1) ?? []).filter((e) => e.type !== 'unknown');
  if (parsed.lines > 0 && !active.length) return { ok: false, reason: 'no conversation found', stats, path };
  return { ok: true, chains: built.chains, stats, path };
}

/**
 * Does the reader's answer hold the SDK's chain? Every entry the SDK
 * returns should be on one of the reader's chains (a tiny share may
 * differ while the file is being written).
 */
export function coversSdkChain(chains: CcSessionMessage[][], sdk: CcSessionMessage[]): boolean {
  if (!sdk.length) return true;
  const have = new Set<string>();
  for (const c of chains) for (const e of c) have.add(e.uuid);
  const want = sdk.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.is_meta);
  const missing = want.filter((e) => !have.has(e.uuid)).length;
  return missing <= Math.max(2, Math.floor(want.length * 0.01));
}
