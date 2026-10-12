/**
 * ------------------------------------------------------------------
 *  Title    |  Live Claude Code sessions
 *  Ref      |  docs/claude-code.md (Live sessions) · contracts claudecode.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Carry on a Claude Code session from its thread: send a
 *           |  turn, watch it stream like any answer, approve its tool
 *           |  calls in Ancile's own dialog, stop it, and keep every
 *           |  branch, trace and citation.
 *  How      |  The person's own installed Claude Code runs through the
 *           |  Agent SDK in the Claude bridge (a separate MIT program;
 *           |  Core never loads the SDK). One bridge session per thread,
 *           |  resumed in the session's own folder. A turn is a run of
 *           |  kind `claude_code`: the user message is written at once,
 *           |  the run sends the prompt (a recorded step, never twice),
 *           |  mirrors the SDK's messages into the run's event stream
 *           |  (text.delta, reasoning.delta, tool.call, tool.result,
 *           |  usage), and at the end writes the answer with the SAME
 *           |  mapping an import uses (map.ts), keyed by the entry uuids
 *           |  Claude Code writes to its transcript, so a later sync
 *           |  adds nothing twice. Branching from an earlier message
 *           |  forks the session at that message's entry
 *           |  (resumeSessionAt); the fork is bound to the same thread.
 *           |  Every tool call is asked about by the bridge, on its real
 *           |  input, and decided by the gate as agent:claude-code
 *           |  (permission-map.ts): allowed, denied, or an approval in
 *           |  Ancile's dialog whose answer (with edited arguments, if
 *           |  the person changed them) goes back to Claude Code. Ancile
 *           |  never answers with Claude Code's own "always" choices.
 *           |  The notebook's sources are offered as Ancile's MCP server
 *           |  (mcp-server.ts); passages it returns become citations.
 *  Note     |  A session a Claude Code process outside NVX Ancile holds
 *           |  (holders.ts: a terminal, an IDE) is never written to: the
 *           |  turn goes on in a fork by itself. One merely written to by
 *           |  another process in the last minute is not opened
 *           |  (claude_code.session_busy); a fork is offered instead.
 *           |  Logs carry ids and counts, never prompts, answers or
 *           |  tool input.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  AncileError,
  CLAUDE_CODE_CONTEXT_NOTICE,
  type ClaudeCodeCommand,
  type ClaudeCodeFolderRequest,
  type ClaudeCodeFolderResult,
  type ClaudeCodeLiveState,
  type CreateClaudeCodeThreadRequest,
  type CreateClaudeCodeThreadResult,
  type EngineContextReport,
  type Part,
  type RetrievalTrace,
  type SearchHit,
  type SendClaudeCodeRequest,
  type SendClaudeCodeResult,
  type Usage,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import { applyCitations } from '../conductor/citations';
import { currentContext, newSpanId, newTraceId, type RequestContext } from '../context';
import type { EventBus } from '../events/bus';
import type { LabPasses } from '../lab/hosted';
import { hostedTool } from '../lab/hosted';
import { notFound } from '../obs/errors';
import { logFor } from '../obs/logger';
import { type SpanHandle, startSpan } from '../obs/spans';
import type { Gate } from '../permissions/gate';
import type { FsProbe } from '../permissions/normalize';
import { APPROVAL_TTL_MS } from '../permissions/reconcile';
import type { ApprovalRecord, PermissionStore } from '../permissions/store';
import type { RunContext, RunHandler, RunOutcome, RunRecord, RunStore } from '../runs/engine';
import { RunOwnershipLost, StepUncertain } from '../runs/engine';
import type { RunEventInput, RunEventLog } from '../runs/events';
import { alreadyRunning } from '../runs/store';
import type { RunWorker } from '../runs/worker';
import type { MessageRecord, NewMessage, ThreadRecord, ThreadRepo } from '../threads/repo';
import type { ToolRegistry } from '../tools/registry';
import type {
  CcSessionInfo,
  CcSessionMessage,
  LiveBridge,
  LiveEvent,
  LivePermissionAsk,
  LivePermissionReply,
} from './bridge-protocol';
import { type CliCommand, CommandCatalogue, type CommandList, mergeCommands } from './commands';
import { ccErrors } from './errors';
import type { SessionHolders } from './holders';
import { type CcProvenance, MAPPER_VERSION, planSync, provenanceOf, type UnknownRaw } from './map';
import { type Passage, threadToken } from './mcp-server';
import {
  ANCILE_MCP_SERVER,
  CLAUDE_CODE_PRINCIPAL,
  gateRoot,
  type MappedTool,
  mapTool,
} from './permission-map';
import type { ClaudeCodeStore } from './store';

const log = logFor('claude-code-live');

export const CC_MODEL_NAME = 'Claude Code';
/** A transcript written to more recently than this, by someone else, is open elsewhere. */
export const BUSY_WINDOW_MS = 60_000;
/** How long one turn may take before it is stopped. */
export const TURN_DEADLINE_MS = 60 * 60_000;
/** Claude Code's command list is read again after this (claudecode/commands.ts). */
export { COMMANDS_TTL_MS } from './commands';

const IDEMPOTENCY_MS = 10 * 60_000;
const STOP_GRACE_MS = 15_000;
const PREVIEW = 280;

/** What a claude_code run carries through a restart. */
export interface ClaudeCodeCheckpoint {
  v: 1;
  threadId: string;
  workspaceId: string;
  notebookId: string | null;
  userMessageId: string;
  assistantMessageId: string;
  text: string;
  /** The uuid the prompt is sent with; Claude Code writes its transcript entry under it. */
  promptUuid: string;
  /** The session the turn resumes (the one forked from, for a fork). */
  sessionId: string;
  /** Fork: the Claude Code entry the new session goes on from. */
  resumeAt: string | null;
  fork: boolean;
  cwd: string;
  model: string | null;
  effort: string | null;
  sourceIds: string[] | null;
  /** The session the turn ended up in (a fork's new id). */
  finalSessionId: string | null;
  /** Engines: what goes before the person's words (other engines' turns, or a seed summary). */
  prefix?: string | null;
  /** Engines: start a new session instead of resuming (seeded from NVX Ancile's summary). */
  fresh?: boolean;
  /** Engines: the summary the fresh session is seeded with, marked seen once it exists. */
  seedSummaryId?: string | null;
  /** Engines: provenance.engine_context for the answer. */
  engineContext?: EngineContextReport | null;
  /** The new session becomes the thread's own (its folder was changed: fresh_next). */
  rebind?: boolean;
  /** Without files: Claude Code's own tools off, in NVX Ancile's empty folder. */
  noFiles?: boolean;
}

/**
 * Engines (docs/engines.md): what a Claude Code turn sends when its thread
 * holds turns by other engines, and the note appended to its system prompt.
 * Built in services/core/src/engines/claude.ts; absent, turns behave as
 * before (a parent must be a Claude Code message).
 */
export interface LiveTurnPlan {
  /** The session to go on from (null: the thread's own). */
  sessionId: string | null;
  /** The latest Claude Code message on the path; null when there is none. */
  anchorId: string | null;
  /** Its transcript entry, for a fork. */
  resumeAt: string | null;
  /** Claude Code went on past the anchor elsewhere: a fork. */
  goneOn: boolean;
  prefix: string | null;
  fresh: boolean;
  seedSummaryId: string | null;
  report: EngineContextReport | null;
  /** Remember what the plan told the session (the notebook's sources), once the turn is sent. */
  commit?: () => Promise<void>;
}

export interface LiveEngineHooks {
  /** Plan a turn from this parent; throws (an AncileError) when the thread's scope refuses Claude Code. */
  plan(a: {
    thread: ThreadRecord;
    messages: MessageRecord[];
    parentId: string | null;
    /** A new session must start (the folder changed): give it the thread so far. */
    fresh?: boolean;
  }): Promise<LiveTurnPlan>;
  /** The appended system note: NVX Ancile's base note plus the thread's instructions and persona. */
  systemNote(a: { threadId: string; notebookId: string | null; base: string }): Promise<string>;
  /** A session now holds this summary (it was seeded with it). */
  seen(a: { workspaceId: string; threadId: string; sessionId: string; summaryId: string }): Promise<void>;
  /**
   * A new Claude Code thread in this notebook and folder: throws (an
   * AncileError) when the notebook's scope refuses Claude Code or the folder.
   */
  allowNew?(a: { workspaceId: string; notebookId: string | null; cwd: string }): Promise<void>;
  /** A tool step finished in a live turn (memory writes become proposals). */
  toolDone?(e: {
    threadId: string;
    notebookId: string | null;
    runId: string;
    messageId: string;
    cwd: string;
    tool: string;
    input: unknown;
    ok: boolean;
  }): Promise<unknown>;
}

export interface LiveServiceView {
  cliPath(): Promise<{ path: string; version: string }>;
  cliEnv(): Promise<Record<string, string>>;
  syncSession(
    info: CcSessionInfo,
    notebookOverride?: string,
    opts?: { force?: boolean; threadId?: string },
  ): Promise<{ thread_id: string; added: number; notebook_id: string | null }>;
  transcriptModified(sessionId: string): Promise<number | null>;
  setLiveGuard(fn: (sessionId: string) => boolean): void;
  /** The notebook a folder's sessions go to, made (or adopted) on first use. */
  notebookForFolder?(cwd: string): Promise<string | null>;
  /** The folder is in Settings → Claude Code → Excluded folders. */
  folderExcluded?(cwd: string): Promise<boolean>;
  /** Keep the raw text of entries this version cannot show (and warn once per Claude Code version). */
  keepUnknown?(threadId: string, sessionId: string, items: UnknownRaw[]): Promise<void>;
}

export interface LiveDeps {
  workspaceId: string;
  userId: string;
  bridge: LiveBridge;
  service: LiveServiceView;
  sessionInfo(sessionId: string): Promise<CcSessionInfo | null>;
  threads: ThreadRepo;
  store: ClaudeCodeStore;
  runs: RunStore;
  events: RunEventLog;
  worker: Pick<RunWorker, 'kick'>;
  bus?: EventBus;
  permissions: PermissionStore;
  /** A gate whose root is the session's folder (writes outside it are critical). */
  gateFor(root: string): Gate;
  tools?: Pick<ToolRegistry, 'get'>;
  passes?: LabPasses;
  /** Ancile's MCP server for sessions (/mcp/claude), when it is served. */
  mcp?: { url: string; secret: string } | null;
  notebook(id: string): Promise<{ title: string; grounded: boolean } | null>;
  /** After a finished answer in a notebook (fact-check in a grounded one). */
  afterAnswer?(a: { messageId: string; notebookId: string; workspaceId: string }): Promise<void>;
  approvalTtlMs?: number;
  now?: () => number;
  turnDeadlineMs?: number;
  stopGraceMs?: number;
  /** Does a folder exist (tests)? */
  folderExists?: (cwd: string) => Promise<boolean>;
  /** What is at a path, for a new thread's folder (tests); default: the file system. */
  folderKind?: (cwd: string) => Promise<'dir' | 'file' | 'missing'>;
  /** Engines (docs/engines.md): one thread, any model. */
  engines?: LiveEngineHooks;
  /** Bridge handles another part of Core drives (Claude Code as a model): their events are not ours. */
  foreignHandle?: (handle: string) => boolean;
  /** Keep the bridge running for those handles too. */
  keepAlive?: () => boolean;
  /** Plan limits: sees every pushed message (rate_limit_event) and each turn's end. */
  limits?: { observe(m: Record<string, unknown>): Promise<void>; afterTurn(handle: string): void };
  /** A Claude Code process outside NVX Ancile holding a session (holders.ts); absent: the 60 s rule only. */
  holders?: Pick<SessionHolders, 'holder'>;
  /** The empty folder a thread that goes on without files runs in (made when first needed). */
  noFilesDir?: string;
}

interface Turn {
  cp: ClaudeCodeCheckpoint;
  runId: string;
  traceId: string;
  parent: RequestContext;
  entries: CcSessionMessage[];
  /** Content block index → kind, for the stream message being read. */
  blocks: Map<number, string>;
  /** API messages whose text arrived as deltas (so the full block is not sent again). */
  streamed: Set<string>;
  streamingApi: string | null;
  modelSpan: { api: string; span: SpanHandle } | null;
  toolSpans: Map<string, { span: SpanHandle; asked?: number }>;
  calls: Set<string>;
  /** Each tool call's name and the arguments it ran with (edited ones, when the person changed them). */
  toolInputs: Map<string, { name: string; input: unknown }>;
  passages: Passage[];
  result: Record<string, unknown> | null;
  error: string | null;
  stopped: boolean;
  sessionId: string | null;
  seq: number;
  settle: (() => void) | null;
}

interface Live {
  threadId: string;
  workspaceId: string;
  notebookId: string | null;
  cwd: string;
  handle: string | null;
  /** The session the open handle is on (a fork's id once Claude Code says it). */
  sessionId: string | null;
  state: ClaudeCodeLiveState['state'];
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  /** The appended system note the open handle was started with. */
  note: string | null;
  /** Claude Code's running cost total for the open handle (to tell one turn's share). */
  costSoFar: number;
  turn: Turn | null;
}

interface WaitingAsk {
  live: Live;
  ask: LivePermissionAsk;
  mapped: MappedTool;
  askedAt: number;
  /** The turn (run) it was asked in: it lives and dies with that turn. */
  runId: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const preview = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s;
};
const stripMarker = (u: string) => u.replace(/\+$/, '');

/**
 * A thread started in NVX Ancile (POST /claude-code/threads) is bound to a
 * placeholder like this until its first turn, when Claude Code names the
 * session it started.
 */
export const PENDING_SESSION_PREFIX = 'ancile-new-';
export const isPendingSession = (id: string | null | undefined): boolean =>
  !!id && id.startsWith(PENDING_SESSION_PREFIX);

/** What is at a path: a folder, something else, or nothing. */
export async function folderKind(path: string): Promise<'dir' | 'file' | 'missing'> {
  try {
    return (await stat(path)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/** How much one command entry has to show and complete. */
function richness(c: ClaudeCodeCommand): number {
  return (
    (c.handled_by === 'ancile' ? 1_000_000 : 0) +
    (c.source === 'builtin' ? 100_000 : 0) +
    c.arguments.length * 1_000 +
    (c.argument_hint ? 500 : 0) +
    Math.min(c.description.length, 499)
  );
}

/**
 * One entry per command name (case and a leading slash do not count),
 * keeping the richest: a read from a live session after a turn can list a
 * command twice (a skill found in two places, a plugin's and its own).
 */
export function dedupeCommands(items: ClaudeCodeCommand[]): ClaudeCodeCommand[] {
  const best = new Map<string, ClaudeCodeCommand>();
  for (const c of items) {
    const key = commandKey(c.name);
    if (!key) continue;
    const had = best.get(key);
    if (!had || richness(c) > richness(had)) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const commandKey = (name: string) => name.replace(/^\//, '').trim().toLowerCase();

/**
 * The same for Claude Code's own list before it is merged: a built-in
 * first (as mergeCommands decides), then the entry that says the most.
 */
export function dedupeCliCommands(list: CliCommand[]): CliCommand[] {
  const score = (c: CliCommand) =>
    (c.builtin ? 100_000 : 0) + (c.argumentHint ? 500 : 0) + Math.min(c.description?.length ?? 0, 499);
  const best = new Map<string, CliCommand>();
  for (const c of list) {
    if (!c || typeof c.name !== 'string') continue;
    const key = commandKey(c.name);
    if (!key) continue;
    const had = best.get(key);
    if (!had || score(c) > score(had)) best.set(key, { ...c, name: c.name.replace(/^\//, '').trim() });
  }
  return [...best.values()];
}

/** realpath for the gate over posix-form real paths ("/C:/a/b"). */
export function nativeProbe(): FsProbe {
  return {
    realpath: async (p: string) => {
      const native = /^\/[a-zA-Z]:\//.test(p) ? p.slice(1) : p;
      const real = (await realpath(native)).replace(/\\/g, '/');
      return real.startsWith('/') ? real : `/${real}`;
    },
  };
}

/** The short, stable note appended to Claude Code's system prompt (kept stable for prompt caching). */
export function appendPrompt(notebookTitle: string | null): string {
  const where = notebookTitle ? `the notebook "${notebookTitle}"` : 'a thread';
  return [
    `You are running inside NVX Ancile, in ${where}.`,
    "The notebook's sources are its primary sources: search them with mcp__ancile__search and read one with mcp__ancile__read_source.",
    'When you use a passage, cite it by its [n] marker exactly as the search returned it.',
  ].join(' ');
}

export class ClaudeCodeLive {
  private readonly lives = new Map<string, Live>(); // by thread
  private readonly byHandle = new Map<string, Live>();
  private readonly waiting = new Map<string, WaitingAsk>(); // approval id → ask
  private readonly sent = new Map<string, { at: number; result: SendClaudeCodeResult }>();
  private readonly commandCatalogue = new CommandCatalogue(
    () => this.now(),
    (key, err) =>
      log.warn({ err: (err as Error).message, key }, "Claude Code's command list could not be read"),
  );
  /** When Ancile itself last saw a session written (so its own writes are not "someone else"). */
  private readonly ownWrites = new Map<string, number>();
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: LiveDeps) {
    this.now = deps.now ?? Date.now;
    this.unsubscribe = deps.bridge.onEvent((e) => {
      void this.onEvent(e).catch((err: unknown) =>
        log.error({ err: (err as Error).message, event: e.event }, 'a live Claude Code event failed'),
      );
    });
    deps.bridge.setKeepAlive(() => this.byHandle.size > 0 || (deps.keepAlive?.() ?? false));
    deps.service.setLiveGuard((id) => this.writing(id));
  }

  stop(): void {
    this.unsubscribe();
    for (const l of this.byHandle.values())
      if (l.handle) void this.deps.bridge.close(l.handle).catch(() => undefined);
    this.byHandle.clear();
  }

  /** When a turn from NVX Ancile last wrote this session (ms), or null: its writes are not someone else's. */
  ownWriteAt(sessionId: string): number | null {
    return this.ownWrites.get(sessionId) ?? null;
  }

  /** Is a live turn writing this session now? */
  writing(sessionId: string): boolean {
    for (const l of this.lives.values())
      if (
        l.turn &&
        (l.turn.cp.sessionId === sessionId || l.turn.sessionId === sessionId || l.sessionId === sessionId)
      )
        return true;
    return false;
  }

  private live(thread: ThreadRecord): Live {
    let l = this.lives.get(thread.id);
    if (!l) {
      l = {
        threadId: thread.id,
        workspaceId: thread.workspace_id,
        notebookId: thread.notebook_id,
        cwd: thread.settings.claude_code?.cwd ?? '',
        handle: null,
        sessionId: null,
        state: 'idle',
        model: null,
        effort: null,
        permissionMode: null,
        note: null,
        costSoFar: 0,
        turn: null,
      };
      this.lives.set(thread.id, l);
    }
    l.notebookId = thread.notebook_id;
    return l;
  }

  private async thread(threadId: string): Promise<ThreadRecord> {
    const t = await this.deps.threads.getThread(threadId);
    if (!t || t.workspace_id !== this.deps.workspaceId) throw notFound('That thread');
    if (!t.settings.claude_code?.session_id) throw ccErrors.notBound();
    return t;
  }

  /**
   * Is the session open somewhere else? 'process': a Claude Code process
   * outside NVX Ancile holds it (seen running); 'recent': another process
   * wrote its transcript within the last minute (the fallback guess).
   */
  private async heldElsewhere(sessionId: string, cwd: string | null): Promise<'process' | 'recent' | null> {
    if (isPendingSession(sessionId)) return null;
    const mtime = await this.deps.service.transcriptModified(sessionId).catch(() => null);
    const held = await this.deps.holders?.holder({ sessionId, cwd, modifiedMs: mtime }).catch(() => null);
    if (held) return 'process';
    if (mtime === null) return null;
    const own = this.ownWrites.get(sessionId) ?? 0;
    return this.now() - mtime < BUSY_WINDOW_MS && mtime > own + 5_000 ? 'recent' : null;
  }

  /** Is the session's folder still a folder on this computer? */
  private async folderThere(cwd: string): Promise<boolean> {
    if (this.deps.folderExists) return this.deps.folderExists(cwd);
    return (await (this.deps.folderKind ?? folderKind)(cwd)) === 'dir';
  }

  /** NVX Ancile's own empty folder, for threads that go on without files. */
  private async noFilesDir(): Promise<string> {
    const dir = this.deps.noFilesDir ?? join(tmpdir(), 'nvx-ancile-no-folder');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * The session's folder moved, was renamed or was deleted: point the
   * thread at the folder where it is now (checked like a new thread's:
   * a whole path, a folder that exists, not excluded, and inside what the
   * notebook's scope allows), or go on without files. Either way the next
   * turn starts a new session, given the thread so far.
   */
  async setFolder(threadId: string, req: ClaudeCodeFolderRequest): Promise<ClaudeCodeFolderResult> {
    const thread = await this.thread(threadId);
    const cc = thread.settings.claude_code;
    if (!cc) throw ccErrors.notBound();
    const active = (await this.deps.runs.activeForThread(thread.id))[0];
    if (active) throw alreadyRunning(active.id);
    let next: typeof cc;
    if ('cwd' in req) {
      const cwd = req.cwd.trim();
      if (!isAbsolute(cwd) && !/^[a-zA-Z]:[\\/]/.test(cwd)) throw ccErrors.folderInvalid('relative');
      const kind = await (this.deps.folderKind ?? folderKind)(cwd);
      if (kind !== 'dir') throw ccErrors.folderInvalid(kind === 'missing' ? 'missing' : 'not_directory');
      if (await this.deps.service.folderExcluded?.(cwd)) throw ccErrors.folderExcluded(cwd);
      await this.deps.engines?.allowNew?.({
        workspaceId: this.deps.workspaceId,
        notebookId: thread.notebook_id,
        cwd,
      });
      const { no_files: _off, ...rest } = cc;
      next = { ...rest, cwd, fresh_next: true };
    } else {
      await this.noFilesDir();
      next = { ...cc, no_files: true, fresh_next: true };
    }
    await this.deps.threads.patchThread(thread.id, { settings: { claude_code: next } });
    // The open session (if any) belongs to the old folder.
    const l = this.lives.get(thread.id);
    if (l) {
      await this.closeHandle(l);
      l.cwd = next.no_files ? await this.noFilesDir() : (next.cwd ?? '');
    }
    log.info(
      { thread_id: thread.id, no_files: next.no_files === true },
      "a Claude Code thread's folder was changed",
    );
    return { cwd: next.cwd, no_files: next.no_files === true };
  }

  /* ---- send -------------------------------------------------------------- */

  /**
   * A new thread bound to a new session in a folder on this computer. The
   * session starts with the first turn; until then the thread holds a
   * placeholder (PENDING_SESSION_PREFIX), and that turn starts fresh.
   */
  async createThread(req: CreateClaudeCodeThreadRequest): Promise<CreateClaudeCodeThreadResult> {
    const cwd = req.cwd.trim();
    if (!isAbsolute(cwd) && !/^[a-zA-Z]:[\\/]/.test(cwd)) throw ccErrors.folderInvalid('relative');
    const kind = await (this.deps.folderKind ?? folderKind)(cwd);
    if (kind !== 'dir') throw ccErrors.folderInvalid(kind === 'missing' ? 'missing' : 'not_directory');
    if (await this.deps.service.folderExcluded?.(cwd)) throw ccErrors.folderExcluded(cwd);
    await this.deps.service.cliPath(); // installed and verified, or a clear error
    let notebookId: string | null = null;
    if (req.notebook_id) {
      if (!(await this.deps.notebook(req.notebook_id))) throw notFound('That notebook');
      notebookId = req.notebook_id;
    } else notebookId = (await this.deps.service.notebookForFolder?.(cwd)) ?? null;
    // The notebook's scope decides before anything exists: Claude Code allowed, and this folder.
    await this.deps.engines?.allowNew?.({ workspaceId: this.deps.workspaceId, notebookId, cwd });
    const folder =
      cwd
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || cwd;
    const title = `New session in ${folder}`;
    const t = await this.deps.threads.createThread({
      id: `thr_${ulid()}`,
      workspace_id: this.deps.workspaceId,
      title,
      notebook_id: notebookId,
      settings: {
        claude_code: {
          session_id: `${PENDING_SESSION_PREFIX}${randomUUID()}`,
          cwd,
          last_uuid: null,
          synced_at: new Date(this.now()).toISOString(),
        },
      },
    });
    log.info({ thread_id: t.id, notebook_id: notebookId }, 'a new Claude Code thread was started');
    return { thread_id: t.id, notebook_id: notebookId, cwd, title };
  }

  async send(threadId: string, req: SendClaudeCodeRequest): Promise<SendClaudeCodeResult> {
    for (const [k, v] of this.sent) if (this.now() - v.at > IDEMPOTENCY_MS) this.sent.delete(k);
    const key = `${threadId}:${req.idempotency_key}`;
    const again = this.sent.get(key);
    if (again) return again.result;

    const thread = await this.thread(threadId);
    const cc = thread.settings.claude_code;
    // Before every turn: the session's folder is still there (or the thread goes on without files).
    const noFiles = cc?.no_files === true;
    if (!noFiles && !cc?.cwd) throw ccErrors.noFolder();
    if (!noFiles && cc?.cwd && !(await this.folderThere(cc.cwd))) throw ccErrors.folderMissing(cc.cwd);
    if (!cc) throw ccErrors.notBound();
    const cwd = noFiles ? await this.noFilesDir() : (cc.cwd as string);
    await this.deps.service.cliPath(); // installed and verified, or a clear error
    const active = (await this.deps.runs.activeForThread(thread.id))[0];
    if (active) throw alreadyRunning(active.id);

    // A thread started in NVX Ancile has no session until its first turn starts one.
    const pending = isPendingSession(cc.session_id);
    // Bring in anything Claude Code wrote since the last sync, so the branch point is right.
    const info = pending ? null : await this.deps.sessionInfo(cc.session_id).catch(() => null);
    if (info) await this.deps.service.syncSession(info, undefined, { force: true }).catch(() => undefined);

    const msgs = await this.deps.threads.messages(thread.id);
    // parent_id null: from the start of the session (editing its first message). Claude Code
    // cannot fork before its first entry, so a new session starts in the same folder, bound to
    // the same thread, and the new first message is a branch at the root.
    const fromStart = req.parent_id === null && msgs.length > 0;
    const parentId =
      req.parent_id === undefined
        ? ((await this.deps.threads.getThread(thread.id))?.active_head_id ?? null)
        : req.parent_id;
    const parent = parentId ? msgs.find((m) => m.id === parentId) : undefined;
    if (parentId && !parent) throw notFound('That message');
    const pc = parent?.provenance?.claude_code as CcProvenance | undefined;
    // Engines: a parent written by another model goes on from Claude Code's last message on
    // the path, with what the others said as a digest (engines/claude.ts).
    // The folder was pointed somewhere new (or files turned off): a new session, given the thread so far.
    const restart = cc.fresh_next === true;
    const plan = this.deps.engines
      ? await this.deps.engines.plan({
          thread,
          messages: msgs,
          parentId: parent?.id ?? null,
          ...(restart && { fresh: true }),
        })
      : null;
    if (parent && !pc?.uuid && !plan && !restart) throw ccErrors.branchUnmapped();
    const fresh = plan?.fresh === true || pending || fromStart || restart;
    const sessionId = plan ? (plan.sessionId ?? cc.session_id) : (pc?.session_id ?? cc.session_id);
    const resumeAt = plan ? plan.resumeAt : pc?.uuid ? stripMarker(pc.uuid) : null;
    // Claude Code went on past the parent in the same session: carry on in a fork.
    const goneOn = plan
      ? plan.goneOn
      : !!parent &&
        msgs.some(
          (m) =>
            m.parent_id === parent.id &&
            (m.provenance?.claude_code as CcProvenance | undefined)?.session_id === sessionId,
        );
    const canFork = plan ? !!plan.anchorId : !!parent;
    let fork = !fresh && canFork && (goneOn || req.as_branch === true);
    // Open in a terminal (or an IDE) right now: never write to it; go on in a branch by itself.
    let branched: SendClaudeCodeResult['branched'];
    if (!fork && !fresh) {
      const held = await this.heldElsewhere(sessionId, cwd);
      if (held === 'process' && canFork) {
        fork = true;
        branched = 'open_in_terminal';
      } else if (held) throw ccErrors.sessionBusy(sessionId);
    }
    for (const other of this.lives.values())
      if (other.threadId !== thread.id && other.handle && other.sessionId === sessionId && !fork && !fresh)
        throw ccErrors.sessionBusy(sessionId);

    const traceId = currentContext()?.traceId ?? newTraceId();
    const promptUuid = randomUUID();
    const userId = `msg_${ulid()}`;
    const assistantId = `msg_${ulid()}`;
    const runId = `run_${ulid()}`;
    await this.deps.threads.insertMessage({
      id: userId,
      thread_id: thread.id,
      parent_id: parent?.id ?? null,
      role: 'user',
      parts: [{ type: 'text', text: req.text }],
      status: 'complete',
      trace_id: traceId,
      provenance: {
        claude_code: { session_id: sessionId, uuid: promptUuid, uuids: [promptUuid] } satisfies CcProvenance,
      },
    });
    await this.deps.threads.insertMessage({
      id: assistantId,
      thread_id: thread.id,
      parent_id: userId,
      role: 'assistant',
      parts: [],
      status: 'pending',
      run_id: runId,
      trace_id: traceId,
      provenance: { model_name: CC_MODEL_NAME },
    });
    const checkpoint: ClaudeCodeCheckpoint = {
      v: 1,
      threadId: thread.id,
      workspaceId: thread.workspace_id,
      notebookId: thread.notebook_id,
      userMessageId: userId,
      assistantMessageId: assistantId,
      text: req.text,
      promptUuid,
      sessionId,
      resumeAt: fork ? resumeAt : null,
      fork,
      cwd,
      model: req.model ?? null,
      effort: req.effort ?? null,
      sourceIds: req.source_ids?.length ? req.source_ids : null,
      finalSessionId: null,
      ...(plan && {
        prefix: fromStart ? null : plan.prefix,
        seedSummaryId: fromStart ? null : plan.seedSummaryId,
        engineContext: fromStart ? null : plan.report,
      }),
      ...((plan || fresh) && { fresh }),
      ...(restart && { rebind: true }),
      ...(noFiles && { noFiles: true }),
    };
    try {
      await this.deps.runs.create({
        id: runId,
        kind: 'claude_code',
        traceId,
        threadId: thread.id,
        messageId: assistantId,
        checkpoint,
      });
    } catch (err) {
      await this.deps.threads.discardMessages([assistantId, userId]);
      throw err;
    }
    await this.deps.threads.patchThread(thread.id, { active_head_id: assistantId });
    await plan
      ?.commit?.()
      .catch((err: unknown) =>
        log.warn({ err: (err as Error).message }, "could not remember the notebook's sources for a session"),
      );
    this.deps.worker.kick();
    const result: SendClaudeCodeResult = {
      run_id: runId,
      user_message_id: userId,
      assistant_message_id: assistantId,
      ...(checkpoint.prefix && { context_shared: true }),
      ...(branched && { branched }),
    };
    this.sent.set(key, { at: this.now(), result });
    log.info({ thread_id: thread.id, run_id: runId, fork, fresh }, 'a Claude Code turn was sent');
    return result;
  }

  /* ---- the session behind a thread -------------------------------------- */

  private async ensureHandle(l: Live, cp: ClaudeCodeCheckpoint): Promise<string> {
    const want = cp.fork || cp.fresh ? null : cp.sessionId;
    const nb = l.notebookId ? await this.deps.notebook(l.notebookId) : null;
    const base = appendPrompt(nb?.title ?? null);
    // NVX Ancile's instructions and persona ride in the appended note; a changed note reopens the session.
    const note = this.deps.engines
      ? await this.deps.engines
          .systemNote({ threadId: l.threadId, notebookId: l.notebookId, base })
          .catch(() => base)
      : base;
    // "auto": no effort at all, so Claude Code picks; a session with one set reopens without it.
    const auto = cp.effort === 'auto';
    const effort = auto ? null : cp.effort;
    if (
      l.handle &&
      want &&
      l.sessionId === want &&
      (l.note === null || l.note === note) &&
      !(auto && l.effort !== null)
    ) {
      if (cp.model && cp.model !== l.model) {
        await this.withdrawWaiting(l, 'model_changed');
        await this.deps.bridge.control(l.handle, 'set_model', { model: cp.model });
        l.model = cp.model;
      }
      if (effort && effort !== l.effort) {
        await this.deps.bridge.control(l.handle, 'set_effort', { effort });
        l.effort = effort;
      }
      return l.handle;
    }
    if (l.handle) await this.closeHandle(l);
    const cli = await this.deps.service.cliPath();
    l.state = 'starting';
    const { handle } = await this.deps.bridge.open({
      // A fresh session (seeded from NVX Ancile's summary) resumes nothing.
      ...(!cp.fresh && { resume: cp.sessionId }),
      ...(cp.fork && !cp.fresh && { fork: true, ...(cp.resumeAt && { resume_at: cp.resumeAt }) }),
      cwd: cp.cwd,
      ...(cp.model && { model: cp.model }),
      ...(effort && { effort }),
      // Without files: none of Claude Code's own tools, and only the person's user settings.
      ...(cp.noFiles && { tools: [], setting_sources: ['user' as const] }),
      permission_mode: 'default',
      append_system_prompt: note,
      ...(this.deps.mcp && {
        mcp_servers: {
          [ANCILE_MCP_SERVER]: {
            type: 'http',
            url: this.deps.mcp.url,
            headers: { authorization: `Bearer ${threadToken(this.deps.mcp.secret, l.threadId)}` },
          },
        },
      }),
      env: await this.deps.service.cliEnv(),
      path_to_cli: cli.path,
    });
    l.handle = handle;
    l.sessionId = cp.fork || cp.fresh ? null : cp.sessionId;
    l.note = note;
    l.state = 'ready';
    l.model = cp.model;
    l.effort = effort;
    l.permissionMode = 'default';
    l.costSoFar = 0;
    this.byHandle.set(handle, l);
    return handle;
  }

  private async closeHandle(l: Live) {
    const h = l.handle;
    if (!h) return;
    l.handle = null;
    l.sessionId = null;
    l.state = 'idle';
    this.byHandle.delete(h);
    await this.deps.bridge.close(h).catch(() => undefined);
  }

  /* ---- the run ------------------------------------------------------------ */

  handler(): RunHandler {
    return {
      execute: (ctx) => this.execute(ctx),
      cancelled: async (run: RunRecord) => {
        const cp = run.checkpoint as ClaudeCodeCheckpoint;
        await this.deps.threads.updateMessage(cp.assistantMessageId, { status: 'stopped' });
      },
      failed: async (run: RunRecord, error) => {
        const cp = run.checkpoint as ClaudeCodeCheckpoint;
        await this.deps.threads.updateMessage(cp.assistantMessageId, {
          status: 'error',
          provenance: { model_name: CC_MODEL_NAME, error },
        });
      },
    };
  }

  private async execute(ctx: RunContext): Promise<RunOutcome> {
    const run = ctx.run;
    const cp = structuredClone(run.checkpoint) as ClaudeCodeCheckpoint;
    const emit = (e: RunEventInput) => ctx.events.append(run.id, e);
    const thread = await this.deps.threads.getThread(cp.threadId);
    if (!thread)
      return {
        kind: 'failed',
        error: {
          code: 'request.not_found',
          title: "That thread doesn't exist",
          hint: 'It may have been deleted.',
        },
      };
    const l = this.live(thread);
    if (!l.turn) l.cwd = cp.cwd; // the folder may have changed since the thread was first opened
    if (l.turn)
      return {
        kind: 'failed',
        error: {
          code: 'run.already_running',
          title: 'This thread is already answering',
          hint: 'Wait for it, or stop it first.',
        },
      };

    await this.deps.threads.updateMessage(cp.assistantMessageId, { status: 'streaming', run_id: run.id });
    await emit({
      type: 'model',
      message_id: cp.assistantMessageId,
      model_id: `claude-code/${cp.model ?? 'default'}`,
      display_name: CC_MODEL_NAME,
    });

    // A restart after the prompt went out: Claude Code may have answered while
    // nobody was listening. What it wrote comes in from its transcript.
    if (run.attempt > 0 && (await this.deps.runs.step(run.id, 0))) return this.recover(cp, emit);
    // Engines: say once, above the answer, that some of the thread goes to Claude Code.
    if (cp.prefix && cp.engineContext)
      await emit({
        type: 'context.shared',
        message_id: cp.assistantMessageId,
        engine: 'claude_code',
        notice: CLAUDE_CODE_CONTEXT_NOTICE,
        turns: cp.engineContext.foreign_turns,
        tokens: cp.engineContext.tokens,
        seeded_from_summary: cp.engineContext.seeded_from_summary,
      });

    const turn: Turn = {
      cp,
      runId: run.id,
      traceId: run.traceId,
      parent: currentContext() ?? { traceId: run.traceId, spanId: newSpanId() },
      entries: [],
      blocks: new Map(),
      streamed: new Set(),
      streamingApi: null,
      modelSpan: null,
      toolSpans: new Map(),
      calls: new Set(),
      toolInputs: new Map(),
      passages: [],
      result: null,
      error: null,
      stopped: false,
      sessionId: null,
      seq: 1_000,
      settle: null,
    };
    const done = new Promise<void>((r) => {
      turn.settle = r;
    });
    l.turn = turn;
    const onAbort = () => {
      turn.stopped = true;
      if (l.handle) void this.deps.bridge.interrupt(l.handle).catch(() => undefined);
      // Claude Code answers an interrupt with a result; if it does not, stop waiting.
      setTimeout(() => turn.settle?.(), this.deps.stopGraceMs ?? STOP_GRACE_MS).unref?.();
    };
    ctx.signal.addEventListener('abort', onAbort);
    let deadline: NodeJS.Timeout | null = null;
    try {
      let handle: string;
      try {
        handle = await this.ensureHandle(l, cp);
      } catch (err) {
        const e =
          err instanceof AncileError ? err : ccErrors.liveFailed((err as Error).message ?? String(err));
        const error = { code: e.code, title: e.title, hint: e.hint };
        await this.deps.threads.updateMessage(cp.assistantMessageId, {
          status: 'error',
          provenance: { model_name: CC_MODEL_NAME, error },
        });
        await emit({ type: 'error', ...error, attempts: [] });
        return { kind: 'failed', error };
      }
      l.state = 'working';
      try {
        await ctx.once(0, 'claude_code_prompt', { promptUuid: cp.promptUuid }, async () => {
          await this.deps.bridge.send(handle, cp.prefix ? `${cp.prefix}\n\n${cp.text}` : cp.text, {
            uuid: cp.promptUuid,
          });
          return true;
        });
      } catch (err) {
        if (!(err instanceof StepUncertain)) throw err;
        const error = { code: err.code, title: err.title, hint: err.hint };
        await this.deps.threads.updateMessage(cp.assistantMessageId, {
          status: 'error',
          provenance: { model_name: CC_MODEL_NAME, error },
        });
        await emit({ type: 'error', ...error, attempts: [] });
        return { kind: 'failed', error };
      }
      deadline = setTimeout(() => {
        turn.error = `The turn did not finish within ${Math.round((this.deps.turnDeadlineMs ?? TURN_DEADLINE_MS) / 60_000)} minutes`;
        if (l.handle) void this.deps.bridge.interrupt(l.handle).catch(() => undefined);
        turn.settle?.();
      }, this.deps.turnDeadlineMs ?? TURN_DEADLINE_MS);
      deadline.unref?.();
      await done;
      if (ctx.signal.reason instanceof RunOwnershipLost) throw ctx.signal.reason;
      return await this.finish(l, turn, emit, ctx.signal.aborted || turn.stopped);
    } finally {
      if (deadline) clearTimeout(deadline);
      ctx.signal.removeEventListener('abort', onAbort);
      turn.modelSpan?.span.end('ok');
      for (const t of turn.toolSpans.values()) t.span.end('unset');
      l.turn = null;
      if (l.state === 'working') l.state = l.handle ? 'ready' : 'idle';
      const sid = turn.sessionId ?? cp.sessionId;
      this.ownWrites.set(sid, this.now());
      // A question still open when its turn ends is withdrawn, never left for a later turn.
      await this.withdrawWaiting(l, 'turn_ended');
    }
  }

  /** After a restart: whatever Claude Code wrote comes in from its transcript. */
  private async recover(
    cp: ClaudeCodeCheckpoint,
    emit: (e: RunEventInput) => Promise<unknown>,
  ): Promise<RunOutcome> {
    log.warn(
      { thread_id: cp.threadId },
      'a Claude Code turn was cut off by a restart; reading its transcript',
    );
    await this.deps.threads.discardMessages([cp.assistantMessageId]);
    await this.deps.threads.patchThread(cp.threadId, { active_head_id: cp.userMessageId });
    const sid = cp.finalSessionId ?? cp.sessionId;
    const info = await this.deps.sessionInfo(sid).catch(() => null);
    if (info) await this.deps.service.syncSession(info, undefined, { force: true }).catch(() => undefined);
    await emit({
      type: 'warning',
      code: 'claude_code.recovered',
      message:
        'NVX Ancile restarted during this turn. What Claude Code wrote was brought in from its session.',
    });
    return { kind: 'done' };
  }

  /** Write the answer with the import mapping, add citations, account for usage. */
  private async finish(
    l: Live,
    turn: Turn,
    emit: (e: RunEventInput) => Promise<unknown>,
    stopped: boolean,
  ): Promise<RunOutcome> {
    const { cp } = turn;
    const sessionId = turn.sessionId ?? l.sessionId ?? cp.sessionId;
    cp.finalSessionId = sessionId;
    const { threads } = this.deps;

    // Engines: the fresh session now holds NVX Ancile's summary.
    if (cp.fresh && cp.seedSummaryId && sessionId !== cp.sessionId && this.deps.engines)
      await this.deps.engines
        .seen({
          workspaceId: cp.workspaceId,
          threadId: cp.threadId,
          sessionId,
          summaryId: cp.seedSummaryId,
        })
        .catch((err: unknown) =>
          log.warn({ err: (err as Error).message }, 'could not record that a session holds the summary'),
        );
    // A fork is a session of its own, bound to the same thread.
    if (sessionId !== cp.sessionId) {
      const existing = (await this.deps.store.sessions(this.deps.workspaceId)).find(
        (b) => b.session_id === sessionId,
      );
      if (!existing)
        await this.deps.store.putSession(this.deps.workspaceId, {
          session_id: sessionId,
          thread_id: cp.threadId,
          title: null,
          cwd: cp.cwd,
          last_modified: 0,
          synced_at: new Date(this.now()).toISOString(),
          mapper_version: MAPPER_VERSION,
        });
      await threads.updateMessage(cp.userMessageId, {
        provenance: { claude_code: { session_id: sessionId, uuid: cp.promptUuid, uuids: [cp.promptUuid] } },
      });
      // A thread started in NVX Ancile, or one whose folder was changed: the session Claude Code
      // just started is the thread's own.
      if ((isPendingSession(cp.sessionId) || cp.rebind) && !isPendingSession(sessionId)) {
        const t = await threads.getThread(cp.threadId);
        const bound = t?.settings.claude_code;
        if (bound && (isPendingSession(bound.session_id) || (cp.rebind && bound.fresh_next))) {
          const { fresh_next: _done, ...rest } = bound;
          await threads.patchThread(cp.threadId, {
            settings: { claude_code: { ...rest, session_id: sessionId } },
          });
        }
      }
    }

    const mirror = await this.deps.store.mirror(cp.threadId);
    const plan = planSync(turn.entries, mirror, () => `msg_${ulid()}`, cp.userMessageId);
    await this.adoptCommand(cp, plan, sessionId);
    // The first answer under the prompt is the message the run has been streaming into.
    const first = plan.planned.find(
      (p) => !p.extends && p.role === 'assistant' && p.parent_id === cp.userMessageId,
    );
    if (first) {
      const old = first.id;
      first.id = cp.assistantMessageId;
      for (const p of plan.planned) if (p.parent_id === old) p.parent_id = cp.assistantMessageId;
      if (plan.head === old) plan.head = cp.assistantMessageId;
    }

    const result = turn.result;
    const total = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
    const turnCost = total !== null ? Math.max(0, total - l.costSoFar) : null;
    if (total !== null) l.costSoFar = total;

    let retrieval: Record<string, unknown> = {};
    const status: 'complete' | 'stopped' | 'error' = stopped
      ? 'stopped'
      : turn.error && !result
        ? 'error'
        : result?.is_error === true && !stopped
          ? 'error'
          : 'complete';
    const newRows: NewMessage[] = [];
    let main: { parts: Part[]; usage: Usage | null } | null = null;
    const raws = plan.planned.flatMap((p) => p.raws ?? []);
    if (raws.length) await this.deps.service.keepUnknown?.(cp.threadId, sessionId, raws);
    for (const p of plan.planned) {
      if (p.extends) continue;
      // Written by this turn, not brought in from the transcript (the Why panel tells them apart).
      const ccProv: CcProvenance = { ...provenanceOf(sessionId, p), live: true };
      if (p.id === cp.assistantMessageId) {
        let parts = p.parts;
        if (turn.passages.length) {
          const trace: RetrievalTrace = {
            query: '',
            notebook_id: cp.notebookId ?? '',
            mode: 'hybrid',
            embedder: '',
            ms: 0,
            hits: turn.passages.map(({ marker, hit }) => ({
              marker,
              kind: hit.kind,
              chunk_id: hit.chunk_id,
              source_id: hit.source_id,
              source_title: hit.source_title,
              page: hit.page,
              score: hit.score,
              rerank_score: hit.rerank_score,
              ranks: hit.ranks,
              cited: false,
            })),
            invalid_markers: 0,
            grounded: false,
          };
          const spans = new Map(
            turn.passages.map(({ marker, hit }) => [
              marker,
              { char_start: hit.char_start, char_end: hit.char_end, text: hit.text },
            ]),
          );
          const checked = applyCitations(parts, trace, spans);
          parts = checked.parts;
          retrieval = { retrieval: checked.trace };
          for (const part of parts)
            if (part.type === 'citation_ref')
              await emit({ type: 'citation', message_id: cp.assistantMessageId, part });
        }
        const usage: Usage | null = p.usage
          ? { ...p.usage, cost_usd: turnCost ?? 0 }
          : turnCost !== null
            ? { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: turnCost }
            : null;
        main = { parts, usage };
        await threads.updateMessage(cp.assistantMessageId, {
          parts,
          status,
          model_id: p.model_id,
          usage,
          provenance: {
            model_name: CC_MODEL_NAME,
            claude_code: {
              ...ccProv,
              ...(turnCost !== null && {
                cost_estimate: {
                  usd: turnCost,
                  note: "Claude Code's own estimate at API list prices; not what your account is billed.",
                },
              }),
            },
            ...retrieval,
            ...(cp.engineContext && { engine_context: cp.engineContext }),
            ...(turn.error &&
              status === 'error' && {
                error: {
                  code: 'claude_code.live_failed',
                  title: ccErrors.liveFailed(turn.error).title,
                  hint: ccErrors.liveFailed(turn.error).hint,
                },
              }),
          },
        });
        continue;
      }
      newRows.push({
        id: p.id,
        thread_id: cp.threadId,
        parent_id: p.parent_id,
        role: p.role,
        parts: p.parts,
        status: 'complete',
        model_id: p.model_id,
        usage: p.usage,
        provenance: { claude_code: ccProv },
        created_at: p.created_at ?? new Date(this.now()).toISOString(),
        trace_id: turn.traceId,
      });
    }
    if (newRows.length) await threads.insertMessages(newRows);
    if (!first) {
      // Nothing to show under the prompt (a command Claude Code answered elsewhere, or a stop before any reply).
      await threads.discardMessages([cp.assistantMessageId]);
    }
    await threads.patchThread(cp.threadId, {
      active_head_id: plan.head ?? (first ? cp.assistantMessageId : cp.userMessageId),
    });
    if (main?.usage) await emit({ type: 'usage', message_id: cp.assistantMessageId, usage: main.usage });

    // Anything else Claude Code wrote (a compaction, a hook's note) comes in by the usual sync; nothing twice.
    const info = isPendingSession(sessionId)
      ? null
      : await this.deps.sessionInfo(sessionId).catch(() => null);
    if (info)
      await this.deps.service
        .syncSession(info, undefined, { force: true, threadId: cp.threadId })
        .catch((err: unknown) =>
          log.warn({ err: (err as Error).message }, 'could not sync a session after a live turn'),
        );

    if (status === 'stopped') return { kind: 'cancelled' };
    if (status === 'error') {
      const e = ccErrors.liveFailed(turn.error ?? String(result?.subtype ?? 'error'));
      const error = { code: e.code, title: e.title, hint: e.hint };
      await emit({ type: 'error', ...error, attempts: [] });
      return { kind: 'failed', error };
    }
    if (first && cp.notebookId && this.deps.afterAnswer) {
      const nb = await this.deps.notebook(cp.notebookId).catch(() => null);
      if (nb?.grounded)
        await this.deps
          .afterAnswer({
            messageId: cp.assistantMessageId,
            notebookId: cp.notebookId,
            workspaceId: cp.workspaceId,
          })
          .catch((err: unknown) => log.warn({ err: (err as Error).message }, 'could not start a fact-check'));
    }
    return { kind: 'done' };
  }

  /* ---- events from the bridge -------------------------------------------- */

  private async onEvent(e: LiveEvent): Promise<void> {
    if (e.event === 'bridge.closed') {
      for (const l of this.lives.values()) {
        if (l.handle) this.byHandle.delete(l.handle);
        l.handle = null;
        l.sessionId = null;
        l.state = 'idle';
        if (l.turn && !l.turn.result) {
          l.turn.error = 'The Claude bridge stopped';
          l.turn.settle?.();
        }
      }
      return;
    }
    const l = this.byHandle.get(e.data.handle);
    if (!l) {
      if (this.deps.foreignHandle?.(e.data.handle)) return;
      if (e.event === 'session.permission')
        await this.deps.bridge
          .reply(e.data.handle, e.data.request_id, {
            behavior: 'deny',
            message: 'NVX Ancile is not running this session',
          })
          .catch(() => undefined);
      return;
    }
    if (e.event === 'session.state') {
      if (e.data.session_id) l.sessionId = e.data.session_id;
      if (e.data.state === 'closed') {
        this.byHandle.delete(e.data.handle);
        l.handle = null;
        l.state = 'idle';
        if (l.turn && !l.turn.result) {
          l.turn.error = e.data.error ?? 'Claude Code closed the session';
          l.turn.settle?.();
        }
      }
      return;
    }
    if (e.event === 'session.permission') {
      await this.onPermission(l, e.data);
      return;
    }
    await this.onMessage(l, e.data.message);
  }

  private emitFor(t: Turn, e: RunEventInput) {
    return this.deps.events.append(t.runId, e);
  }

  private async onMessage(l: Live, m: Record<string, unknown>): Promise<void> {
    const sid = typeof m.session_id === 'string' && m.session_id ? m.session_id : null;
    if (sid) {
      l.sessionId = sid;
      this.ownWrites.set(sid, this.now());
    }
    if (m.type === 'rate_limit_event') {
      await this.deps.limits?.observe(m).catch(() => undefined);
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      if (typeof m.model === 'string') l.model = m.model;
      if (typeof m.permissionMode === 'string') l.permissionMode = m.permissionMode;
    }
    const t = l.turn;
    if (!t) return;
    if (sid) t.sessionId = sid;
    const top = m.parent_tool_use_id === null || m.parent_tool_use_id === undefined;
    const msgId = t.cp.assistantMessageId;
    switch (m.type) {
      case 'stream_event': {
        if (!top || !isObj(m.event)) return;
        const ev = m.event;
        if (ev.type === 'message_start' && isObj(ev.message)) {
          const api = typeof ev.message.id === 'string' ? ev.message.id : null;
          t.blocks.clear();
          t.streamingApi = api;
          if (api) this.modelSpan(t, api, typeof ev.message.model === 'string' ? ev.message.model : null);
        } else if (
          ev.type === 'content_block_start' &&
          typeof ev.index === 'number' &&
          isObj(ev.content_block)
        ) {
          t.blocks.set(ev.index, String(ev.content_block.type));
        } else if (ev.type === 'content_block_delta' && isObj(ev.delta)) {
          const d = ev.delta;
          if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
            if (t.streamingApi) t.streamed.add(t.streamingApi);
            await this.emitFor(t, { type: 'text.delta', message_id: msgId, delta: d.text });
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
            if (t.streamingApi) t.streamed.add(t.streamingApi);
            await this.emitFor(t, { type: 'reasoning.delta', message_id: msgId, delta: d.thinking });
          }
        }
        return;
      }
      case 'assistant': {
        if (!top) return;
        const entry = this.entryOf(m);
        if (!entry) return;
        t.entries.push(entry);
        const msg = isObj(m.message) ? m.message : {};
        const api = typeof msg.id === 'string' ? msg.id : null;
        if (api) this.modelSpan(t, api, typeof msg.model === 'string' ? msg.model : null, msg.usage);
        const content = Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
        for (const b of content) {
          if (b.type === 'text' && typeof b.text === 'string' && !(api && t.streamed.has(api)))
            await this.emitFor(t, { type: 'text.delta', message_id: msgId, delta: b.text });
          else if (b.type === 'thinking' && typeof b.thinking === 'string' && !(api && t.streamed.has(api)))
            await this.emitFor(t, { type: 'reasoning.delta', message_id: msgId, delta: b.thinking });
          else if (
            (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') &&
            typeof b.id === 'string'
          ) {
            if (t.calls.has(b.id)) continue;
            t.calls.add(b.id);
            const name = String(b.name ?? 'tool');
            if (!t.toolInputs.has(b.id)) t.toolInputs.set(b.id, { name, input: b.input });
            const mapped = this.map(l, name, b.input);
            await this.emitFor(t, {
              type: 'tool.call',
              call_id: b.id,
              tool: name,
              args_preview: b.input ?? {},
              tier: mapped.tier,
            });
            const span = startSpan(
              `tool ${name}`,
              'internal',
              { tool: name, call_id: b.id, action: mapped.action },
              { parent: t.parent },
            );
            const known = t.toolSpans.get(b.id);
            t.toolSpans.set(b.id, { span, ...(known?.asked !== undefined && { asked: known.asked }) });
          }
        }
        return;
      }
      case 'user': {
        if (!top || m.isReplay === true || m.uuid === t.cp.promptUuid) return;
        const entry = this.entryOf(m);
        if (!entry) return;
        t.entries.push(entry);
        const msg = isObj(m.message) ? m.message : {};
        const content = Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
        for (const b of content) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const ok = b.is_error !== true;
          await this.emitFor(t, {
            type: 'tool.result',
            call_id: b.tool_use_id,
            ok,
            preview: preview(b.content),
          });
          const s = t.toolSpans.get(b.tool_use_id);
          s?.span.end(ok ? 'ok' : 'error');
          t.toolSpans.delete(b.tool_use_id);
          const ran = t.toolInputs.get(b.tool_use_id);
          if (ran && this.deps.engines?.toolDone)
            void this.deps.engines
              .toolDone({
                threadId: l.threadId,
                notebookId: l.notebookId,
                runId: t.runId,
                messageId: msgId,
                cwd: l.cwd,
                tool: ran.name,
                input: ran.input,
                ok,
              })
              .catch(() => undefined);
        }
        return;
      }
      case 'result':
        t.result = m;
        t.modelSpan?.span.end('ok');
        t.modelSpan = null;
        t.settle?.();
        if (l.handle) this.deps.limits?.afterTurn(l.handle);
        return;
      default:
        return;
    }
  }

  private modelSpan(t: Turn, api: string, model: string | null, usage?: unknown) {
    if (t.modelSpan?.api !== api) {
      t.modelSpan?.span.end('ok');
      t.modelSpan = {
        api,
        span: startSpan(
          `model claude-code/${model ?? 'default'}`,
          'client',
          { model: model ?? 'default', api_id: api },
          { parent: t.parent },
        ),
      };
    }
    if (isObj(usage)) {
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      t.modelSpan.span.set({
        input_tokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens),
        output_tokens: n(usage.output_tokens),
        cached_tokens: n(usage.cache_read_input_tokens),
      });
    }
  }

  private entryOf(m: Record<string, unknown>): CcSessionMessage | null {
    if (typeof m.uuid !== 'string' || (m.type !== 'user' && m.type !== 'assistant')) return null;
    return {
      type: m.type,
      uuid: m.uuid,
      session_id: typeof m.session_id === 'string' ? m.session_id : '',
      message: m.message,
      parent_tool_use_id: null,
      timestamp: typeof m.timestamp === 'string' ? m.timestamp : new Date(this.now()).toISOString(),
      ...(m.isCompactSummary === true && { isCompactSummary: true }),
      ...(m.isSynthetic === true && { is_meta: true }),
    };
  }

  private map(l: Live, name: string, input: unknown): MappedTool {
    const tools = this.deps.tools;
    return mapTool(name, input, {
      cwd: l.cwd,
      notebookId: l.notebookId,
      workspaceId: l.workspaceId,
      ...(tools && { hosted: (n: string) => hostedTool(tools, n) }),
    });
  }

  /* ---- permissions --------------------------------------------------------- */

  private async reply(l: Live, ask: LivePermissionAsk, r: LivePermissionReply) {
    if (!l.handle) return;
    await this.deps.bridge
      .reply(ask.handle, ask.request_id, r)
      .catch((err: unknown) =>
        log.warn({ err: (err as Error).message }, 'could not give Claude Code its answer'),
      );
  }

  private async onPermission(l: Live, ask: LivePermissionAsk): Promise<void> {
    const t = l.turn;
    if (!t) {
      await this.reply(l, ask, { behavior: 'deny', message: 'No turn is running in NVX Ancile' });
      return;
    }
    const mapped = this.map(l, ask.tool_name, ask.input);
    const callId = ask.tool_use_id ?? ask.request_id;
    const gate = this.deps.gateFor(gateRoot(l.cwd));
    const decision = await gate.check({
      userId: this.deps.userId,
      principal: CLAUDE_CODE_PRINCIPAL,
      action: mapped.action,
      resource: mapped.resource,
      toolTier: mapped.tier,
      destructive: mapped.destructive,
      scope: { threadId: l.threadId, notebookId: l.notebookId, workspaceId: l.workspaceId },
      runId: t.runId,
      traceId: t.traceId,
      tool: ask.tool_name,
      args: ask.input,
      callId,
    });
    const span = t.toolSpans.get(callId)?.span;
    span?.set({ decision: decision.outcome, tier: decision.tier, resource: decision.resource });
    if (decision.outcome === 'allow') {
      if (mapped.hosted) this.deps.passes?.grant(mapped.hosted);
      await this.reply(l, ask, { behavior: 'allow' });
      return;
    }
    if (decision.outcome === 'deny') {
      const why =
        decision.via === 'policy'
          ? `A policy blocks this (${decision.policyId ?? 'policy'}).`
          : decision.reason;
      await this.reply(l, ask, { behavior: 'deny', message: why });
      return;
    }
    const approval = await this.deps.permissions.createApproval({
      runId: t.runId,
      stepSeq: t.seq++,
      threadId: l.threadId,
      callId,
      principal: CLAUDE_CODE_PRINCIPAL,
      tool: ask.tool_name,
      action: mapped.action,
      resource: decision.resource,
      args: ask.input ?? {},
      argsPreview: ask.input ?? {},
      tier: decision.tier,
      suggestions: decision.tier === 'critical' ? [] : decision.suggestions,
      expiresAt: new Date(this.now() + (this.deps.approvalTtlMs ?? APPROVAL_TTL_MS)).toISOString(),
    });
    this.waiting.set(approval.id, { live: l, ask, mapped, askedAt: this.now(), runId: t.runId });
    const ts = t.toolSpans.get(callId);
    if (ts) ts.asked = this.now();
    else
      t.toolSpans.set(callId, {
        span: startSpan(
          `tool ${ask.tool_name}`,
          'internal',
          { tool: ask.tool_name, call_id: callId },
          { parent: t.parent },
        ),
        asked: this.now(),
      });
    await this.emitFor(t, {
      type: 'approval.required',
      approval_id: approval.id,
      tool: ask.tool_name,
      action: mapped.action,
      resource: decision.resource,
      tier: decision.tier,
      call_id: callId,
      args_preview: approval.args_preview,
      suggestions: approval.suggestions,
    });
    await this.deps.bus
      ?.publish({
        type: 'approval.requested',
        approval_id: approval.id,
        run_id: t.runId,
        tool: ask.tool_name,
        tier: decision.tier,
      })
      .catch(() => undefined);
  }

  /**
   * Withdraw the questions a thread's session is waiting on: its turn
   * ended, or the model changed while they waited. Each is cancelled (so
   * it can never be answered later), every window's dialog closes, and a
   * turn still running hears that it was withdrawn. Returns how many.
   */
  private async withdrawWaiting(l: Live, why: 'turn_ended' | 'model_changed'): Promise<number> {
    let n = 0;
    for (const [id, w] of [...this.waiting]) {
      if (w.live !== l) continue;
      this.waiting.delete(id);
      n++;
      await this.deps.permissions.resolveApproval(id, { status: 'cancelled' }).catch(() => false);
      await this.deps.events
        .append(w.runId, { type: 'approval.resolved', approval_id: id, decision: 'cancelled' })
        .catch(() => undefined);
      await this.deps.bus?.publish({ type: 'approval.resolved', approval_id: id }).catch(() => undefined);
      if (why === 'model_changed' && l.turn?.runId === w.runId)
        await this.reply(l, w.ask, {
          behavior: 'deny',
          message: 'The model for this thread changed while this was waiting, so the request was withdrawn.',
        });
    }
    if (n)
      log.info(
        { thread_id: l.threadId, approvals: n, why },
        'withdrew approvals a Claude Code turn was waiting on',
      );
    return n;
  }

  /** The person chose another model while a turn waits on approvals: they are withdrawn. */
  async modelChanged(threadId: string): Promise<{ withdrawn: number }> {
    const thread = await this.thread(threadId);
    const l = this.lives.get(thread.id);
    return { withdrawn: l ? await this.withdrawWaiting(l, 'model_changed') : 0 };
  }

  /** Is this approval one a live session is waiting on (so its arguments may be edited)? */
  editable(a: ApprovalRecord): boolean {
    return a.principal === CLAUDE_CODE_PRINCIPAL && this.waiting.has(a.id);
  }

  /** Check edited arguments again before they are approved. */
  async recheck(a: ApprovalRecord, args: unknown) {
    const w = this.waiting.get(a.id);
    if (!w) throw notFound('That approval');
    const mapped = this.map(w.live, w.ask.tool_name, args);
    return this.deps.gateFor(gateRoot(w.live.cwd)).check({
      userId: this.deps.userId,
      principal: CLAUDE_CODE_PRINCIPAL,
      action: mapped.action,
      resource: mapped.resource,
      toolTier: mapped.tier,
      destructive: mapped.destructive,
      scope: { threadId: w.live.threadId, notebookId: w.live.notebookId, workspaceId: w.live.workspaceId },
      runId: a.run_id,
      traceId: currentContext()?.traceId ?? newTraceId(),
    });
  }

  /** A person answered an approval (or it expired): tell Claude Code. */
  async resolved(
    a: ApprovalRecord,
    status: 'approved' | 'denied' | 'expired' | 'cancelled',
    reason?: string | null,
    updatedArgs?: unknown,
  ): Promise<boolean> {
    const w = this.waiting.get(a.id);
    if (!w) return false;
    this.waiting.delete(a.id);
    const t = w.live.turn;
    // Its turn is over (or another one is running): an answer now is for nobody.
    if (t?.runId !== w.runId) return true;
    const span = t?.toolSpans.get(a.call_id ?? '');
    span?.span.set({
      approval: status,
      approval_wait_ms: this.now() - w.askedAt,
      ...(updatedArgs !== undefined && { edited: true }),
    });
    if (status === 'approved') {
      if (w.mapped.hosted) this.deps.passes?.grant(w.mapped.hosted);
      if (t && isObj(updatedArgs) && a.call_id)
        t.toolInputs.set(a.call_id, { name: w.ask.tool_name, input: updatedArgs });
      await this.reply(w.live, w.ask, {
        behavior: 'allow',
        ...(isObj(updatedArgs) && { updated_input: updatedArgs }),
      });
      return true;
    }
    await this.reply(w.live, w.ask, {
      behavior: 'deny',
      message:
        status === 'expired'
          ? 'Nobody answered in time'
          : status === 'cancelled'
            ? 'The request was withdrawn'
            : reason?.trim() || 'The user declined this.',
    });
    return true;
  }

  /**
   * A slash command sent from NVX Ancile: Claude Code records it as its own
   * command entry, not as the prompt NVX Ancile already wrote, so the sync
   * would add it a second time. The message the person sent becomes that
   * command message instead (its entries, its folded output), and whatever
   * hung off the copy hangs off it.
   */
  private async adoptCommand(
    cp: ClaudeCodeCheckpoint,
    plan: ReturnType<typeof planSync>,
    sessionId: string,
  ): Promise<void> {
    const typed = cp.text.trim();
    if (!/^[/!]/.test(typed)) return;
    const name = typed.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    const cmd = plan.planned.find(
      (p) =>
        !p.extends &&
        p.role === 'user' &&
        p.kind === 'command' &&
        (p.command?.name.toLowerCase() === name || (name.startsWith('!') && p.command?.name === '!')),
    );
    if (!cmd) return;
    const prov = provenanceOf(sessionId, cmd);
    await this.deps.threads.updateMessage(cp.userMessageId, {
      parts: cmd.parts,
      provenance: {
        claude_code: { ...prov, uuids: [cp.promptUuid, ...prov.uuids] } satisfies CcProvenance,
      },
    });
    plan.planned = plan.planned.filter((p) => p !== cmd);
    for (const p of plan.planned) if (p.parent_id === cmd.id) p.parent_id = cp.userMessageId;
    if (plan.head === cmd.id) plan.head = cp.userMessageId;
  }

  /* ---- interrupt, state, commands ------------------------------------------ */

  async interrupt(threadId: string): Promise<{ interrupted: boolean }> {
    const thread = await this.thread(threadId);
    const l = this.lives.get(thread.id);
    if (!l?.turn || !l.handle) throw ccErrors.notLive();
    l.turn.stopped = true;
    await this.deps.bridge.interrupt(l.handle);
    return { interrupted: true };
  }

  /** Is a run of this thread the one a live turn is running? (Stop on the run interrupts it too.) */
  runOf(threadId: string): string | null {
    return this.lives.get(threadId)?.turn?.runId ?? null;
  }

  async state(threadId: string): Promise<ClaudeCodeLiveState> {
    const thread = await this.thread(threadId);
    const cc = thread.settings.claude_code;
    const l = this.lives.get(thread.id);
    let context: ClaudeCodeLiveState['context'] = null;
    if (l?.handle) {
      const u = await this.deps.bridge
        .control<{
          total_tokens: number;
          max_tokens: number;
          percentage: number;
          compacts_at?: number | null;
        }>(l.handle, 'context_usage')
        .catch(() => null);
      if (u && typeof u.max_tokens === 'number')
        context = {
          used_tokens: Math.round(u.total_tokens),
          max_tokens: Math.round(u.max_tokens),
          percent: u.percentage,
          compacts_at: typeof u.compacts_at === 'number' ? u.compacts_at : null,
        };
    }
    const held = cc?.session_id ? await this.heldElsewhere(cc.session_id, cc.cwd) : null;
    const noFiles = cc?.no_files === true;
    return {
      state: l?.turn ? 'working' : (l?.state ?? 'idle'),
      locked_elsewhere: held !== null,
      open_in_terminal: held === 'process',
      folder_missing: !!cc?.cwd && !noFiles && !(await this.folderThere(cc.cwd)),
      no_files: noFiles,
      model: l?.model ?? null,
      effort: l?.effort ?? null,
      permission_mode: l?.permissionMode ?? null,
      cwd: cc?.cwd ?? null,
      context,
    };
  }

  /**
   * The "/" list: Claude Code's own (read from a session opened without a
   * prompt and without a transcript, so it spends nothing), merged with
   * what NVX Ancile does itself. Cached per folder and Claude Code version.
   * Never makes the composer wait: until Claude Code's list has been read,
   * the built-ins come back at once marked partial and the read goes on in
   * the background (`wait` waits for it, for tests and scripts).
   */
  async commands(threadId: string, opts: { wait?: boolean } = {}): Promise<CommandList> {
    const thread = await this.thread(threadId);
    const cwd = thread.settings.claude_code?.no_files
      ? await this.noFilesDir()
      : thread.settings.claude_code?.cwd;
    if (!cwd) throw ccErrors.noFolder();
    const cli = await this.deps.service.cliPath();
    const key = `${cli.version}|${cwd}`;
    const load = () => this.readCommands(thread.id, cwd, cli.path);
    if (opts.wait) {
      const items = await this.commandCatalogue.warm(key, load);
      if (items) return { items, partial: false };
    }
    return this.commandCatalogue.read(key, load);
  }

  /**
   * Read the lists ahead of time for the folders of the most recent Claude
   * Code threads, one at a time, so the first "/" in them is already full.
   * Quietly does nothing when Claude Code is not installed.
   */
  async warmCommands(opts: { folders?: number } = {}): Promise<number> {
    let cli: { path: string; version: string };
    try {
      cli = await this.deps.service.cliPath();
    } catch {
      return 0;
    }
    const recent = await this.deps.threads.listThreads(this.deps.workspaceId, { limit: 50 });
    const cwds = [
      ...new Set(recent.flatMap((t) => (t.settings.claude_code?.cwd ? [t.settings.claude_code.cwd] : []))),
    ].slice(0, opts.folders ?? 2);
    let warmed = 0;
    for (const cwd of cwds) {
      if (this.deps.folderExists && !(await this.deps.folderExists(cwd))) continue;
      const items = await this.commandCatalogue.warm(`${cli.version}|${cwd}`, () =>
        this.readCommands(null, cwd, cli.path),
      );
      if (items) warmed++;
    }
    return warmed;
  }

  private async readCommands(
    threadId: string | null,
    cwd: string,
    cliPath: string,
  ): Promise<ClaudeCodeCommand[]> {
    const open = (threadId && this.lives.get(threadId)?.handle) || null;
    let handle = open;
    if (!handle)
      handle = (
        await this.deps.bridge.open({
          cwd,
          path_to_cli: cliPath,
          persist: false,
          permission_mode: 'default',
          env: await this.deps.service.cliEnv(),
        })
      ).handle;
    try {
      const [list, models, mcp] = await Promise.all([
        this.deps.bridge.control<CliCommand[]>(handle, 'supported_commands'),
        this.deps.bridge
          .control<{ value: string; displayName?: string }[]>(handle, 'supported_models')
          .catch(() => []),
        this.deps.bridge.control<{ name: string }[]>(handle, 'mcp_status').catch(() => []),
      ]);
      return dedupeCommands(
        mergeCommands(Array.isArray(list) ? dedupeCliCommands(list) : [], {
          models: Array.isArray(models) ? models : [],
          mcp: Array.isArray(mcp) ? mcp.map((s) => s.name).filter((n) => typeof n === 'string') : [],
        }),
      );
    } finally {
      if (!open) await this.deps.bridge.close(handle).catch(() => undefined);
    }
  }

  /* ---- for the MCP server -------------------------------------------------- */

  /** Number a search's passages on from the turn's earlier ones, and keep them for citations. */
  passages(threadId: string, hits: SearchHit[]): Passage[] | null {
    const t = this.lives.get(threadId)?.turn;
    if (!t) return null;
    const out: Passage[] = [];
    for (const hit of hits) {
      const known = t.passages.find((p) => p.hit.chunk_id === hit.chunk_id);
      if (known) {
        out.push(known);
        continue;
      }
      const p = { marker: t.passages.length + 1, hit };
      t.passages.push(p);
      out.push(p);
    }
    return out;
  }

  traceOf(threadId: string): RequestContext | null {
    return this.lives.get(threadId)?.turn?.parent ?? null;
  }

  sourceIdsOf(threadId: string): string[] | null {
    return this.lives.get(threadId)?.turn?.cp.sourceIds ?? null;
  }

  /** A live session's handle, if any is open (the plan-limits report can be asked on it). */
  openHandle(): string | null {
    for (const h of this.byHandle.keys()) return h;
    return null;
  }

  /** For tests and the health view. */
  get open(): number {
    return this.byHandle.size;
  }
}
