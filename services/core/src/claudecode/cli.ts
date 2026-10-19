/**
 * ------------------------------------------------------------------
 *  Title    |  The Claude Code CLI
 *  Ref      |  docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Find the person's own Claude Code, read its version, and
 *           |  ask it whether it is signed in.
 *  How      |  Only Claude Code's public subcommands: `--version` and
 *           |  `auth status --json`. Every run has a timeout (resilience
 *           |  withTimeout) and an output cap, and is an argv array,
 *           |  never a shell string. Status is cached for ten seconds.
 *  Note     |  `auth status` also reports the account's email and
 *           |  organisation. The organisation is dropped on parse. The
 *           |  email is kept as `account` for the owner to see in
 *           |  Settings only: never logged, never in telemetry, never
 *           |  sent anywhere. Ancile never reads Claude Code's
 *           |  credential files.
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { DeadlineExceededError, withTimeout } from '@nvx/resilience';
import { sendGuardActive } from '../gateway/e2e-guard';

export const MIN_VERSION = '2.1.200';
const STATUS_TTL_MS = 10_000;

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnOptions {
  timeoutMs: number;
  env?: Record<string, string>;
  maxBytes?: number;
}

/** Run a program to completion. Exit code 127 means it could not start. */
export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => Promise<ProcResult>;

/** The default spawner: argv only, hidden window, killed at the deadline. */
export const spawnProcess: Spawner = async (cmd, args, opts) => {
  const max = opts.maxBytes ?? 256 * 1024;
  let out = '';
  let err = '';
  let killed: (() => void) | null = null;
  try {
    return await withTimeout(
      (signal) =>
        new Promise<ProcResult>((resolve) => {
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(cmd, args, {
              windowsHide: true,
              env: { ...process.env, NO_COLOR: '1', ...opts.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (e) {
            resolve({ code: 127, stdout: '', stderr: String(e), timedOut: false });
            return;
          }
          killed = () => child.kill();
          signal.addEventListener('abort', () => child.kill(), { once: true });
          child.stdout?.on('data', (b: Buffer) => {
            if (out.length < max) out += b.toString('utf8');
          });
          child.stderr?.on('data', (b: Buffer) => {
            if (err.length < 64 * 1024) err += b.toString('utf8');
          });
          child.on('error', (e) => resolve({ code: 127, stdout: '', stderr: String(e), timedOut: false }));
          child.on('close', (code) =>
            resolve({ code: code ?? 1, stdout: out.slice(0, max), stderr: err, timedOut: false }),
          );
        }),
      { ms: opts.timeoutMs },
    );
  } catch (e) {
    (killed as (() => void) | null)?.();
    if (e instanceof DeadlineExceededError) return { code: 124, stdout: out, stderr: err, timedOut: true };
    throw e;
  }
};

/** How to run Claude Code: the program, and any arguments that come first. */
export interface Located {
  /** What the person sees as the executable. */
  path: string;
  cmd: string;
  prefix: string[];
}

export interface LocateOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (p: string) => boolean;
  /** An explicit path that wins when it exists. */
  override?: string | null;
}

/** "2.1.286 (Claude Code)" → "2.1.286". */
export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/** a < b, comparing dotted numbers. */
export function olderThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The native executable an npm shim (claude.cmd) points at, or the
 * package's JavaScript entry to run with Node.
 */
function throughShim(shim: string, exists: (p: string) => boolean, win: boolean): Located | null {
  // Windows paths, read as Windows reads them even where this runs elsewhere (the tests).
  const { dirname, join } = win ? win32 : posix;
  const pkg = join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code');
  for (const exe of ['bin/claude.exe', 'claude.exe']) {
    const p = join(pkg, exe);
    if (exists(p)) return { path: p, cmd: p, prefix: [] };
  }
  try {
    const j = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof j.bin === 'string' ? j.bin : j.bin?.claude;
    if (!bin) return null;
    const p = join(pkg, bin);
    if (!exists(p)) return null;
    if (/\.(c|m)?js$/i.test(p)) return { path: shim, cmd: process.execPath, prefix: [p] };
    return { path: p, cmd: p, prefix: [] };
  } catch {
    return null;
  }
}

/**
 * Find Claude Code: an explicit path, then PATH, then the folders its
 * installers use. A Windows npm shim (.cmd) cannot run without a shell,
 * so it is resolved to the executable it starts.
 */
export function locate(opts: LocateOptions = {}): Located | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? isFile;
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const join2 = (a: string, b: string) =>
    win ? `${a.replace(/[\\/]+$/, '')}\\${b}` : `${a.replace(/\/+$/, '')}/${b}`;

  if (opts.override && exists(opts.override)) return { path: opts.override, cmd: opts.override, prefix: [] };

  const pathDirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  const known = win
    ? [join2(home, '.local\\bin')]
    : [
        join2(home, '.local/bin'),
        env.CLAUDE_CONFIG_DIR ? join2(env.CLAUDE_CONFIG_DIR, 'local') : join2(home, '.claude/local'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        join2(home, '.npm-global/bin'),
      ];
  const npmDir = win && env.APPDATA ? join2(env.APPDATA, 'npm') : null;
  const dirs = [...pathDirs, ...known, ...(npmDir ? [npmDir] : [])];

  // PATH order, as a terminal would choose; in each folder the native
  // executable first, then (Windows) an npm shim resolved to what it runs.
  for (const d of dirs) {
    const p = join2(d, win ? 'claude.exe' : 'claude');
    if (exists(p)) return { path: p, cmd: p, prefix: [] };
    if (win) {
      const shim = join2(d, 'claude.cmd');
      if (exists(shim)) {
        const via = throughShim(shim, exists, win);
        if (via) return via;
      }
    }
  }
  return null;
}

export interface AuthInfo {
  signed_in: boolean;
  auth_method: string | null;
  plan: string | null;
  /** The email Claude Code is signed in as: for Settings only, never logged or sent. */
  account: string | null;
  projects_dir: string | null;
  config_dir: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The fields Ancile uses from `claude auth status --json`. The email is kept
 * as `account` and shown to the owner in Settings only: never logged, never in
 * telemetry, never sent anywhere. Everything else (organisation) is dropped here.
 */
export function parseAuthStatus(stdout: string): AuthInfo | null {
  let j: Record<string, unknown>;
  try {
    const start = stdout.indexOf('{');
    if (start < 0) return null;
    j = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    signed_in: j.loggedIn === true,
    auth_method: str(j.authMethod),
    plan: str(j.subscriptionType),
    account: str(j.email),
    projects_dir: str(j.projectsDirectory),
    config_dir: str(j.configDirectory),
  };
}

export interface CliStatus extends AuthInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
  version_ok: boolean;
  min_version: string;
}

export interface ClaudeCliOptions {
  spawn?: Spawner;
  locate?: () => Located | null;
  /** Extra environment for every run (e.g. DISABLE_TELEMETRY). */
  env?: () => Promise<Record<string, string>> | Record<string, string>;
  now?: () => number;
}

/** Claude Code as Core sees it: where it is, which version, signed in or not. */
export class ClaudeCli {
  private cache: { at: number; status: CliStatus } | null = null;
  private inflight: Promise<CliStatus> | null = null;
  private readonly spawner: Spawner;
  private readonly now: () => number;

  constructor(private readonly opts: ClaudeCliOptions = {}) {
    this.spawner = opts.spawn ?? spawnProcess;
    this.now = opts.now ?? Date.now;
  }

  where(): Located | null {
    // The test profile never finds your Claude Code (gateway/e2e-guard.ts).
    if (sendGuardActive()) return null;
    return (this.opts.locate ?? locate)();
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Run Claude Code with these arguments. */
  async run(args: string[], timeoutMs: number): Promise<ProcResult & { located: Located | null }> {
    const at = this.where();
    if (!at) return { code: 127, stdout: '', stderr: 'not installed', timedOut: false, located: null };
    const env = (await this.opts.env?.()) ?? {};
    const r = await this.spawner(at.cmd, [...at.prefix, ...args], { timeoutMs, env });
    return { ...r, located: at };
  }

  /** Spawn a long-lived Claude Code process that is not waited for. */
  async start(args: string[]): Promise<{ child: ReturnType<typeof spawn>; located: Located } | null> {
    const at = this.where();
    if (!at) return null;
    const env = (await this.opts.env?.()) ?? {};
    const child = spawn(at.cmd, [...at.prefix, ...args], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: false,
    });
    return { child, located: at };
  }

  async status(fresh = false): Promise<CliStatus> {
    if (!fresh && this.cache && this.now() - this.cache.at < STATUS_TTL_MS) return this.cache.status;
    this.inflight ??= this.read()
      .then((status) => {
        this.cache = { at: this.now(), status };
        return status;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async read(): Promise<CliStatus> {
    const none: CliStatus = {
      installed: false,
      version: null,
      path: null,
      version_ok: false,
      min_version: MIN_VERSION,
      signed_in: false,
      auth_method: null,
      plan: null,
      account: null,
      projects_dir: null,
      config_dir: null,
    };
    const v = await this.run(['--version'], 15_000);
    if (!v.located || v.code === 127) return none;
    const version = v.code === 0 ? parseVersion(v.stdout) : null;
    const base: CliStatus = {
      ...none,
      installed: true,
      path: v.located.path,
      version,
      version_ok: !!version && !olderThan(version, MIN_VERSION),
    };
    if (!version) return base;
    const a = await this.run(['auth', 'status', '--json'], 15_000);
    const auth = parseAuthStatus(a.stdout);
    return auth ? { ...base, ...auth } : base;
  }
}

/** Does a path exist on disk (a folder or a file)? */
export const pathExists = (p: string): boolean => existsSync(p);
