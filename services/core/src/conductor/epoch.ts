/**
 * ------------------------------------------------------------------
 *  Title    |  Prompt epochs: a request that starts the same way
 *  Ref      |  ROADMAP.md CA2, CA3, CA4 · docs/prompt-caching.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Providers cache a request by its exact start. This file
 *           |  decides what that start is, freezes it, and says when it
 *           |  may change: the system prompt, the tools block and the
 *           |  pinned-memory snapshot are frozen per epoch; everything
 *           |  that varies rides at the end of the request instead.
 *  How      |  An epoch is stored per thread branch (EpochStore) and
 *           |  found from the answers on the path being answered. A new
 *           |  one starts only for a reason on the closed list in
 *           |  contracts (EPOCH_REASONS). The tools block is one sorted
 *           |  superset of the tools the notebook may use, with schemas
 *           |  in canonical key order; permissions decide what may run,
 *           |  never what is declared. A tool that appears mid-epoch is
 *           |  reached through one stable `mcp_call` bridge; one that
 *           |  goes away stays declared and its calls are refused.
 *           |  The varying context (date, memory updates, ranked memory,
 *           |  summaries, this answer's instructions, sources) is one
 *           |  delimited block in front of the newest question.
 *  Note     |  Pure apart from the store. The conductor (pipeline.ts)
 *           |  calls it once per turn, before the first model round.
 *           |  Claude Code engine turns do not use it.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { EPOCH_REASONS, type EpochReason } from '@nvx/contracts';
import { profileFor } from '../gateway/profiles';
import type { ToolDef } from '../gateway/types';
import { canonicalJson, toolHash } from '../mcp/fingerprint';
import { logFor } from '../obs/logger';
import type { ToolSpec } from '../tools/registry';

const log = logFor('epoch');

export { EPOCH_REASONS, type EpochReason };

/** The name of the one bridge tool that reaches an MCP tool the epoch did not declare. */
export const MCP_BRIDGE_NAME = 'mcp_call';

export const MCP_BRIDGE: ToolDef = {
  name: MCP_BRIDGE_NAME,
  description:
    'Call a tool from an MCP server that connected after this conversation began. Give the tool’s full name and its arguments. The tools you can reach this way are listed in the context block of the latest message. Tools you already have are called directly.',
  inputSchema: {
    type: 'object',
    properties: {
      arguments: {
        type: 'object',
        description: 'The arguments the tool takes, as that tool describes them.',
      },
      name: { type: 'string', description: 'The full name of the tool, such as github__create_issue.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

/* ---- The tools block (CA3) ------------------------------------------------ */

export interface ToolsBlock {
  defs: ToolDef[];
  /** The exact text of the block; what is sent is parsed from this, so it never drifts. */
  json: string;
  hash: string;
  /** Per-tool hashes (name → hash) of the tools the block declares, the bridge excluded. */
  hashes: Record<string, string>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The tools a notebook (or a thread outside one) may be offered: never another notebook's. */
export function toolsInScope(specs: ToolSpec[], notebookId: string | null): ToolSpec[] {
  return specs.filter((t) => t.notebookId == null || t.notebookId === notebookId);
}

/** The canonical definition of one tool: sorted schema keys, nothing else added. */
function canonicalDef(t: { name: string; description: string; inputSchema: unknown }): ToolDef {
  return {
    name: t.name,
    description: t.description,
    inputSchema: JSON.parse(canonicalJson(t.inputSchema ?? { type: 'object' })) as Record<string, unknown>,
  };
}

/** One sorted, canonical superset: every tool in scope, plus the bridge. A model without tools gets none. */
export function toolsBlock(specs: ToolSpec[], withTools = true): ToolsBlock {
  if (!withTools) return { defs: [], json: '[]', hash: sha256('[]'), hashes: {} };
  const defs = [...specs.map(canonicalDef), canonicalDef(MCP_BRIDGE)].sort(byName);
  const json = JSON.stringify(defs);
  const hashes: Record<string, string> = {};
  for (const t of specs) hashes[t.name] = toolHash(t);
  return { defs, json, hash: sha256(json), hashes };
}

export interface ToolDrift {
  /** A declared tool whose description or schema is not what the epoch declared. */
  changed: string[];
  /** Tools the epoch does not declare that an MCP server offers now: reached through the bridge. */
  bridged: ToolSpec[];
  /** Declared tools that are gone now: kept declared, calls refused. */
  removed: string[];
}

export function toolDrift(epoch: Pick<EpochRecord, 'track' | 'tools_json'>, specs: ToolSpec[]): ToolDrift {
  const declared = epoch.track.tool_hashes;
  const now = new Map(specs.map((t) => [t.name, t] as const));
  const changed: string[] = [];
  for (const [name, hash] of Object.entries(declared)) {
    const t = now.get(name);
    if (t && toolHash(t) !== hash) changed.push(name);
  }
  const bridged = specs.filter((t) => !(t.name in declared) && t.source.kind === 'mcp').sort(byName);
  const removed = Object.keys(declared).filter((n) => !now.has(n));
  return { changed, bridged, removed };
}

/* ---- The epoch record ----------------------------------------------------- */

export interface EpochTrack {
  /** Pinned memory file → commit, as the snapshot was taken. */
  snapshot: Record<string, string>;
  /** Pinned memory file → commit, as last told to the model (snapshot or update). */
  sent: Record<string, string>;
  /** The instructions last told to the model when they differ from the frozen ones. */
  instructions_sent: string;
  /** The compaction summary whose note went to the model. */
  summary_sent: string | null;
  /** The declared tools' hashes. */
  tool_hashes: Record<string, string>;
}

export interface EpochRecord {
  id: string;
  thread_id: string;
  reason: EpochReason;
  /** The model family, with ":no-tools" for a model that is not offered tools. */
  model_family: string;
  thinking: boolean;
  system_text: string;
  tools_json: string;
  tools_hash: string;
  memory_commit: string | null;
  memory_text: string;
  instructions: string;
  display_name: string;
  compaction_id: string | null;
  track: EpochTrack;
  started_at: string;
  last_used_at: string;
}

export interface EpochStore {
  get(id: string): Promise<EpochRecord | undefined>;
  create(rec: EpochRecord): Promise<void>;
  /** Only the parts of an epoch that move: when it was last used, and what has been told to the model. */
  patch(id: string, p: { last_used_at?: string; track?: EpochTrack }): Promise<void>;
}

export class MemoryEpochStore implements EpochStore {
  readonly epochs = new Map<string, EpochRecord>();
  async get(id: string) {
    const e = this.epochs.get(id);
    return e ? structuredClone(e) : undefined;
  }
  async create(rec: EpochRecord) {
    this.epochs.set(rec.id, structuredClone(rec));
  }
  async patch(id: string, p: { last_used_at?: string; track?: EpochTrack }) {
    const e = this.epochs.get(id);
    if (!e) return;
    if (p.last_used_at !== undefined) e.last_used_at = p.last_used_at;
    if (p.track !== undefined) e.track = structuredClone(p.track);
  }
}

interface EpochRow {
  id: string;
  thread_id: string;
  reason: EpochReason;
  model_family: string;
  thinking: boolean;
  system_text: string;
  tools_json: string;
  tools_hash: string;
  memory_commit: string | null;
  memory_text: string;
  instructions: string;
  display_name: string;
  compaction_id: string | null;
  track: string;
  started_at: Date;
  last_used_at: Date;
}

const emptyTrack = (): EpochTrack => ({
  snapshot: {},
  sent: {},
  instructions_sent: '',
  summary_sent: null,
  tool_hashes: {},
});

/** Postgres: the text columns keep the exact bytes (jsonb would reorder keys). */
export class PgEpochStore implements EpochStore {
  constructor(private readonly sql: import('postgres').Sql) {}

  async get(id: string) {
    const rows = await this.sql<EpochRow[]>`select * from core.prompt_epochs where id = ${id}`;
    const r = rows[0];
    if (!r) return undefined;
    let track = emptyTrack();
    try {
      track = { ...track, ...(JSON.parse(r.track) as Partial<EpochTrack>) };
    } catch {
      /* an unreadable track means nothing has been told to the model yet */
    }
    return {
      id: r.id,
      thread_id: r.thread_id,
      reason: r.reason,
      model_family: r.model_family,
      thinking: r.thinking,
      system_text: r.system_text,
      tools_json: r.tools_json,
      tools_hash: r.tools_hash,
      memory_commit: r.memory_commit,
      memory_text: r.memory_text,
      instructions: r.instructions,
      display_name: r.display_name,
      compaction_id: r.compaction_id,
      track,
      started_at: r.started_at.toISOString(),
      last_used_at: r.last_used_at.toISOString(),
    } satisfies EpochRecord;
  }

  async create(e: EpochRecord) {
    await this.sql`
      insert into core.prompt_epochs (id, thread_id, reason, model_family, thinking, system_text, tools_json,
        tools_hash, memory_commit, memory_text, track, instructions, display_name, compaction_id, started_at, last_used_at)
      values (${e.id}, ${e.thread_id}, ${e.reason}, ${e.model_family}, ${e.thinking}, ${e.system_text}, ${e.tools_json},
        ${e.tools_hash}, ${e.memory_commit}, ${e.memory_text}, ${JSON.stringify(e.track)}, ${e.instructions},
        ${e.display_name}, ${e.compaction_id}, ${e.started_at}, ${e.last_used_at})
      on conflict (id) do nothing`;
  }

  async patch(id: string, p: { last_used_at?: string; track?: EpochTrack }) {
    await this.sql`
      update core.prompt_epochs set
        last_used_at = coalesce(${p.last_used_at ?? null}, last_used_at),
        track = coalesce(${p.track ? JSON.stringify(p.track) : null}, track)
      where id = ${id}`;
  }
}

/* ---- When an epoch may begin ---------------------------------------------- */

/** How long a provider keeps a cached start (its shortest published lifetime); idle past this is a cold point. */
export function cacheTtlMs(provider: string): number {
  const first = profileFor(provider).cache.ttl[0];
  if (!first) return 5 * 60_000;
  const m = /^(\d+)\s*(m|h)$/.exec(first);
  if (m) return Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000);
  return first === 'in_memory' ? 10 * 60_000 : 5 * 60_000;
}

export interface EpochInputs {
  /** The epoch of the latest answer on this branch, if any. */
  prev: EpochRecord | undefined;
  lane: string;
  thinking: boolean;
  specs: ToolSpec[];
  /** The compaction summary this turn answers with, if any. */
  compactionId: string | null;
  now: number;
  ttlMs: number;
  /** True when something the epoch froze would read differently if frozen now. */
  frozenIsStale: boolean;
}

/** The reason a new epoch starts now, or null to carry on. The order is the order of precedence. */
export function epochReason(a: EpochInputs, withTools = true): EpochReason | null {
  const p = a.prev;
  if (!p) return 'new_thread';
  if (p.model_family !== a.lane) return 'model_family';
  if (p.thinking !== a.thinking) return 'thinking_toggled';
  if (withTools && toolDrift(p, a.specs).changed.length) return 'tools_changed';
  if ((p.compaction_id ?? null) !== a.compactionId) return 'compaction';
  const idle = a.now - Date.parse(p.last_used_at);
  if (a.frozenIsStale && idle > a.ttlMs) return 'memory_refresh';
  return null;
}

/** Log a tools-block change with the servers behind it, so an MCP upgrade shows up as a reason. */
export function warnToolsChanged(prev: EpochRecord, specs: ToolSpec[], threadId: string): void {
  const now = new Map(specs.map((t) => [t.name, t] as const));
  const servers = new Set<string>();
  for (const n of toolDrift(prev, specs).changed) {
    const s = now.get(n)?.source;
    servers.add(s?.kind === 'mcp' ? s.server : 'built-in');
  }
  log.warn(
    { thread_id: threadId, epoch_id: prev.id, servers: [...servers] },
    'a tool changed its description or schema, so a new prompt epoch starts',
  );
}

/** Log an epoch start with its reason, for the cache-miss report (CA7). */
export function logEpochStart(e: EpochRecord): void {
  log.info(
    {
      thread_id: e.thread_id,
      epoch_id: e.id,
      reason: e.reason,
      model_family: e.model_family,
      tools_hash: e.tools_hash,
      memory_commit: e.memory_commit,
    },
    'prompt epoch started',
  );
}

export function newTrack(init: Partial<EpochTrack> = {}): EpochTrack {
  return { ...emptyTrack(), ...init };
}

/* ---- The system prompt of an epoch ---------------------------------------- */

/**
 * The frozen system text: the rules, the tools note, the memory snapshot and
 * the thread's instructions, in that order. The start (rules and tools note) is
 * the same for every thread of a notebook; what differs by thread comes last.
 */
export function frozenSystem(parts: { base: string; memory: string; instructions: string }): string {
  return [parts.base, parts.memory, parts.instructions].filter(Boolean).join('\n\n');
}

/**
 * CA5: the frozen system prompt in two pieces, the rules and the snapshot
 * (pinned memory and the thread's instructions), so Anthropic can mark both
 * ends. Null when it does not split cleanly; the pieces joined by a blank line
 * are exactly `system_text`.
 */
export function systemBlocks(
  epoch: Pick<EpochRecord, 'system_text' | 'memory_text' | 'instructions'>,
): [string, string] | null {
  const tail = [epoch.memory_text, epoch.instructions].filter(Boolean).join('\n\n');
  const text = epoch.system_text;
  if (!tail || !text.endsWith(tail)) return null;
  const rules = text.slice(0, text.length - tail.length).replace(/\n\n$/, '');
  if (!rules || `${rules}\n\n${tail}` !== text) return null;
  return [rules, tail];
}

/* ---- The context block at the end of the request (CA2) -------------------- */

/** Short git commit, as shown in "Memory update (commit abc1234)". */
export const shortSha = (sha: string) => sha.slice(0, 7);

export interface ContextBlockParts {
  /** ISO date, UTC. */
  date: string;
  /** Pinned memory changed since the model was last told: the full current pack, with the commits. */
  memoryUpdate: { text: string; commits: string[] } | null;
  /** Memory ranked for this question. */
  memoryRanked: string;
  /** The thread's instructions when they are not what the epoch froze. */
  instructionsUpdate: string;
  /** The compaction summary or the engine's recall note. */
  note: string;
  /** Instructions for this answer only (Beam fuse, judges, review). */
  answerInstructions: string;
  /** MCP tools reached through the bridge. */
  bridged: ToolSpec[];
  /** Retrieved passages, linked summaries. */
  sources: string;
}

/** One section per piece, in a fixed order, so the same pieces always make the same bytes. */
export function contextBlock(p: ContextBlockParts): string {
  const sections: string[] = [`Today's date: ${p.date} (UTC).`];
  if (p.memoryUpdate?.text) {
    const label =
      p.memoryUpdate.commits.length === 1
        ? `Memory update (commit ${p.memoryUpdate.commits[0]})`
        : `Memory update (commits ${p.memoryUpdate.commits.join(', ')})`;
    sections.push(
      `${label}. This replaces the matching notes in the memory block of the system prompt:\n\n${p.memoryUpdate.text}`,
    );
  }
  if (p.memoryRanked) sections.push(`Memory that may bear on this question:\n\n${p.memoryRanked}`);
  if (p.instructionsUpdate)
    sections.push(
      `Instructions update. These replace the instructions in the system prompt:\n\n${p.instructionsUpdate}`,
    );
  if (p.note) sections.push(p.note);
  if (p.answerInstructions) sections.push(`Instructions for this answer only:\n\n${p.answerInstructions}`);
  if (p.bridged.length)
    sections.push(
      `Tools connected since this conversation began. Call them through ${MCP_BRIDGE_NAME} with the name and arguments:\n\n${p.bridged
        .map(
          (t) =>
            `- ${t.name}: ${t.description}\n  arguments (JSON Schema): ${canonicalJson(t.inputSchema ?? { type: 'object' })}`,
        )
        .join('\n')}`,
    );
  if (p.sources) sections.push(p.sources);
  return sections.join('\n\n');
}

/* ---- The per-family switch ------------------------------------------------ */

/** Settings value `cache.end_context`: { [family]: false } turns the end-of-request layout off for a family. */
export type EndContextSwitch = Record<string, boolean>;

export const endContextOn = (sw: EndContextSwitch | undefined, family: string): boolean =>
  sw?.[family] !== false;

/* ---- The bridge call (CA3) ------------------------------------------------ */

/** The tool a bridge call names and the arguments it passes, or why the call cannot be understood. */
export function bridgeTarget(args: unknown): { name: string; args: unknown } | { error: string } {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
  const name = a && typeof a.name === 'string' ? a.name.trim() : '';
  if (!name)
    return { error: `${MCP_BRIDGE_NAME} needs the full name of a tool, such as github__create_issue.` };
  let inner: unknown = a?.arguments ?? {};
  // Some models send the arguments as a JSON string.
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner);
    } catch {
      return { error: `The arguments for ${name} were not valid JSON, so nothing was run.` };
    }
  }
  return { name, args: inner };
}
