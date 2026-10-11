/**
 * ------------------------------------------------------------------
 *  Title    |  Works with Claude Code
 *  Ref      |  docs/claude-code.md · packages/contracts/src/claudecode.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Everything Core does with the person's own Claude Code:
 *           |  status, install, sign-in in Claude Code's own window,
 *           |  the list of its sessions, and bringing sessions in as
 *           |  threads that stay in step.
 *  How      |  The CLI (cli.ts) answers version and sign-in; sessions
 *           |  are read through the Claude bridge (bridge.ts), a
 *           |  separate program that holds Anthropic's Agent SDK. With
 *           |  Auto-import on (the default) every session comes in by
 *           |  itself: a pass shortly after start, then whenever the
 *           |  projects folder changes. A pass works one session at a
 *           |  time, newest first, writes in chunks and pauses between
 *           |  sessions, so requests are never held up; it resumes
 *           |  from what is stored (each session's last sync). A pass
 *           |  also rebuilds threads made by an older MAPPER_VERSION and
 *           |  gives folder notebooks their colour and icon. A session's
 *           |  full history (every branch, everything before each
 *           |  compaction) comes from its transcript file (transcript.ts),
 *           |  falling back to the SDK's current chain when the file is
 *           |  missing or the reader's checks fail. A session a live turn
 *           |  is writing is left to that turn (claudecode/live.ts),
 *           |  which syncs it when the turn ends. Excluded folders are never
 *           |  listed or imported; what came from them is archived at
 *           |  start and whenever the list changes.
 *  Note     |  Sessions are only ever read: a session open in a
 *           |  terminal keeps syncing and is never written to. Nothing
 *           |  here spawns or downloads at Core boot unless Claude Code
 *           |  is installed and Auto-import is on.
 * ------------------------------------------------------------------
 */

import { existsSync, type FSWatcher, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AncileError,
  type ClaudeCodeProject,
  type ClaudeCodeSession,
  ClaudeCodeSettings,
  type ClaudeCodeStatus,
  type ImportClaudeCodeSessionsRequest,
  type ImportClaudeCodeSessionsResult,
  type Part,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import { currentContext, newTraceId } from '../context';
import type { EventBus } from '../events/bus';
import type { NotebookRepo } from '../notebooks/repo';
import { logFor } from '../obs/logger';
import type { SettingsStore } from '../settings';
import { SETTING } from '../settings';
import type { NewMessage, ThreadRecord, ThreadRepo } from '../threads/repo';
import type { CcSessionInfo, CcSessionMessage, SessionSource } from './bridge-protocol';
import { type ClaudeCli, MIN_VERSION } from './cli';
import { ccErrors } from './errors';
import type { ClaudeInstaller } from './install';
import {
  addUsage,
  applyToMirror,
  type CcProvenance,
  digestSubagent,
  MAPPER_VERSION,
  type PlanResult,
  planSync,
  provenanceOf,
  type SubagentDigest,
  titleOf,
} from './map';
import { joinOutput } from './markup';
import { type ClaudeCodeStore, cwdKey, cwdWithin, type SessionBinding } from './store';
import { coversSdkChain, findTranscript, readTranscript, TRANSCRIPT_READER_VERSION } from './transcript';
import type { ClaudeVerifier } from './verify';

const log = logFor('claude-code');

const LIST_TTL_MS = 30_000;
const ACTIVE_MS = 60_000;
const CHUNK = 200;
const SIGN_IN_WAIT_MS = 5 * 60_000;

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ClaudeCodeServiceDeps {
  workspaceId: string;
  settings: SettingsStore;
  bus: EventBus;
  threads: ThreadRepo;
  notebooks: NotebookRepo;
  store: ClaudeCodeStore;
  source: SessionSource;
  cli: ClaudeCli;
  installer: ClaudeInstaller;
  verifier: ClaudeVerifier;
  platform?: NodeJS.Platform;
  now?: () => number;
  pathExists?: (p: string) => boolean;
  /** Where Claude Code keeps sessions, when its CLI does not say. */
  defaultProjectsDir?: string;
  /** Can a sign-in window open here (a desktop session)? */
  canOpenBrowser?: () => boolean;
  /** Auto-import timings. */
  auto?: { startDelayMs?: number; debounceMs?: number; pauseMs?: number };
  signInPollMs?: number;
  /** The home folder "~" stands for in excluded folders. */
  home?: string;
  /** Read full history from transcript files (default on; tests may turn it off). */
  transcripts?: boolean;
}

/** A session's history: its chains (old branches first, the active one last). */
export interface SessionHistory {
  chains: CcSessionMessage[][];
  via: 'transcript' | 'sdk';
}

export interface SessionFilter {
  q?: string;
  cwd?: string;
  limit?: number;
  cursor?: string | null;
}

export interface SyncResult {
  thread_id: string;
  session_id: string;
  added: number;
  /** The session's transcript is no longer on this computer; the thread stays. */
  gone: boolean;
}

/** "nvx_ancile", then "nvx_ancile (Desktop)", then "nvx_ancile (Users/Desktop)", then numbers. */
export function notebookNames(cwd: string): string[] {
  const segs = cwd.split(/[\\/]+/).filter(Boolean);
  const base = segs.at(-1) ?? cwd;
  const parent = segs.at(-2);
  const grand = segs.at(-3);
  const out = [base];
  if (parent) out.push(`${base} (${parent})`);
  if (parent && grand) out.push(`${base} (${grand}/${parent})`);
  for (let i = 2; i < 50; i++) out.push(`${base} ${i}`);
  return out;
}

/** The Cockpit's notebook hues, in its order (apps/cockpit/src/lib/mappers.ts HUES). */
export const NOTEBOOK_HUES = ['azure', 'coral', 'jade', 'amber', 'cyan', 'magenta'] as const;

/**
 * A folder's notebook shows the Cockpit's terminal glyph. Folder
 * notebooks made before it had one get it on the next import pass.
 */
export const FOLDER_NOTEBOOK_ICON: string | null = 'terminal';

/** FNV-1a, so a folder always breaks a tie the same way. */
function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A hue for a folder's notebook: the first one no other live notebook
 * uses; when all are used, the least used, ties settled by the folder.
 */
export function pickHue(key: string, used: (string | null | undefined)[]): string {
  const count = new Map<string, number>(NOTEBOOK_HUES.map((h) => [h, 0]));
  for (const c of used) if (c && count.has(c)) count.set(c, (count.get(c) ?? 0) + 1);
  const free = NOTEBOOK_HUES.find((h) => count.get(h) === 0);
  if (free) return free;
  const least = Math.min(...count.values());
  const tied = NOTEBOOK_HUES.filter((h) => count.get(h) === least);
  return tied[stableHash(key) % tied.length] as string;
}

/**
 * "~" (alone or before a slash) as the home folder, and "<temp>" as the
 * system temp folder, where throwaway sessions run.
 */
export function expandHome(path: string, home: string, temp: string = tmpdir()): string {
  return path
    .trim()
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/^<temp>(?=$|[\\/])/, temp);
}

export class ClaudeCodeService {
  private listing: { at: number; items: CcSessionInfo[] } | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();
  private notebookLock: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private autoRunning: Promise<void> | null = null;
  private autoAgain = false;
  private stopped = false;
  private signingIn: Promise<void> | null = null;
  private sdkKicked = false;
  /** Sessions a live turn is writing: left to that turn (claudecode/live.ts). */
  private liveGuard: (sessionId: string) => boolean = () => false;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: ClaudeCodeServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
  }

  private emit(
    what: 'install' | 'auth' | 'sessions' | 'thread',
    extra: { thread_id?: string; detail?: string } = {},
  ) {
    void this.deps.bus
      .publish({ type: 'claude_code.changed', what, ...extra })
      .catch((err: unknown) => log.warn({ err }, 'claude_code.changed not published'));
  }

  /* ---- settings and status ------------------------------------------- */

  async settings(): Promise<ClaudeCodeSettings> {
    return ClaudeCodeSettings.parse((await this.deps.settings.get(SETTING.claudeCode)) ?? {});
  }

  async patchSettings(patch: Partial<ClaudeCodeSettings>): Promise<ClaudeCodeSettings> {
    const next = ClaudeCodeSettings.parse({ ...(await this.settings()), ...patch });
    await this.deps.settings.set(SETTING.claudeCode, next);
    if (patch.exclude_folders !== undefined) await this.cleanupExcluded();
    if (patch.auto_import === true) this.kick();
    return next;
  }

  /* ---- excluded folders ------------------------------------------------ */

  /** Does a session in `cwd` belong to an excluded folder? */
  private async excluded(): Promise<(cwd: string | null | undefined) => boolean> {
    const home = this.deps.home ?? homedir();
    const roots = (await this.settings()).exclude_folders.map((f) => expandHome(f, home)).filter(Boolean);
    return (cwd) => !!cwd && roots.some((r) => cwdWithin(cwd, r, this.platform));
  }

  /** "Don't bring in this folder": add it to the excluded folders and tidy up. */
  async excludeFolder(cwd: string): Promise<ClaudeCodeSettings> {
    const cur = await this.settings();
    const home = this.deps.home ?? homedir();
    const already = cur.exclude_folders.some((f) => cwdWithin(cwd, expandHome(f, home), this.platform));
    if (already) {
      await this.cleanupExcluded();
      return cur;
    }
    return this.patchSettings({ exclude_folders: [...cur.exclude_folders, cwd] });
  }

  /**
   * Put away what was brought in from excluded folders. A thread whose
   * messages all came from Claude Code is archived (never deleted) and
   * its session unbound; a thread with anything written in Ancile is
   * left as it is. A notebook made for such a folder that ends up with
   * no live threads is archived and its folder unbound.
   */
  async cleanupExcluded(): Promise<{ threads: number; notebooks: number }> {
    const ws = this.deps.workspaceId;
    const isExcluded = await this.excluded();
    let threadsDone = 0;
    let notebooksDone = 0;
    for (const b of await this.deps.store.sessions(ws)) {
      if (!isExcluded(b.cwd)) continue;
      const msgs = await this.deps.threads.messages(b.thread_id);
      if (!msgs.every((m) => !!m.provenance?.claude_code)) {
        log.info(
          { session_id: b.session_id, thread_id: b.thread_id },
          'a thread from an excluded folder has messages written in Ancile; left as it is',
        );
        continue;
      }
      const t = await this.deps.threads.getThread(b.thread_id);
      if (t && !t.archived_at) await this.deps.threads.patchThread(b.thread_id, { archived: true });
      await this.deps.store.removeSession(ws, b.session_id);
      threadsDone++;
    }
    for (const p of await this.deps.store.projects(ws)) {
      if (!isExcluded(p.cwd) || !p.created_notebook) continue;
      const nb = await this.deps.notebooks.get(p.notebook_id);
      if (!nb) continue;
      const live = await this.deps.threads.listThreads(ws, { notebookId: nb.id, archived: false, limit: 1 });
      if (live.length) continue;
      if (!nb.archived_at) await this.deps.notebooks.patch(nb.id, { archived: true });
      await this.deps.store.removeProject(ws, p.cwd);
      notebooksDone++;
    }
    if (threadsDone || notebooksDone) {
      log.info({ threads: threadsDone, notebooks: notebooksDone }, 'put away sessions from excluded folders');
      this.emit('sessions');
    }
    return { threads: threadsDone, notebooks: notebooksDone };
  }

  /** Environment for every Claude Code run: telemetry off when the person turned it off. */
  async cliEnv(): Promise<Record<string, string>> {
    return (await this.settings()).claude_telemetry ? {} : { DISABLE_TELEMETRY: '1' };
  }

  async status(fresh = false): Promise<ClaudeCodeStatus> {
    const [cli, settings] = await Promise.all([this.deps.cli.status(fresh), this.settings()]);
    const install = this.deps.installer.state();
    if (!cli.installed && settings.auto_install && install.state === 'idle') void this.install();
    if (cli.installed && cli.path && cli.version) {
      // Checked in the background; cached per version and file.
      void this.deps.verifier.verify(cli.path, cli.version).then(
        (v) => v.state === 'failed' && this.emit('install', { detail: 'verification' }),
        () => undefined,
      );
      this.kickSdk(fresh);
    }
    const sdk = this.deps.source.lastSdkStatus();
    return {
      installed: cli.installed,
      version: cli.version,
      path: cli.path,
      version_ok: cli.version_ok,
      min_version: MIN_VERSION,
      signed_in: cli.signed_in,
      auth_method: cli.auth_method,
      plan: cli.plan,
      projects_dir: cli.projects_dir,
      config_dir: cli.config_dir,
      install: { state: install.state, error: install.error },
      verification: cli.installed ? this.deps.verifier.current() : { state: 'unchecked', error: null },
      sdk: { ready: !!sdk?.ready, version: sdk?.version ?? null, error: sdk?.error ?? null },
      settings,
    };
  }

  /** Fetch the SDK (through the bridge) the first time Claude Code is used. */
  private kickSdk(again = false) {
    if (this.sdkKicked && !again) return;
    if (this.deps.source.lastSdkStatus()?.ready) return;
    this.sdkKicked = true;
    void this.deps.source.sdkStatus(true).then(
      () => this.emit('install', { detail: 'sdk' }),
      (err: unknown) =>
        log.warn({ err: (err as Error).message }, 'the Claude bridge could not prepare the SDK'),
    );
  }

  /** Is this Claude Code verified? Phase 2 runs sessions only when it is. */
  async requireVerified(): Promise<void> {
    const cli = await this.deps.cli.status();
    if (!cli.installed || !cli.path || !cli.version) throw ccErrors.notInstalled();
    const v = await this.deps.verifier.verify(cli.path, cli.version);
    if (v.state !== 'verified')
      throw new AncileError({
        code: 'claude_code.unverified',
        title: 'This Claude Code install could not be verified',
        hint: 'Reinstall Claude Code from claude.ai/install, then press Check again.',
        status: 409,
        errorClass: 'permanent',
        ...(v.error && { detail: v.error }),
      });
  }

  /* ---- install, sign in, sign out ------------------------------------ */

  install(): Promise<{ state: string; error: string | null }> {
    const run = this.deps.installer.install().then(async () => {
      this.deps.cli.invalidate();
      const s = await this.deps.cli.status(true).catch(() => null);
      if (s?.installed && s.path && s.version)
        await this.deps.verifier.verify(s.path, s.version).catch(() => undefined);
      this.emit('install');
      if (s?.installed) this.kick();
    });
    void run.catch(() => undefined);
    return Promise.resolve(this.deps.installer.state());
  }

  async signIn(method: 'claudeai' | 'console' | 'sso' = 'claudeai'): Promise<{ started: boolean }> {
    const cli = await this.deps.cli.status(true);
    if (!cli.installed) throw ccErrors.notInstalled();
    if (cli.version && !cli.version_ok) throw ccErrors.versionOld(cli.version, MIN_VERSION);
    if (cli.signed_in) return { started: false };
    const canOpen =
      this.deps.canOpenBrowser ??
      (() =>
        this.platform === 'win32' ||
        this.platform === 'darwin' ||
        !!process.env.DISPLAY ||
        !!process.env.WAYLAND_DISPLAY);
    if (!canOpen()) throw ccErrors.signInUnavailable();
    if (this.signingIn) return { started: true };
    const started = await this.deps.cli.start(['auth', 'login', `--${method}`]).catch(() => null);
    if (!started) throw ccErrors.signInUnavailable();
    started.child.on('error', () => undefined);
    this.signingIn = this.waitForSignIn(started.child).finally(() => {
      this.signingIn = null;
    });
    return { started: true };
  }

  private async waitForSignIn(child: { kill(): boolean; exitCode: number | null }) {
    const until = this.now() + SIGN_IN_WAIT_MS;
    let was = false;
    while (this.now() < until && !this.stopped) {
      await sleep(this.deps.signInPollMs ?? 3000);
      const s = await this.deps.cli.status(true).catch(() => null);
      if (s && s.signed_in !== was) {
        was = s.signed_in;
        this.emit('auth');
      }
      if (s?.signed_in) return;
    }
    if (child.exitCode === null) child.kill();
    this.emit('auth', { detail: 'timeout' });
  }

  async signOut(): Promise<void> {
    const r = await this.deps.cli.run(['auth', 'logout'], 30_000);
    if (r.code === 127) throw ccErrors.notInstalled();
    if (r.code !== 0) throw ccErrors.cliFailed('sign out', r.stderr || r.stdout);
    this.deps.cli.invalidate();
    this.emit('auth');
  }

  /* ---- sessions -------------------------------------------------------- */

  private async sessionInfos(fresh = false): Promise<CcSessionInfo[]> {
    if (!fresh && this.listing && this.now() - this.listing.at < LIST_TTL_MS) return this.listing.items;
    let items: CcSessionInfo[];
    try {
      items = await this.deps.source.listSessions();
    } catch (err) {
      throw ccErrors.sdkUnavailable((err as Error).message);
    }
    items = items
      .filter((s) => s && typeof s.sessionId === 'string')
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    this.listing = { at: this.now(), items };
    return items;
  }

  invalidateListing() {
    this.listing = null;
  }

  async listSessions(
    f: SessionFilter = {},
  ): Promise<{ items: ClaudeCodeSession[]; next_cursor: string | null }> {
    const infos = await this.sessionInfos();
    const bindings = new Map(
      (await this.deps.store.sessions(this.deps.workspaceId)).map((b) => [b.session_id, b]),
    );
    const exists = this.deps.pathExists ?? existsSync;
    const q = f.q?.trim().toLowerCase();
    const cwd = f.cwd ? cwdKey(f.cwd, this.platform) : null;
    const isExcluded = await this.excluded();
    const filtered = infos.filter((s) => {
      if (isExcluded(s.cwd)) return false;
      if (cwd && (!s.cwd || cwdKey(s.cwd, this.platform) !== cwd)) return false;
      if (q && !titleOf(s).toLowerCase().includes(q) && !(s.cwd ?? '').toLowerCase().includes(q))
        return false;
      return true;
    });
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
    const offset = Math.max(Number.parseInt(f.cursor ?? '0', 10) || 0, 0);
    const page = filtered.slice(offset, offset + limit);
    const missing = new Map<string, boolean>();
    const items = page.map((s): ClaudeCodeSession => {
      const b = bindings.get(s.sessionId);
      if (s.cwd && !missing.has(s.cwd)) missing.set(s.cwd, !exists(s.cwd));
      return {
        session_id: s.sessionId,
        title: titleOf(s),
        cwd: s.cwd ?? null,
        project: s.cwd
          ? (s.cwd
              .split(/[\\/]+/)
              .filter(Boolean)
              .at(-1) ?? s.cwd)
          : 'No folder',
        cwd_missing: s.cwd ? !!missing.get(s.cwd) : false,
        updated_at: new Date(s.lastModified).toISOString(),
        created_at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
        git_branch: s.gitBranch ?? null,
        size_bytes: typeof s.fileSize === 'number' ? s.fileSize : null,
        thread_id: b?.thread_id ?? null,
        behind: !!b && s.lastModified > b.last_modified,
        active_elsewhere: this.now() - s.lastModified < ACTIVE_MS,
      };
    });
    const next = offset + limit < filtered.length ? String(offset + limit) : null;
    return { items, next_cursor: next };
  }

  /* ---- projects (folder → notebook) ------------------------------------ */

  async projects(): Promise<ClaudeCodeProject[]> {
    return (await this.deps.store.projects(this.deps.workspaceId)).map((p) => ({
      cwd: p.cwd,
      notebook_id: p.notebook_id,
    }));
  }

  async putProject(p: ClaudeCodeProject): Promise<ClaudeCodeProject> {
    const nb = await this.deps.notebooks.get(p.notebook_id);
    if (!nb || nb.workspace_id !== this.deps.workspaceId)
      throw new AncileError({
        code: 'request.not_found',
        title: "That notebook doesn't exist",
        hint: 'It may have been deleted. Choose another notebook.',
        status: 404,
        errorClass: 'permanent',
      });
    await this.deps.store.putProject(this.deps.workspaceId, p.cwd, p.notebook_id);
    return p;
  }

  removeProject(cwd: string): Promise<boolean> {
    return this.deps.store.removeProject(this.deps.workspaceId, cwd);
  }

  /** The notebook a folder's sessions go to, made (or adopted) on first use. */
  private notebookFor(cwd: string | null): Promise<string | null> {
    if (!cwd) return Promise.resolve(null);
    const run = this.notebookLock.then(async () => {
      const ws = this.deps.workspaceId;
      const projects = await this.deps.store.projects(ws);
      const key = cwdKey(cwd, this.platform);
      const hit = projects.find((p) => p.cwd_key === key);
      if (hit && (await this.deps.notebooks.get(hit.notebook_id))) return hit.notebook_id;
      const books = await this.deps.notebooks.list(ws);
      const bound = new Set(projects.filter((p) => p.cwd_key !== key).map((p) => p.notebook_id));
      for (const name of notebookNames(cwd)) {
        const existing = books.find((b) => b.title === name);
        if (existing && bound.has(existing.id)) continue;
        if (existing) {
          await this.deps.store.putProject(ws, cwd, existing.id, false);
          return existing.id;
        }
        const color = pickHue(
          key,
          books.filter((b) => !b.archived_at).map((b) => b.color),
        );
        const made = await this.deps.notebooks.create({
          id: `nbk_${ulid()}`,
          workspace_id: ws,
          title: name,
          color,
          icon: FOLDER_NOTEBOOK_ICON,
        });
        await this.deps.store.putProject(ws, cwd, made.id, true);
        return made.id;
      }
      return null;
    });
    this.notebookLock = run.catch(() => undefined);
    return run;
  }

  /** Let the live layer say which sessions it is writing now. */
  setLiveGuard(fn: (sessionId: string) => boolean): void {
    this.liveGuard = fn;
  }

  /** The verified Claude Code program, for live sessions. */
  async cliPath(): Promise<{ path: string; version: string }> {
    await this.requireVerified();
    const cli = await this.deps.cli.status();
    if (!cli.path || !cli.version) throw ccErrors.notInstalled();
    return { path: cli.path, version: cli.version };
  }

  /** When the session's transcript was last written, from the file itself (null when not found). */
  async transcriptModified(sessionId: string): Promise<number | null> {
    const path = await findTranscript(await this.projectsDir(), sessionId);
    if (!path) return null;
    return (await stat(path).catch(() => null))?.mtimeMs ?? null;
  }

  /**
   * A session's full history from its transcript file: every branch and
   * everything before each compaction. Falls back to the SDK's current
   * chain when the file is missing or the reader's checks fail (logged).
   * `check`: also make sure the reader holds everything the SDK returns.
   */
  async history(sessionId: string, check = false): Promise<SessionHistory> {
    const sdkChain = async () => {
      try {
        return await this.deps.source.sessionMessages(sessionId);
      } catch (err) {
        throw ccErrors.sdkUnavailable((err as Error).message);
      }
    };
    if (this.deps.transcripts === false) return { chains: [await sdkChain()], via: 'sdk' };
    const path = await findTranscript(await this.projectsDir(), sessionId);
    if (!path) {
      log.info({ session_id: sessionId }, 'no transcript file for a session; reading it through the SDK');
      return { chains: [await sdkChain()], via: 'sdk' };
    }
    const r = await readTranscript(path, sessionId);
    if (!r.ok) {
      log.warn(
        { session_id: sessionId, reason: r.reason, reader: TRANSCRIPT_READER_VERSION, stats: r.stats },
        'the transcript reader could not read a session; using the SDK chain',
      );
      return { chains: [await sdkChain()], via: 'sdk' };
    }
    if (check) {
      const sdk = await sdkChain();
      if (!coversSdkChain(r.chains, sdk)) {
        log.warn(
          { session_id: sessionId, reader: TRANSCRIPT_READER_VERSION, stats: r.stats },
          'the transcript reader missed messages the SDK has; using the SDK chain',
        );
        return { chains: [sdk], via: 'sdk' };
      }
    }
    log.debug({ session_id: sessionId, reader: TRANSCRIPT_READER_VERSION, ...r.stats }, 'read a transcript');
    return { chains: r.chains, via: 'transcript' };
  }

  /** Notebooks made for folders before they had colours (or the terminal icon) get them. */
  private backfillColours(): Promise<number> {
    const run = this.notebookLock.then(async () => {
      const ws = this.deps.workspaceId;
      const projects = (await this.deps.store.projects(ws)).filter((p) => p.created_notebook);
      if (!projects.length) return 0;
      const books = await this.deps.notebooks.list(ws);
      let n = 0;
      for (const p of projects) {
        const nb = books.find((b) => b.id === p.notebook_id);
        if (!nb || nb.archived_at || (nb.color && (nb.icon || !FOLDER_NOTEBOOK_ICON))) continue;
        const color =
          nb.color ??
          pickHue(
            p.cwd_key,
            books.filter((b) => !b.archived_at && b.id !== nb.id).map((b) => b.color),
          );
        const icon = nb.icon ?? FOLDER_NOTEBOOK_ICON;
        await this.deps.notebooks.patch(nb.id, { color, ...(icon !== nb.icon && { icon }) });
        nb.color = color;
        nb.icon = icon;
        n++;
      }
      return n;
    });
    this.notebookLock = run.catch(() => undefined);
    return run;
  }

  /* ---- import and sync ------------------------------------------------- */

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  async importSessions(req: ImportClaudeCodeSessionsRequest): Promise<ImportClaudeCodeSessionsResult> {
    if (req.notebook_id) {
      const nb = await this.deps.notebooks.get(req.notebook_id);
      if (!nb || nb.workspace_id !== this.deps.workspaceId)
        throw new AncileError({
          code: 'request.not_found',
          title: "That notebook doesn't exist",
          hint: 'It may have been deleted. Choose another notebook.',
          status: 404,
          errorClass: 'permanent',
        });
    }
    const infos = await this.sessionInfos();
    const byId = new Map(infos.map((s) => [s.sessionId, s]));
    const result: ImportClaudeCodeSessionsResult = { imported: [], failed: [] };
    const isExcluded = await this.excluded();
    for (const id of req.session_ids) {
      try {
        const info = byId.get(id) ?? (await this.deps.source.sessionInfo(id));
        if (!info) throw ccErrors.sessionNotFound(id);
        if (isExcluded(info.cwd)) throw ccErrors.folderExcluded(info.cwd ?? '');
        const r = await this.syncSession(info, req.notebook_id ?? undefined);
        result.imported.push({
          session_id: id,
          thread_id: r.thread_id,
          added: r.added,
          notebook_id: r.notebook_id,
        });
      } catch (err) {
        const e = err instanceof AncileError ? err : ccErrors.sdkUnavailable((err as Error).message);
        log.warn({ session_id: id, code: e.code }, 'a Claude Code session could not be brought in');
        result.failed.push({ session_id: id, title: e.title, hint: e.hint });
      }
      await yieldNow();
    }
    return result;
  }

  /** Pull new messages into a thread that came from Claude Code. */
  async syncThread(threadId: string): Promise<SyncResult> {
    const thread = await this.deps.threads.getThread(threadId);
    if (!thread || thread.workspace_id !== this.deps.workspaceId)
      throw new AncileError({
        code: 'request.not_found',
        title: "That thread doesn't exist",
        hint: 'It may have been deleted.',
        status: 404,
        errorClass: 'permanent',
      });
    const sessionId = thread.settings.claude_code?.session_id;
    if (!sessionId) throw ccErrors.notBound();
    let info: CcSessionInfo | null;
    try {
      info = await this.deps.source.sessionInfo(sessionId);
    } catch (err) {
      throw ccErrors.sdkUnavailable((err as Error).message);
    }
    if (!info) return { thread_id: threadId, session_id: sessionId, added: 0, gone: true };
    const r = await this.syncSession(info);
    return { thread_id: r.thread_id, session_id: sessionId, added: r.added, gone: false };
  }

  /** Bring one session in, or bring its thread up to date. Idempotent. */
  syncSession(
    info: CcSessionInfo,
    notebookOverride?: string,
    opts: { force?: boolean; threadId?: string } = {},
  ): Promise<{ thread_id: string; added: number; notebook_id: string | null }> {
    return this.locked(info.sessionId, () => this.syncLocked(info, notebookOverride, opts));
  }

  private async syncLocked(
    info: CcSessionInfo,
    notebookOverride?: string,
    opts: { force?: boolean; threadId?: string } = {},
  ) {
    const ws = this.deps.workspaceId;
    const { threads } = this.deps;
    const sessionId = info.sessionId;
    const binding = (await this.deps.store.sessions(ws)).find((b) => b.session_id === sessionId);
    // A live turn is writing this session: it syncs when it ends, so nothing is written twice.
    if (binding && !opts.force && this.liveGuard(sessionId)) {
      const t = await threads.getThread(binding.thread_id);
      return { thread_id: binding.thread_id, added: 0, notebook_id: t?.notebook_id ?? null };
    }
    const title = titleOf(info);
    const cwd = info.cwd ?? null;
    const traceId = currentContext()?.traceId ?? newTraceId();

    let thread: ThreadRecord | undefined = binding
      ? await threads.getThread(binding.thread_id)
      : opts.threadId
        ? await threads.getThread(opts.threadId)
        : undefined;
    // A session forked from another one in Ancile shares its thread; only the thread's own session moves its head.
    const primary = !thread || thread.settings.claude_code?.session_id === sessionId;
    let lastTitle = binding?.title ?? null;
    if (!thread) {
      const notebookId = notebookOverride ?? (await this.notebookFor(cwd));
      thread = await threads.createThread({
        id: `thr_${ulid()}`,
        workspace_id: ws,
        title,
        notebook_id: notebookId,
        settings: {
          claude_code: {
            session_id: sessionId,
            cwd,
            last_uuid: null,
            synced_at: new Date(this.now()).toISOString(),
          },
        },
      });
      lastTitle = title;
    }

    const rebuilding = !!binding && binding.mapper_version < MAPPER_VERSION;
    const history = await this.history(sessionId, !binding || rebuilding);
    const chains = history.chains;
    const any = chains.some((c) => c.length > 0);
    // Built by an older mapping: rebuild it, unless something was written in Ancile.
    let mapperVersion = binding?.mapper_version ?? MAPPER_VERSION;
    let fallbackHead = thread.active_head_id;
    if (binding && mapperVersion < MAPPER_VERSION && any) {
      const old = await threads.messages(thread.id);
      if (old.every((m) => !!m.provenance?.claude_code)) {
        await threads.discardMessages(old.map((m) => m.id));
        fallbackHead = null;
        log.info(
          { session_id: sessionId, thread_id: thread.id, from: mapperVersion, to: MAPPER_VERSION },
          'rebuilding a Claude Code thread with the current mapping',
        );
      } else {
        log.info(
          { session_id: sessionId, thread_id: thread.id },
          'a Claude Code thread has messages written in Ancile; kept as it is, new messages use the current mapping',
        );
      }
      mapperVersion = MAPPER_VERSION;
    }
    const mirror = await this.deps.store.mirror(thread.id);
    let added = 0;
    let firstRoot = null as string | null;
    let plan: PlanResult = { planned: [], head: null, lastUuid: null };
    // Old branches first, the active path last: each branch hangs off what is already there.
    for (const chain of chains) {
      plan = planSync(chain, mirror, () => `msg_${ulid()}`, fallbackHead);
      const r = await this.writePlan(thread, sessionId, plan, traceId);
      added += r.added;
      firstRoot ??= r.firstRoot;
      applyToMirror(mirror, plan);
    }
    if (history.via === 'transcript' && chains.length > 1)
      log.info(
        { session_id: sessionId, thread_id: thread.id, branches: chains.length - 1 },
        'brought in a session with its branches',
      );

    await this.attachSubagents(thread.id, sessionId);

    // The title follows Claude Code's name for the session, unless it was renamed in Ancile.
    const renamedHere = lastTitle !== null && thread.title !== lastTitle;
    const nextTitle = !primary || renamedHere ? undefined : title !== thread.title ? title : undefined;
    const syncedAt = new Date(this.now()).toISOString();
    await threads.patchThread(thread.id, {
      ...(primary && plan.head && { active_head_id: plan.head }),
      ...(firstRoot && !thread.root_message_id ? { root_message_id: firstRoot } : {}),
      ...(nextTitle && { title: nextTitle }),
      ...(primary && {
        settings: {
          claude_code: {
            session_id: sessionId,
            cwd,
            last_uuid: plan.lastUuid ?? thread.settings.claude_code?.last_uuid ?? null,
            synced_at: syncedAt,
          },
        },
      }),
    });
    const binding2: SessionBinding = {
      session_id: sessionId,
      thread_id: thread.id,
      title: renamedHere ? lastTitle : title,
      cwd,
      last_modified: info.lastModified ?? 0,
      synced_at: syncedAt,
      mapper_version: mapperVersion,
    };
    await this.deps.store.putSession(ws, binding2);
    if (added || !binding || nextTitle) this.emit('thread', { thread_id: thread.id });
    return { thread_id: thread.id, added, notebook_id: thread.notebook_id };
  }

  /** Write one plan: new messages in chunks, then the messages it extends. */
  private async writePlan(
    thread: ThreadRecord,
    sessionId: string,
    plan: PlanResult,
    traceId: string,
  ): Promise<{ added: number; firstRoot: string | null }> {
    const { threads } = this.deps;
    let added = 0;
    let firstRoot = null as string | null;
    const fresh = plan.planned.filter((p) => !p.extends);
    let clock = this.now() - fresh.length;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const rows: NewMessage[] = fresh.slice(i, i + CHUNK).map((p) => {
        if (!p.parent_id && !firstRoot) firstRoot = p.id;
        const cc = provenanceOf(sessionId, p);
        return {
          id: p.id,
          thread_id: thread.id,
          parent_id: p.parent_id,
          role: p.role,
          parts: p.parts,
          status: 'complete',
          model_id: p.model_id,
          usage: p.usage,
          provenance: { claude_code: cc },
          created_at: p.created_at ?? new Date(clock++).toISOString(),
          trace_id: traceId,
        };
      });
      await threads.insertMessages(rows);
      added += rows.length;
      await yieldNow();
    }

    for (const p of plan.planned.filter((x) => x.extends)) {
      const old = await threads.getMessage(p.id);
      if (!old) continue;
      const oc = (old.provenance?.claude_code ?? {}) as CcProvenance;
      const uuids = [...(Array.isArray(oc.uuids) ? oc.uuids : []), ...p.uuids];
      await threads.updateMessage(p.id, {
        parts: [...old.parts, ...p.parts],
        usage: addUsage(old.usage, p.usage),
        ...(p.model_id && { model_id: p.model_id }),
        provenance: {
          claude_code: {
            ...oc,
            uuid: uuids.at(-1) ?? oc.uuid,
            uuids,
            last_api_id: p.last_api_id ?? oc.last_api_id ?? null,
            ...(p.output !== undefined &&
              oc.command && { command: { ...oc.command, output: joinOutput(oc.command.output, p.output) } }),
          },
        },
      });
      added++;
    }
    return { added, firstRoot };
  }

  /**
   * Subagent conversations, collapsed onto the message holding the Task
   * (or Agent) call that started them: provenance.claude_code.subagent, an
   * array of { call_id, description, messages }. A subagent whose call is
   * not in the thread is left out (logged).
   */
  private async attachSubagents(threadId: string, sessionId: string) {
    let agents: string[];
    try {
      agents = await this.deps.source.listSubagents(sessionId);
    } catch {
      return;
    }
    if (!agents.length) return;
    const msgs = await this.deps.threads.messages(threadId);
    const byCall = new Map<string, { id: string; description: string | null }>();
    const seen = new Map<string, number>();
    for (const m of msgs) {
      for (const p of m.parts as Part[])
        if (p.type === 'tool_call') {
          const a = (p.args ?? {}) as Record<string, unknown>;
          const d =
            typeof a.description === 'string'
              ? a.description
              : typeof a.prompt === 'string'
                ? a.prompt.slice(0, 120)
                : null;
          byCall.set(p.call_id, { id: m.id, description: d });
        }
      const cc = (m.provenance?.claude_code ?? {}) as { subagent?: SubagentDigest[] };
      for (const d of cc.subagent ?? []) seen.set(d.agent_id, d.count);
    }
    const updates = new Map<string, SubagentDigest[]>();
    for (const agentId of agents) {
      const sub = await this.deps.source.subagentMessages(sessionId, agentId).catch(() => []);
      if (!sub.length || seen.get(agentId) === sub.length) continue;
      const digest = digestSubagent(agentId, sub);
      const host = digest.call_id ? byCall.get(digest.call_id) : undefined;
      if (!host) {
        log.debug(
          { session_id: sessionId, agent_id: agentId },
          'a subagent without its call in the thread was left out',
        );
        continue;
      }
      digest.description = host.description;
      const list = updates.get(host.id) ?? [
        ...((
          (msgs.find((m) => m.id === host.id)?.provenance?.claude_code ?? {}) as {
            subagent?: SubagentDigest[];
          }
        ).subagent ?? []),
      ];
      const at = list.findIndex((d) => d.agent_id === agentId);
      if (at >= 0) list[at] = digest;
      else list.push(digest);
      updates.set(host.id, list);
      await yieldNow();
    }
    for (const [id, list] of updates) {
      const cur = (msgs.find((m) => m.id === id)?.provenance?.claude_code ?? {}) as Record<string, unknown>;
      await this.deps.threads.updateMessage(id, { provenance: { claude_code: { ...cur, subagent: list } } });
    }
  }

  /* ---- auto-import ------------------------------------------------------ */

  /** Start auto-import: a pass after a short delay, then on every change to the projects folder. */
  startAuto(): void {
    this.stopped = false;
    // What excluded folders brought in before is put away at every start.
    void this.cleanupExcluded().catch((err: unknown) =>
      log.warn({ err: (err as Error).message }, 'could not put away sessions from excluded folders'),
    );
    if (!this.deps.cli.where()) return;
    this.startTimer = setTimeout(() => {
      void this.watch();
      this.kick();
    }, this.deps.auto?.startDelayMs ?? 20_000);
    this.startTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }

  async projectsDir(): Promise<string> {
    const s = await this.deps.cli.status().catch(() => null);
    return s?.projects_dir ?? this.deps.defaultProjectsDir ?? join(homedir(), '.claude', 'projects');
  }

  /** Watch Claude Code's projects folder (debounced). */
  async watch(): Promise<void> {
    if (this.watcher || this.stopped) return;
    const dir = await this.projectsDir();
    if (!existsSync(dir)) return;
    try {
      this.watcher = watch(dir, { recursive: true }, () => this.changed());
      this.watcher.on('error', (err) => {
        log.warn({ err: err.message }, 'stopped watching Claude Code sessions');
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'cannot watch Claude Code sessions');
    }
  }

  private changed() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.listing = null;
      this.emit('sessions');
      this.kick();
    }, this.deps.auto?.debounceMs ?? 2000);
    this.debounce.unref?.();
  }

  /** Run an auto-import pass now (or once more after the current one). */
  kick(): void {
    if (this.stopped) return;
    if (this.autoRunning) {
      this.autoAgain = true;
      return;
    }
    this.autoRunning = this.pass()
      .catch((err: unknown) =>
        log.warn({ err: (err as Error).message }, 'Claude Code auto-import pass failed'),
      )
      .finally(() => {
        this.autoRunning = null;
        if (this.autoAgain) {
          this.autoAgain = false;
          this.kick();
        }
      });
  }

  /** Resolves when no pass is running (tests). */
  async idle(): Promise<void> {
    while (this.autoRunning) await this.autoRunning;
  }

  private async pass(): Promise<void> {
    if (!(await this.settings()).auto_import) return;
    if (!this.deps.cli.where()) return;
    const coloured = await this.backfillColours();
    if (coloured) this.emit('sessions', { detail: 'notebooks' });
    const infos = await this.sessionInfos(true);
    const bound = new Map(
      (await this.deps.store.sessions(this.deps.workspaceId)).map((b) => [b.session_id, b]),
    );
    const isExcluded = await this.excluded();
    const todo = infos.filter((i) => {
      if (isExcluded(i.cwd)) return false;
      const b = bound.get(i.sessionId);
      return !b || b.last_modified < i.lastModified || b.mapper_version < MAPPER_VERSION;
    });
    if (!todo.length) return;
    let done = 0;
    let fresh = 0;
    let lastEmit = 0;
    const progress = (force = false) => {
      if (!force && this.now() - lastEmit < 400) return;
      lastEmit = this.now();
      this.emit('sessions', { detail: `importing:${done}/${todo.length}` });
    };
    progress(true);
    for (const info of todo) {
      if (this.stopped) return;
      try {
        await this.syncSession(info);
        if (!bound.has(info.sessionId)) fresh++;
      } catch (err) {
        log.warn(
          { session_id: info.sessionId, err: (err as Error).message },
          'auto-import skipped a session',
        );
      }
      done++;
      progress();
      await sleep(this.deps.auto?.pauseMs ?? 50);
    }
    if (fresh) {
      log.info({ sessions: fresh }, 'Claude Code sessions brought in');
      this.emit('sessions', { detail: `imported:${fresh}` });
    }
  }
}
