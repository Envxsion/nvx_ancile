/**
 * ------------------------------------------------------------------
 *  Title    |  Who holds a Claude Code session
 *  Ref      |  docs/claude-code.md (One session, one place) · ROADMAP G
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Tell whether a `claude` process other than NVX Ancile's
 *           |  own has a session open right now (a terminal, an IDE),
 *           |  so a turn from NVX Ancile carries on in a branch instead
 *           |  of writing to a session someone else has open.
 *  How      |  A ProcessLister reads the running processes and their
 *           |  command lines: on Windows through PowerShell's CIM query
 *           |  (Win32_Process), falling back to wmic; on macOS and
 *           |  Linux through `ps`, with each Claude Code process's
 *           |  folder from /proc (Linux) or lsof (macOS). A process
 *           |  holds a session when its command line names the session
 *           |  (`--resume <id>`, `-r <id>`, `--session-id <id>`), or
 *           |  when it runs in the session's folder without naming
 *           |  another session and started before the session was last
 *           |  written. Processes NVX Ancile started (anything below
 *           |  Core's own process) never count. The list is cached for
 *           |  a few seconds.
 *  Note     |  Read-only: nothing is ever killed, signalled or written,
 *           |  and nothing under Claude Code's own folders is touched.
 *           |  Command lines stay in memory for matching; they are never
 *           |  logged. When the list cannot be read, the 60 second rule
 *           |  (live.ts BUSY_WINDOW_MS) is all there is.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { logFor } from '../obs/logger';
import { cwdKey } from './store';

const log = logFor('claude-code-holders');

/** How long one read of the process list is used. */
export const HOLDERS_TTL_MS = 5_000;
const LIST_TIMEOUT_MS = 8_000;

export interface ProcInfo {
  pid: number;
  ppid: number | null;
  name: string;
  /** null when the OS would not say (another user's process). */
  cmdline: string | null;
  /** The process's folder, where the OS tells it (not on Windows). */
  cwd?: string | null;
  /** When it started (ms since the epoch), when known. */
  startedAt?: number | null;
}

/** Reads the running processes. Injectable for tests. */
export interface ProcessLister {
  list(): Promise<ProcInfo[]>;
}

export interface SessionHolder {
  pid: number;
  /** It names the session on its command line, or it runs in the session's folder. */
  how: 'session' | 'folder';
}

export interface HolderQuery {
  sessionId: string;
  cwd: string | null;
  /** When the session's transcript was last written (ms), when known. */
  modifiedMs?: number | null;
}

/** Does this look like Claude Code's CLI (not the Claude desktop app, not NVX Ancile's bridge)? */
export function isClaudeCli(p: Pick<ProcInfo, 'name' | 'cmdline'>): boolean {
  const cmd = p.cmdline ?? '';
  if (/claude-bridge|AnthropicClaude|Claude\.app\/|--type=(renderer|gpu|utility)/i.test(cmd)) return false;
  if (/@anthropic-ai[\\/]claude-code|claude-code[\\/](cli|bin)/i.test(cmd)) return true;
  const name = p.name.toLowerCase();
  if (name === 'claude' || name === 'claude.exe') return true;
  // The program itself, as the first word of the command line: `claude`, `.../claude.exe`.
  return /^"?(?:[^"\s]*[\\/])?claude(?:\.exe)?"?(?:\s|$)/i.test(cmd);
}

/** Split a command line into words, keeping quoted parts together. */
export function words(cmdline: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(cmdline); m; m = re.exec(cmdline)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** The sessions a command line names (`--resume`, `-r`, `--session-id`, with a space or `=`). */
export function namedSessions(cmdline: string): string[] {
  const w = words(cmdline);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i] as string;
    const eq = /^(--resume|--session-id|-r)=(.+)$/.exec(a);
    if (eq) out.push(eq[2] as string);
    else if (
      (a === '--resume' || a === '-r' || a === '--session-id') &&
      w[i + 1] &&
      !w[i + 1]?.startsWith('-')
    )
      out.push(w[i + 1] as string);
  }
  return out;
}

export class SessionHolders {
  private cache: { at: number; procs: ProcInfo[] } | null = null;
  private pending: Promise<ProcInfo[]> | null = null;
  private failedOnce = false;
  private readonly now: () => number;
  private readonly selfPid: number;
  private readonly platform: NodeJS.Platform;
  private readonly ttlMs: number;

  constructor(
    private readonly opts: {
      lister: ProcessLister;
      ttlMs?: number;
      now?: () => number;
      /** Core's own process: everything below it is NVX Ancile's. */
      selfPid?: number;
      platform?: NodeJS.Platform;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.selfPid = opts.selfPid ?? process.pid;
    this.platform = opts.platform ?? process.platform;
    this.ttlMs = opts.ttlMs ?? HOLDERS_TTL_MS;
  }

  /** Claude Code processes NVX Ancile did not start, from a list at most a few seconds old. */
  async claudeProcesses(): Promise<ProcInfo[]> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.procs;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let all: ProcInfo[] = [];
      try {
        all = await this.opts.lister.list();
      } catch (err) {
        // Not being able to look is not an error the person can act on: the 60 s rule stands.
        if (!this.failedOnce)
          log.info(
            { err: (err as Error).message.slice(0, 200) },
            'could not read the process list; telling open sessions apart by when they were last written',
          );
        this.failedOnce = true;
        all = [];
      }
      const parent = new Map(all.map((p) => [p.pid, p.ppid]));
      const ours = (pid: number) => {
        let cur: number | null | undefined = pid;
        for (let i = 0; i < 32 && cur; i++) {
          if (cur === this.selfPid) return true;
          cur = parent.get(cur);
        }
        return false;
      };
      const procs = all.filter((p) => p.pid !== this.selfPid && isClaudeCli(p) && !ours(p.pid));
      this.cache = { at: this.now(), procs };
      return procs;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** The process holding this session, if one does. */
  async holder(q: HolderQuery): Promise<SessionHolder | null> {
    if (!q.sessionId) return null;
    const procs = await this.claudeProcesses();
    const folder = q.cwd ? cwdKey(q.cwd, this.platform) : null;
    let byFolder: SessionHolder | null = null;
    for (const p of procs) {
      const cmd = p.cmdline ?? '';
      const named = namedSessions(cmd);
      if (named.includes(q.sessionId) || words(cmd).includes(q.sessionId))
        return { pid: p.pid, how: 'session' };
      if (byFolder || named.length || !folder || !p.cwd) continue;
      if (cwdKey(p.cwd, this.platform) !== folder) continue;
      // It started after the session was last written: it cannot have it open.
      if (p.startedAt && q.modifiedMs && q.modifiedMs < p.startedAt - 1_000) continue;
      byFolder = { pid: p.pid, how: 'folder' };
    }
    return byFolder;
  }

  /**
   * Every session a Claude Code process outside NVX Ancile holds, among
   * `sessions` (newest first is best): one read of the process list. A
   * process naming a session holds it; one in a session's folder that names
   * none holds the newest session there written since it started.
   */
  async heldSessions(sessions: HolderQuery[]): Promise<Map<string, SessionHolder>> {
    const out = new Map<string, SessionHolder>();
    if (!sessions.length) return out;
    const procs = await this.claudeProcesses();
    if (!procs.length) return out;
    const known = new Set(sessions.map((s) => s.sessionId));
    const byFolder = new Map<string, HolderQuery[]>();
    for (const s of sessions) {
      if (!s.cwd) continue;
      const k = cwdKey(s.cwd, this.platform);
      byFolder.set(k, [...(byFolder.get(k) ?? []), s]);
    }
    for (const p of procs) {
      const cmd = p.cmdline ?? '';
      const named = namedSessions(cmd);
      const hit = [...named, ...words(cmd)].find((w) => known.has(w));
      if (hit) {
        out.set(hit, { pid: p.pid, how: 'session' });
        continue;
      }
      if (named.length || !p.cwd) continue;
      const here = byFolder.get(cwdKey(p.cwd, this.platform)) ?? [];
      const newest = here
        .filter((s) => !out.has(s.sessionId))
        .filter((s) => !(p.startedAt && s.modifiedMs && s.modifiedMs < p.startedAt - 1_000))
        .sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0))[0];
      if (newest) out.set(newest.sessionId, { pid: p.pid, how: 'folder' });
    }
    return out;
  }

  /** Forget the cached list (tests, and after a turn). */
  invalidate(): void {
    this.cache = null;
  }
}

/* ---- The system's process list ------------------------------------------ */

type Run = (cmd: string, args: string[]) => Promise<string>;

const run: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });

const WIN_QUERY = [
  '$ErrorActionPreference = "Stop";',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate |',
  'ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name;',
  // Only Claude-looking command lines leave PowerShell; everything else is just ids.
  'c = $(if ($_.CommandLine -match "claude") { $_.CommandLine } else { $null });',
  's = $(if ($_.CreationDate) { [int64](($_.CreationDate.ToUniversalTime() - [datetime]"1970-01-01").TotalMilliseconds) } else { $null }) } } |',
  'ConvertTo-Json -Compress',
].join(' ');

/** PowerShell's JSON for the query above. */
export function parseWindows(out: string): ProcInfo[] {
  const t = out.trim();
  if (!t) return [];
  const j = JSON.parse(t) as unknown;
  const rows = (Array.isArray(j) ? j : [j]) as {
    p?: unknown;
    pp?: unknown;
    n?: unknown;
    c?: unknown;
    s?: unknown;
  }[];
  return rows.flatMap((r) =>
    typeof r?.p === 'number'
      ? [
          {
            pid: r.p,
            ppid: typeof r.pp === 'number' ? r.pp : null,
            name: typeof r.n === 'string' ? r.n : '',
            cmdline: typeof r.c === 'string' ? r.c : null,
            startedAt: typeof r.s === 'number' ? r.s : null,
          },
        ]
      : [],
  );
}

/** wmic's CSV (Node,CommandLine,Name,ParentProcessId,ProcessId), for systems without CIM. */
export function parseWmic(out: string): ProcInfo[] {
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift()?.split(',') ?? [];
  const at = (k: string) => head.indexOf(k);
  return lines.flatMap((l) => {
    const c = l.split(',');
    // The command line may hold commas: it is everything between Node and the last three columns.
    const pid = Number(c.at(-1));
    const ppid = Number(c.at(-2));
    const name = c.at(-3) ?? '';
    const cmd = c.slice(Math.max(1, at('CommandLine')), -3).join(',');
    return Number.isFinite(pid) && pid > 0
      ? [{ pid, ppid: Number.isFinite(ppid) ? ppid : null, name, cmdline: /claude/i.test(cmd) ? cmd : null }]
      : [];
  });
}

/** `ps -A -ww -o pid=,ppid=,etimes=,command=` (etime on macOS, which has no etimes). */
export function parsePs(out: string, now: number, elapsed: 'etimes' | 'etime'): ProcInfo[] {
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) return [];
    const secs = elapsed === 'etimes' ? Number(m[3]) : etimeSeconds(m[3] as string);
    const cmd = (m[4] as string).trim();
    const name = (cmd.split(/\s+/)[0] ?? '').split('/').pop() ?? '';
    return [
      {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        name,
        cmdline: cmd,
        startedAt: Number.isFinite(secs) ? now - secs * 1000 : null,
      },
    ];
  });
}

/** "[[dd-]hh:]mm:ss" → seconds. */
export function etimeSeconds(s: string): number {
  const [d, rest] = s.includes('-') ? (s.split('-') as [string, string]) : ['0', s];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, mi, se] = parts as [number, number, number];
  return Number(d) * 86_400 + h * 3_600 + mi * 60 + se;
}

/** The running processes, read the usual way for this system. Never writes, never signals. */
export function systemLister(
  opts: { platform?: NodeJS.Platform; run?: Run; now?: () => number } = {},
): ProcessLister {
  const platform = opts.platform ?? process.platform;
  const exec = opts.run ?? run;
  const now = opts.now ?? Date.now;
  return {
    async list() {
      if (platform === 'win32') {
        try {
          return parseWindows(
            await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY]),
          );
        } catch (err) {
          try {
            return parseWmic(
              await exec('wmic', [
                'process',
                'get',
                'ProcessId,ParentProcessId,Name,CommandLine',
                '/format:csv',
              ]),
            );
          } catch {
            throw err;
          }
        }
      }
      const linux = platform === 'linux';
      const procs = parsePs(
        await exec('ps', ['-A', '-ww', '-o', `pid=,ppid=,${linux ? 'etimes' : 'etime'}=,command=`]),
        now(),
        linux ? 'etimes' : 'etime',
      );
      // The folder, only for Claude Code processes (read-only).
      for (const p of procs) {
        if (!isClaudeCli(p)) continue;
        if (linux) p.cwd = await readlink(`/proc/${p.pid}/cwd`).catch(() => null);
        else if (platform === 'darwin')
          p.cwd = await exec('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'])
            .then(
              (o) =>
                o
                  .split('\n')
                  .find((l) => l.startsWith('n'))
                  ?.slice(1) ?? null,
            )
            .catch(() => null);
      }
      return procs;
    },
  };
}
