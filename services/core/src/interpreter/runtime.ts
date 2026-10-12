/**
 * ------------------------------------------------------------------
 *  Title    |  The Python runtime on disk
 *  Ref      |  docs/interpreter.md · contracts PYODIDE_*
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Fetch Pyodide on first use, check every file against a
 *           |  pinned SHA-256 before it is kept, and hand the Cockpit
 *           |  only files that passed. Nothing is bundled with the
 *           |  installer.
 *  How      |  The runtime's own files are pinned in contracts. Package
 *           |  wheels are checked against the pinned lock file, and
 *           |  only the allow-listed packages (with their dependencies)
 *           |  are served at all. Downloads go through
 *           |  @nvx/resilience (timeout, retries), are written to a
 *           |  temporary file and renamed into place, and are shared
 *           |  when several requests want the same file.
 *  Note     |  The lock the Cockpit receives lists only the allowed
 *           |  packages, so `import x` of anything else fails cleanly
 *           |  with "No module named x".
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AncileError, PYODIDE_CDN, PYODIDE_FILES, PYODIDE_PACKAGES, PYODIDE_VERSION } from '@nvx/contracts';
import { ClassifiedError, classifyStatus, guarded } from '@nvx/resilience';
import { tracedFetch } from '../context';
import { logFor } from '../obs/logger';

const log = logFor('interpreter');

type Fetcher = (url: string, signal: AbortSignal) => Promise<Response>;

interface LockPackage {
  name: string;
  file_name: string;
  sha256: string;
  depends: string[];
  imports?: string[];
}
interface Lock {
  info: unknown;
  packages: Record<string, LockPackage>;
  [k: string]: unknown;
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The allow-listed packages and everything they depend on. */
export function packageClosure(lock: Lock, roots: readonly string[] = PYODIDE_PACKAGES): Set<string> {
  const out = new Set<string>();
  const walk = (n: string) => {
    if (out.has(n) || !lock.packages[n]) return;
    out.add(n);
    for (const d of lock.packages[n].depends) walk(d);
  };
  for (const r of roots) walk(r);
  return out;
}

const unavailable = (detail: string, cause?: unknown) =>
  new AncileError({
    code: 'interpreter.runtime_unavailable',
    title: 'The Python runtime could not be downloaded.',
    hint: 'Check this machine can reach cdn.jsdelivr.net, then run the code again. It is downloaded once (about 14 MB, more for plotting).',
    status: 503,
    retryable: true,
    errorClass: 'transient',
    detail,
    cause,
  });

export class PyodideRuntime {
  readonly dir: string;
  private readonly fetcher: Fetcher;
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private lock: Lock | null = null;
  private allowed: Map<string, string> | null = null;
  private readonly pins: Readonly<Record<string, string>>;
  downloading = 0;

  constructor(opts: {
    dataDir: string;
    fetch?: Fetcher;
    base?: string;
    /** Tests only: other pinned hashes. */
    pins?: Readonly<Record<string, string>>;
  }) {
    this.pins = opts.pins ?? PYODIDE_FILES;
    this.dir = join(opts.dataDir, 'runtime', 'pyodide', PYODIDE_VERSION);
    const base = opts.base ?? PYODIDE_CDN;
    this.fetcher =
      opts.fetch ??
      ((file, signal) =>
        tracedFetch(`${base}${file}`, { signal, headers: { 'x-ancile-probe': 'background' } }));
  }

  /** The verified bytes of one runtime file (downloaded once). Throws for files not allowed. */
  async file(name: string): Promise<Uint8Array> {
    if (name === 'pyodide-lock.json')
      return new TextEncoder().encode(JSON.stringify(await this.servedLock()));
    const want = await this.expected(name);
    if (!want)
      throw new AncileError({
        code: 'interpreter.file_not_allowed',
        title: `${name.slice(0, 80)} is not part of the Python runtime.`,
        hint: 'Only the pinned Pyodide files and the allowed packages are served.',
        status: 404,
        errorClass: 'permanent',
      });
    return this.cached(name, want);
  }

  /** Bytes of the runtime already here. */
  async cachedBytes(): Promise<number> {
    let n = 0;
    for (const f of Object.keys(this.pins))
      n += await stat(join(this.dir, f)).then(
        (s) => s.size,
        () => 0,
      );
    return n;
  }

  async ready(): Promise<boolean> {
    for (const f of Object.keys(this.pins))
      if (
        !(await stat(join(this.dir, f)).then(
          () => true,
          () => false,
        ))
      )
        return false;
    return true;
  }

  private async expected(name: string): Promise<string | null> {
    if (Object.hasOwn(this.pins, name)) return this.pins[name] as string;
    await this.loadLock();
    return this.allowed?.get(name) ?? null;
  }

  private async loadLock(): Promise<Lock> {
    if (this.lock) return this.lock;
    const bytes = await this.cached('pyodide-lock.json', this.pins['pyodide-lock.json'] as string);
    const lock = JSON.parse(new TextDecoder().decode(bytes)) as Lock;
    const keep = packageClosure(lock);
    this.allowed = new Map(
      [...keep].map((n) => [lock.packages[n]?.file_name as string, lock.packages[n]?.sha256 as string]),
    );
    this.lock = lock;
    return lock;
  }

  /** The lock as the Cockpit sees it: only the allowed packages. */
  async servedLock(): Promise<Lock> {
    const lock = await this.loadLock();
    const keep = packageClosure(lock);
    return {
      ...lock,
      packages: Object.fromEntries(Object.entries(lock.packages).filter(([n]) => keep.has(n))),
    };
  }

  private cached(name: string, want: string): Promise<Uint8Array> {
    const running = this.inflight.get(name);
    if (running) return running;
    const p = this.readOrFetch(name, want).finally(() => this.inflight.delete(name));
    this.inflight.set(name, p);
    return p;
  }

  private async readOrFetch(name: string, want: string): Promise<Uint8Array> {
    const path = join(this.dir, name);
    const have = await readFile(path).catch(() => null);
    if (have && sha256(have) === want) return have;
    if (have) {
      // A damaged or tampered copy: never served, fetched again.
      log.warn({ file: name }, 'runtime file failed its hash check; downloading it again');
      await unlink(path).catch(() => undefined);
    }
    this.downloading++;
    try {
      const bytes = await guarded(
        { key: 'pyodide-cdn', timeoutMs: 180_000, retry: { maxAttempts: 3 } },
        async (signal) => {
          const res = await this.fetcher(name, signal);
          if (!res.ok)
            throw new ClassifiedError(classifyStatus(res.status), `the CDN answered ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        },
      ).catch((err: unknown) => {
        throw unavailable(`${name}: ${(err as Error).message}`, err);
      });
      const got = sha256(bytes);
      if (got !== want)
        throw new AncileError({
          code: 'interpreter.runtime_mismatch',
          title: 'A downloaded Python runtime file did not match its pinned fingerprint.',
          hint: 'It was thrown away and nothing ran. Try again later; if it keeps happening, report it, since the download may have been tampered with.',
          status: 502,
          errorClass: 'permanent',
          detail: `${name}: expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…`,
        });
      await mkdir(this.dir, { recursive: true });
      const tmp = `${path}.${process.pid}.${Date.now()}.part`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
      log.info({ file: name, bytes: bytes.length }, 'runtime file downloaded and verified');
      return bytes;
    } finally {
      this.downloading--;
    }
  }
}
