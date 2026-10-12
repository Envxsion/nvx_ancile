/**
 * ------------------------------------------------------------------
 *  Title    |  Activity: what is running
 *  Ref      |  docs/activity.md · packages/contracts/src/activity.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One read-only answer to "what is going on right now":
 *           |  NVX Ancile's durable runs with their progress, Claude
 *           |  Code sessions open elsewhere, subagents still working
 *           |  and background shells, each pointing at its thread.
 *  How      |  list() gathers, on request:
 *           |  - runs not finished (the run store), with the last step
 *           |    or progress event each one wrote;
 *           |  - Claude Code sessions a terminal holds (holders.ts) or
 *           |    written in the last minute by someone other than NVX
 *           |    Ancile (a live turn here is a run already);
 *           |  - from the transcripts of sessions held, live here, or
 *           |    written in the last SCAN_WINDOW_MS: subagents with no
 *           |    result yet, and background shells (inflight.ts).
 *           |    Finished shells stay listed for SHOW_FINISHED_MS.
 *           |  The running count is published as `activity.changed`
 *           |  whenever it moves: after run and Claude Code events, and
 *           |  on a slow tick while anything could be running.
 *  Note     |  Never a system process list. Processes are read only to
 *           |  tell which Claude Code sessions a terminal holds, by the
 *           |  existing read-only look (holders.ts). Typing is a hint
 *           |  the Cockpit sends while a background import runs.
 * ------------------------------------------------------------------
 */

import type { ActivityItem, ActivityResponse, ImportProgress, RunStatus } from '@nvx/contracts';
import type { CcSessionInfo } from '../claudecode/bridge-protocol';
import type { HolderQuery, SessionHolder } from '../claudecode/holders';
import type { Inflight } from '../claudecode/inflight';
import { titleOf } from '../claudecode/map';
import type { SessionBinding } from '../claudecode/store';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { RunKind, RunRecord } from '../runs/engine';

const log = logFor('activity');

/** A session written this recently by someone else is open elsewhere. */
export const ACTIVE_ELSEWHERE_MS = 60_000;
/** Transcripts written this recently are read for subagents and shells. */
export const SCAN_WINDOW_MS = 15 * 60_000;
/** A shell the transcript says finished stays listed this long. */
export const SHOW_FINISHED_MS = 10 * 60_000;
/** The slow tick that keeps the status bar's count honest. */
export const TICK_MS = 30_000;
/** At most this many transcripts are read for one answer (the newest). */
const SCAN_MAX = 24;

const ACTIVE: RunStatus[] = ['queued', 'running', 'waiting_approval', 'waiting_compute'];

const RUN_TITLES: Record<RunKind, string> = {
  chat_turn: 'Answer',
  agent: 'Agent turn',
  research: 'Research',
  factcheck: 'Fact-check',
  automation: 'Automation',
  diagnostic: 'Diagnostic',
  flow_try: 'Flow in the lab',
  claude_code: 'Claude Code turn',
};

export interface RunProgress {
  /** The step it is on, in its own words ("Searching sources"). */
  label: string | null;
  done?: number;
  total?: number;
}

export interface ActivityClaude {
  /** Is Claude Code on this computer (nothing to look at otherwise)? */
  installed(): boolean;
  /** Sessions, newest first (the service's cached listing). */
  sessions(): Promise<CcSessionInfo[]>;
  bindings(): Promise<SessionBinding[]>;
  heldSessions(q: HolderQuery[]): Promise<Map<string, SessionHolder>>;
  /** A live turn in NVX Ancile is writing it now. */
  isLive(sessionId: string): boolean;
  /** When NVX Ancile itself last wrote it (ms), or null. */
  ownWriteAt(sessionId: string): number | null;
  /** The session's transcript, or null. */
  transcript(sessionId: string): Promise<string | null>;
  scan(path: string): Promise<Inflight | null>;
  /** message id for a transcript entry, in a thread. */
  messageFor(threadId: string, entryUuid: string): Promise<string | null>;
  importProgress(): ImportProgress | null;
  excluded(cwd: string | null): Promise<boolean>;
}

export interface ActivityDeps {
  runs: { withStatus(status: RunStatus, limit?: number): Promise<RunRecord[]> };
  runProgress?: (runIds: string[]) => Promise<Map<string, RunProgress>>;
  threadTitle: (threadId: string) => Promise<string | null>;
  claude?: ActivityClaude;
  bus?: EventBus;
  now?: () => number;
  tickMs?: number;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const folderName = (cwd: string | null | undefined) =>
  cwd
    ? (cwd
        .split(/[\\/]+/)
        .filter(Boolean)
        .at(-1) ?? cwd)
    : null;

function blank(id: string, kind: ActivityItem['kind'], title: string): ActivityItem {
  return {
    id,
    kind,
    title,
    detail: null,
    state: 'running',
    started_at: null,
    updated_at: null,
    finished_at: null,
    thread_id: null,
    thread_title: null,
    message_id: null,
    run_kind: null,
    run_status: null,
    progress: null,
    session_id: null,
    project: null,
    held: null,
  };
}

export class ActivityService {
  private readonly now: () => number;
  private lastCount: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private typingUntil = 0;
  private readonly titles = new Map<string, { at: number; title: string | null }>();

  constructor(private readonly deps: ActivityDeps) {
    this.now = deps.now ?? Date.now;
  }

  /* ---- typing ------------------------------------------------------------ */

  /** The person is typing: background work waits about `ms` more. */
  typing(ms = 2_500): void {
    this.typingUntil = Math.max(this.typingUntil, this.now() + Math.min(Math.max(ms, 0), 10_000));
  }

  isTyping(): boolean {
    return this.now() < this.typingUntil;
  }

  /* ---- the list -------------------------------------------------------- */

  async list(): Promise<ActivityResponse> {
    const [runs, cc] = await Promise.all([
      this.runItems(),
      this.claudeItems().catch((err: unknown) => {
        log.warn({ err: (err as Error).message }, 'could not read Claude Code activity');
        return [] as ActivityItem[];
      }),
    ]);
    const items = [...runs, ...cc];
    const running = items.filter((i) => i.state === 'running' || i.state === 'waiting').length;
    return {
      items,
      running,
      import: this.deps.claude?.importProgress() ?? null,
      at: new Date(this.now()).toISOString(),
    };
  }

  private async title(threadId: string | null): Promise<string | null> {
    if (!threadId) return null;
    const hit = this.titles.get(threadId);
    if (hit && this.now() - hit.at < 30_000) return hit.title;
    const title = await this.deps.threadTitle(threadId).catch(() => null);
    this.titles.set(threadId, { at: this.now(), title });
    if (this.titles.size > 500) this.titles.delete(this.titles.keys().next().value as string);
    return title;
  }

  private async runItems(): Promise<ActivityItem[]> {
    const lists = await Promise.all(ACTIVE.map((s) => this.deps.runs.withStatus(s, 200)));
    const runs = lists.flat();
    if (!runs.length) return [];
    const progress = this.deps.runProgress
      ? await this.deps.runProgress(runs.map((r) => r.id)).catch(() => new Map<string, RunProgress>())
      : new Map<string, RunProgress>();
    const out: ActivityItem[] = [];
    for (const r of runs) {
      const p = progress.get(r.id);
      const it = blank(`run:${r.id}`, 'run', RUN_TITLES[r.kind] ?? 'Run');
      it.state = r.status === 'running' ? 'running' : 'waiting';
      it.run_kind = r.kind;
      it.run_status = r.status;
      it.started_at = r.createdAt ?? null;
      it.updated_at = r.updatedAt ?? null;
      it.thread_id = r.threadId;
      it.thread_title = await this.title(r.threadId);
      it.message_id = r.messageId;
      it.detail =
        r.status === 'waiting_approval'
          ? 'Waiting for your decision'
          : r.status === 'waiting_compute'
            ? 'Waiting for a GPU node'
            : r.status === 'queued'
              ? 'Queued'
              : (p?.label ?? null);
      if (p?.total) it.progress = { done: Math.min(p.done ?? 0, p.total), total: p.total };
      out.push(it);
    }
    return out.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  }

  private async claudeItems(): Promise<ActivityItem[]> {
    const cc = this.deps.claude;
    if (!cc?.installed()) return [];
    const now = this.now();
    const infos = (await cc.sessions()).filter((s) => !!s.sessionId);
    const recent = infos.filter((s) => now - (s.lastModified ?? 0) < SCAN_WINDOW_MS);
    // Held: one read of the process list for every session (it is cheap per session).
    const held = await cc
      .heldSessions(
        infos.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd ?? null, modifiedMs: s.lastModified })),
      )
      .catch(() => new Map<string, SessionHolder>());
    const bindings = new Map((await cc.bindings()).map((b) => [b.session_id, b]));
    const byId = new Map(infos.map((s) => [s.sessionId, s]));
    const candidates = new Map<string, CcSessionInfo>();
    for (const s of recent) candidates.set(s.sessionId, s);
    for (const id of held.keys()) {
      const s = byId.get(id);
      if (s) candidates.set(id, s);
    }
    for (const s of infos) if (cc.isLive(s.sessionId)) candidates.set(s.sessionId, s);

    const out: ActivityItem[] = [];
    const scanned = [...candidates.values()]
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
      .slice(0, SCAN_MAX);
    for (const s of scanned) {
      if (await cc.excluded(s.cwd ?? null)) continue;
      const b = bindings.get(s.sessionId);
      const threadId = b?.thread_id ?? null;
      const threadTitle = await this.title(threadId);
      const project = folderName(s.cwd);
      const live = cc.isLive(s.sessionId);
      const holder = held.get(s.sessionId);
      const own = cc.ownWriteAt(s.sessionId) ?? 0;
      const writtenElsewhere =
        now - (s.lastModified ?? 0) < ACTIVE_ELSEWHERE_MS && (s.lastModified ?? 0) > own + 5_000;
      const base = (it: ActivityItem) => {
        it.session_id = s.sessionId;
        it.project = project;
        it.thread_id = threadId;
        it.thread_title = threadTitle;
        return it;
      };
      if (!live && (holder || writtenElsewhere)) {
        const it = base(blank(`cc:${s.sessionId}`, 'claude_session', threadTitle ?? titleOf(s)));
        it.held = holder ? 'terminal' : 'recent';
        it.detail = holder ? 'Open in a terminal' : 'Written in the last minute';
        it.updated_at = iso(s.lastModified);
        it.started_at = iso(s.createdAt ?? null);
        out.push(it);
      }
      const path = await cc.transcript(s.sessionId).catch(() => null);
      if (!path) continue;
      const fl = await cc.scan(path).catch(() => null);
      if (!fl) continue;
      for (const a of fl.agents) {
        const it = base(blank(`agent:${s.sessionId}:${a.callId}`, 'subagent', a.description ?? 'Subagent'));
        it.detail = a.agentType ? `Subagent: ${a.agentType}` : 'Subagent';
        it.started_at = a.startedAt;
        it.updated_at = fl.lastAt;
        it.message_id = threadId && a.entryUuid ? await cc.messageFor(threadId, a.entryUuid) : null;
        out.push(it);
      }
      for (const sh of fl.shells) {
        const finishedMs = sh.finishedAt ? Date.parse(sh.finishedAt) : Number.NaN;
        if (sh.state !== 'running' && !(now - finishedMs < SHOW_FINISHED_MS)) continue;
        const it = base(
          blank(`shell:${s.sessionId}:${sh.callId}`, 'shell', sh.command || 'Background shell'),
        );
        it.state = sh.state;
        it.detail = sh.description;
        it.started_at = sh.startedAt;
        it.finished_at = sh.finishedAt;
        it.updated_at = sh.finishedAt ?? fl.lastAt;
        it.message_id = threadId && sh.entryUuid ? await cc.messageFor(threadId, sh.entryUuid) : null;
        out.push(it);
      }
    }
    return out;
  }

  /* ---- the running count, published --------------------------------- */

  /** Listen for what moves the count, and tick slowly. */
  start(): void {
    const bus = this.deps.bus;
    if (!bus) return;
    this.unsubscribe = bus.subscribe(Number.MAX_SAFE_INTEGER, (e) => {
      if (e.type === 'run.updated' || e.type === 'claude_code.changed') this.soon();
    });
    this.timer = setInterval(() => this.soon(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    this.soon();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  /** Count again shortly (events come in bursts). */
  soon(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.publishCount();
    }, 400);
    this.debounce.unref?.();
  }

  /** Publish `activity.changed` when the running count moved. */
  async publishCount(): Promise<number> {
    let running: number;
    try {
      running = (await this.list()).running;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not count what is running');
      return this.lastCount ?? 0;
    }
    if (running !== this.lastCount) {
      this.lastCount = running;
      await this.deps.bus
        ?.publish({ type: 'activity.changed', running })
        .catch((err: unknown) => log.warn({ err }, 'activity.changed not published'));
    }
    return running;
  }
}
