/**
 * ------------------------------------------------------------------
 *  Title    |  Installing Claude Code
 *  Ref      |  docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Install Claude Code with Anthropic's official native
 *           |  installer when the person asks (or has Auto-install on).
 *  How      |  Windows: PowerShell runs claude.ai/install.ps1; macOS and
 *           |  Linux: bash runs claude.ai/install.sh. Both install into
 *           |  the person's home folder and need no admin rights. One
 *           |  install at a time; its state (idle, installing,
 *           |  installed, failed with the reason) is in the status.
 *  Note     |  The installer is Anthropic's, unmodified. Ancile only
 *           |  runs it, with a ten-minute limit.
 * ------------------------------------------------------------------
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCodeInstallState } from '@nvx/contracts';
import { logFor } from '../obs/logger';
import { type Spawner, spawnProcess } from './cli';

const log = logFor('claude-code');

export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Where Anthropic's installer puts Claude Code: ~/.local/bin on every platform. */
export function installFolder(home: string = homedir()): string {
  return join(home, '.local', 'bin');
}

/** The official installer command for this platform. */
export function installerCommand(platform: NodeJS.Platform = process.platform): {
  cmd: string;
  args: string[];
} {
  if (platform === 'win32')
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'irm https://claude.ai/install.ps1 | iex',
      ],
    };
  return { cmd: 'bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] };
}

/** The installer's last few meaningful lines, as the reason it failed. */
export function failureWords(stderr: string, stdout: string, code: number, timedOut: boolean): string {
  if (timedOut) return 'The installer took longer than ten minutes and was stopped.';
  if (code === 127)
    return 'The installer could not start: PowerShell (Windows) or bash and curl (macOS, Linux) are needed.';
  const said = (stderr.trim() || stdout.trim())
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  return said
    ? `The installer stopped: ${said.slice(0, 400)}`
    : `The installer stopped with exit code ${code}.`;
}

export interface InstallerOptions {
  spawn?: Spawner;
  platform?: NodeJS.Platform;
  /** After a successful run: is Claude Code findable now? */
  found: () => boolean;
  onChange?: (state: ClaudeCodeInstallState, error: string | null) => void;
}

export class ClaudeInstaller {
  private st: ClaudeCodeInstallState = 'idle';
  private err: string | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly opts: InstallerOptions) {}

  state(): { state: ClaudeCodeInstallState; error: string | null } {
    return { state: this.st, error: this.err };
  }

  private set(state: ClaudeCodeInstallState, error: string | null) {
    this.st = state;
    this.err = error;
    this.opts.onChange?.(state, error);
  }

  /** Start installing; a second call while one runs joins it. */
  install(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    this.set('installing', null);
    const { cmd, args } = installerCommand(this.opts.platform);
    log.info({ cmd }, 'installing Claude Code with the official installer');
    try {
      const r = await (this.opts.spawn ?? spawnProcess)(cmd, args, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        maxBytes: 64 * 1024,
      });
      if (r.code !== 0) {
        this.set('failed', failureWords(r.stderr, r.stdout, r.code, r.timedOut));
        log.warn({ code: r.code, timed_out: r.timedOut }, 'Claude Code install failed');
        return;
      }
      if (!this.opts.found()) {
        // A successful install that is gone at once is usually security software quarantining it.
        this.set(
          'failed',
          `The installer finished, but Claude Code was not found in ${installFolder()} or on PATH. If security software removed it, allow that folder in your antivirus; then restart NVX Ancile and press Check again.`,
        );
        return;
      }
      this.set('installed', null);
    } catch (e) {
      this.set('failed', `The installer could not run: ${(e as Error).message}`.slice(0, 400));
    }
  }
}
