/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Agent SDK loader
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · NOTICE.md
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Make Anthropic's Agent SDK available to the bridge at
 *           |  run time, on the person's own machine.
 *  How      |  MIT, a separate program; Core talks to it over a local
 *           |  WebSocket. The SDK is proprietary (© Anthropic): it is
 *           |  never a dependency and never bundled. The first time it
 *           |  is needed the bridge downloads the one pinned tarball
 *           |  from registry.npmjs.org (not the per-platform packages
 *           |  that carry a CLI binary: the person's installed Claude
 *           |  Code is used), checks its sha512 against the pinned
 *           |  integrity BEFORE unpacking, unpacks it under
 *           |  <data>/claude-sdk/node_modules/@anthropic-ai/, links the
 *           |  packages it may import (zod, the MCP SDK) to the bridge's
 *           |  own copies, and imports it by file URL.
 *  Note     |  The person gets the SDK from Anthropic under Anthropic's
 *           |  terms.
 * ------------------------------------------------------------------
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ClaudeAgentSdk, isClaudeAgentSdk } from './sdk-types';
import { extractTgz } from './tar';
import { fetchBytes, log as writeLog } from './util';

const log = {
  info: (f: Record<string, unknown>, msg: string) => writeLog('info', msg, f),
  warn: (f: Record<string, unknown>, msg: string) => writeLog('warn', msg, f),
};

/** The SDK version Ancile is tested against. Change all three together. */
export const SDK_VERSION = '0.3.296';
export const SDK_INTEGRITY =
  'sha512-Y+cZ2BT8X94mQ9GJOVyIqhjC/nWGvwozUVLjdkzX7aSt+zuo5tgk7Hdv9V7tEUQ9fKnEuiL6moYNWDeHqCD4Lw==';
export const SDK_TARBALL = `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-${SDK_VERSION}.tgz`;

/** Largest tarball accepted. */
const MAX_TARBALL = 50 * 1024 * 1024;

export interface SdkStatus {
  ready: boolean;
  version: string | null;
  error: string | null;
}

export interface SdkLoaderOptions {
  /** The bridge's data folder; the SDK lives in <dataDir>/claude-sdk. */
  dataDir: string;
  version?: string;
  integrity?: string;
  url?: string;
  /** Download the tarball (tests pass a local one). */
  download?: (url: string) => Promise<Buffer>;
  /** Import the unpacked module (tests pass a fake SDK). */
  importer?: (fileUrl: string) => Promise<unknown>;
}

/** Does `data` match an npm "sha512-<base64>" integrity string? */
export function matchesIntegrity(data: Buffer, integrity: string): boolean {
  const m = /^sha512-(.+)$/.exec(integrity.trim());
  if (!m) return false;
  return createHash('sha512').update(data).digest('base64') === m[1];
}

const fetchTarball = (url: string) =>
  fetchBytes(url, { timeoutMs: 120_000, attempts: 3, maxBytes: MAX_TARBALL });

/** Where a package the bridge depends on lives (its folder with package.json). */
function packageRoot(name: string): string | null {
  const req = createRequire(import.meta.url);
  try {
    return dirname(req.resolve(`${name}/package.json`));
  } catch {
    // Packages whose exports hide package.json: walk up from the entry point.
    try {
      let dir = dirname(req.resolve(name));
      while (dir !== dirname(dir)) {
        if (existsSync(join(dir, 'package.json')) && dir.replace(/\\/g, '/').endsWith(name)) return dir;
        dir = dirname(dir);
      }
    } catch {
      /* not installed */
    }
    return null;
  }
}

export class ClaudeSdkLoader {
  private readonly root: string;
  private readonly version: string;
  private readonly integrity: string;
  private readonly url: string;
  private sdk: ClaudeAgentSdk | null = null;
  private loading: Promise<ClaudeAgentSdk> | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: SdkLoaderOptions) {
    this.root = join(opts.dataDir, 'claude-sdk');
    this.version = opts.version ?? SDK_VERSION;
    this.integrity = opts.integrity ?? SDK_INTEGRITY;
    this.url = opts.url ?? SDK_TARBALL;
  }

  /** The folder the SDK package is unpacked into. */
  get packageDir(): string {
    return join(this.root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  }

  status(): SdkStatus {
    return { ready: !!this.sdk, version: this.sdk ? this.version : null, error: this.lastError };
  }

  /** Is a fetch under way? */
  get busy(): boolean {
    return !!this.loading;
  }

  /** The SDK, fetching and unpacking it the first time. Single-flight. */
  load(): Promise<ClaudeAgentSdk> {
    if (this.sdk) return Promise.resolve(this.sdk);
    this.loading ??= this.ensure()
      .then((sdk) => {
        this.sdk = sdk;
        this.lastError = null;
        return sdk;
      })
      .catch((err: unknown) => {
        this.lastError = (err as Error).message || 'The Agent SDK could not be loaded';
        log.warn({ err: this.lastError }, 'Claude Agent SDK not ready');
        throw err;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async installedVersion(): Promise<string | null> {
    try {
      const pkg = JSON.parse(await readFile(join(this.packageDir, 'package.json'), 'utf8')) as {
        version?: string;
      };
      const marker = (await readFile(join(this.root, '.integrity'), 'utf8')).trim();
      return marker === this.integrity ? (pkg.version ?? null) : null;
    } catch {
      return null;
    }
  }

  private async ensure(): Promise<ClaudeAgentSdk> {
    if ((await this.installedVersion()) !== this.version) await this.fetchAndUnpack();
    await this.linkPeers();
    const entry = join(this.packageDir, 'sdk.mjs');
    const importer = this.opts.importer ?? ((u: string) => import(u));
    const mod = await importer(pathToFileURL(entry).href);
    if (!isClaudeAgentSdk(mod))
      throw new Error('The Agent SDK does not offer the session functions Ancile needs');
    return mod;
  }

  private async fetchAndUnpack(): Promise<void> {
    log.info({ version: this.version }, 'fetching the Claude Agent SDK from npm');
    const tgz = await (this.opts.download ?? fetchTarball)(this.url);
    if (!matchesIntegrity(tgz, this.integrity)) {
      throw new Error('The Agent SDK download did not match its expected checksum, so it was not used');
    }
    await mkdir(this.root, { recursive: true });
    const tmp = join(this.root, `.unpack-${randomBytes(4).toString('hex')}`);
    try {
      await extractTgz(tgz, tmp, 1);
      await mkdir(dirname(this.packageDir), { recursive: true });
      await rm(this.packageDir, { recursive: true, force: true });
      await rename(tmp, this.packageDir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    await writeFile(join(this.root, '.integrity'), this.integrity);
  }

  /**
   * The SDK may import zod and the MCP SDK; the bridge ships both, so
   * link them in rather than download more. A junction on Windows needs
   * no special rights.
   */
  private async linkPeers(): Promise<void> {
    for (const name of ['zod', '@modelcontextprotocol/sdk']) {
      const target = packageRoot(name);
      if (!target) continue;
      const link = join(this.root, 'node_modules', ...name.split('/'));
      try {
        await lstat(link);
        continue;
      } catch {
        /* not linked yet */
      }
      try {
        await mkdir(dirname(link), { recursive: true });
        await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        log.warn({ err: (err as Error).message, name }, 'could not link a package for the Agent SDK');
      }
    }
  }
}
