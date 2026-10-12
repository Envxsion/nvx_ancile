/**
 * ------------------------------------------------------------------
 *  Title    |  Is this Claude Code Anthropic's?
 *  Ref      |  docs/claude-code.md (Checking the install)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Before NVX Ancile runs sessions through Claude Code,
 *           |  check the executable is the one Anthropic published.
 *  How      |  The SHA-256 of the executable must equal the checksum in
 *           |  Anthropic's release manifest for that version and this
 *           |  platform (downloads.claude.ai, over HTTPS). On Windows
 *           |  its Authenticode signature must be valid and signed by
 *           |  "Anthropic, PBC"; on macOS `codesign --verify` must pass
 *           |  and name Anthropic. The answer is cached per version and
 *           |  file (path, size, modified time).
 *  Note     |  TODO(phase-2): verify the manifest's own signature too
 *           |  (needs an OpenPGP verifier with a licence that fits).
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ClassifiedError, classifyStatus, guarded } from '@nvx/resilience';
import { tracedFetch } from '../context';
import { logFor } from '../obs/logger';
import { type Spawner, spawnProcess } from './cli';

const log = logFor('claude-code');

export type VerifyState = 'unchecked' | 'checking' | 'verified' | 'failed';
export interface Verification {
  state: VerifyState;
  error: string | null;
}

export const MANIFEST_URL = (version: string) =>
  `https://downloads.claude.ai/claude-code-releases/${encodeURIComponent(version)}/manifest.json`;

/** Anthropic's manifest key for this machine: win32-x64, darwin-arm64, linux-x64-musl… */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = isMusl(),
): string {
  return `${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
}

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (b) => h.update(b))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex');
}

async function fetchManifest(version: string): Promise<unknown> {
  return guarded({ key: 'claude-manifest', timeoutMs: 20_000, retry: { maxAttempts: 3 } }, async (signal) => {
    const res = await tracedFetch(MANIFEST_URL(version), { signal });
    if (!res.ok)
      throw new ClassifiedError(classifyStatus(res.status), `downloads.claude.ai answered ${res.status}`);
    return res.json();
  });
}

const FAIL = 'This Claude Code install could not be verified';

export interface VerifierOptions {
  manifest?: (version: string) => Promise<unknown>;
  hash?: (path: string) => Promise<string>;
  spawn?: Spawner;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Skip the OS signature check (tests). */
  signature?: (path: string) => Promise<string | null>;
}

export class ClaudeVerifier {
  private readonly cache = new Map<string, Verification>();
  private readonly running = new Map<string, Promise<Verification>>();
  private last: Verification = { state: 'unchecked', error: null };
  /** Executables that passed once: a later read failure means something removed or locked them. */
  private readonly passed = new Set<string>();

  constructor(private readonly opts: VerifierOptions = {}) {}

  /** The result for the last executable checked. */
  current(): Verification {
    return this.last;
  }

  /** Check `exe` is Anthropic's Claude Code `version`. Cached; single-flight per file. */
  async verify(exe: string, version: string): Promise<Verification> {
    let real = exe;
    let key = `${exe}|${version}`;
    try {
      real = await realpath(exe);
      const s = await stat(real);
      key = `${real}|${s.size}|${s.mtimeMs}|${version}`;
    } catch {
      /* the check below reports it */
    }
    const hit = this.cache.get(key);
    if (hit) {
      this.last = hit;
      return hit;
    }
    let run = this.running.get(key);
    if (!run) {
      this.last = { state: 'checking', error: null };
      run = this.check(real, version)
        .then((v) => {
          this.cache.set(key, v);
          return v;
        })
        .finally(() => this.running.delete(key));
      this.running.set(key, run);
    }
    this.last = await run;
    return this.last;
  }

  private async check(exe: string, version: string): Promise<Verification> {
    const platform = this.opts.platform ?? process.platform;
    const keyName = platformKey(platform, this.opts.arch ?? process.arch);
    let manifest: unknown;
    try {
      manifest = await (this.opts.manifest ?? fetchManifest)(version);
    } catch (err) {
      log.warn({ err: (err as Error).message, version }, 'Claude Code release manifest unavailable');
      return {
        state: 'failed',
        error: `${FAIL}: Anthropic's release list could not be reached. Check this computer is online, then press Check again.`,
      };
    }
    const entry = (manifest as { platforms?: Record<string, { checksum?: unknown }> })?.platforms?.[keyName];
    const expected = typeof entry?.checksum === 'string' ? entry.checksum.toLowerCase() : null;
    if (!expected)
      return {
        state: 'failed',
        error: `${FAIL}: Anthropic lists no ${keyName} build of version ${version}.`,
      };
    let actual: string;
    try {
      actual = (await (this.opts.hash ?? sha256File)(exe)).toLowerCase();
    } catch (err) {
      // Gone, or locked, after it was found (or after it passed before): security software, usually.
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (this.passed.has(exe) || ['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(code))
        return {
          state: 'failed',
          error: `${FAIL}: the program at ${exe} was removed or blocked after it was checked. Security software may have quarantined it: allow the folder ${dirname(exe)} in your antivirus, then press Check again.`,
        };
      return { state: 'failed', error: `${FAIL}: the program at ${exe} could not be read.` };
    }
    if (actual !== expected) {
      log.warn({ version, platform: keyName }, 'Claude Code checksum does not match the release manifest');
      return {
        state: 'failed',
        error: `${FAIL}: it does not match Anthropic's published ${version} build. Reinstall it from claude.ai/install.`,
      };
    }
    const sig = await (this.opts.signature ?? ((p) => this.osSignature(p, platform)))(exe);
    if (sig) return { state: 'failed', error: `${FAIL}: ${sig}` };
    this.passed.add(exe);
    return { state: 'verified', error: null };
  }

  /** The OS code-signature check; null when it passes (or the OS has none). */
  private async osSignature(exe: string, platform: NodeJS.Platform): Promise<string | null> {
    const run = this.opts.spawn ?? spawnProcess;
    if (platform === 'win32') {
      const r = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$s = Get-AuthenticodeSignature -LiteralPath $env:ANCILE_VERIFY_PATH; "$($s.Status)|$($s.SignerCertificate.Subject)"',
        ],
        { timeoutMs: 30_000, env: { ANCILE_VERIFY_PATH: exe } },
      );
      const [status, subject = ''] = r.stdout.trim().split('|');
      if (r.code !== 0 || status !== 'Valid') return 'its Windows signature is not valid.';
      if (!/CN="?Anthropic, PBC"?/.test(subject)) return 'it is not signed by Anthropic, PBC.';
      return null;
    }
    if (platform === 'darwin') {
      const v = await run('codesign', ['--verify', '--strict', exe], { timeoutMs: 30_000 });
      if (v.code !== 0) return 'its macOS signature is not valid.';
      const d = await run('codesign', ['-dv', '--verbose=2', exe], { timeoutMs: 30_000 });
      if (!/Authority=.*Anthropic/.test(`${d.stdout}\n${d.stderr}`)) return 'it is not signed by Anthropic.';
      return null;
    }
    return null;
  }
}
