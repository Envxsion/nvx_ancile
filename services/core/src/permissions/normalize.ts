/**
 * ------------------------------------------------------------------
 *  Title    |  Resource normalisation
 *  Ref      |  DESIGN.md §5.3, §5.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Permissions are checked on what a tool will actually
 *           |  touch, so the resource is made canonical first: real
 *           |  paths with symlinks resolved, lowercased hosts, no
 *           |  credentials in URLs. Anything that tries to climb out
 *           |  with `..` is refused outright.
 *  How      |  Pure functions over URIs of the form <scheme>:<rest>.
 *           |  The filesystem is injected (realpath) so this stays
 *           |  testable and works for a container workspace too.
 * ------------------------------------------------------------------
 */

import { posix } from 'node:path';

export type NormalizeResult =
  | { ok: true; resource: string; outsideRoot: boolean }
  | {
      ok: false;
      reason: 'path_escape' | 'not_absolute' | 'bad_url' | 'unsupported_scheme' | 'invalid';
      detail: string;
    };

export interface FsProbe {
  /** Resolve symlinks. Reject (any error) when the path does not exist. */
  realpath(path: string): Promise<string>;
}

export interface NormalizeOptions {
  workspaceRoot: string;
  fs?: FsProbe;
}

export function scheme(resource: string): string {
  const i = resource.indexOf(':');
  return i > 0 ? resource.slice(0, i) : '';
}

/** Is `child` the same as or below `root`? Both must be normalised posix paths. */
export function isWithin(child: string, root: string): boolean {
  const r = root.endsWith('/') ? root.slice(0, -1) : root;
  return child === r || child.startsWith(`${r}/`);
}

async function realOrNearest(path: string, fs: FsProbe | undefined): Promise<string> {
  if (!fs) return path;
  try {
    return posix.normalize(await fs.realpath(path));
  } catch {
    // Not there yet (a write creating a file): resolve the nearest existing parent.
    const parent = posix.dirname(path);
    if (parent === path) return path;
    return posix.join(await realOrNearest(parent, fs), posix.basename(path));
  }
}

export async function normalizeFsPath(raw: string, opts: NormalizeOptions): Promise<NormalizeResult> {
  const path = raw.replace(/\\/g, '/');
  if (path.includes('\0')) return { ok: false, reason: 'invalid', detail: 'path contains a NUL byte' };
  if (!path.startsWith('/'))
    return { ok: false, reason: 'not_absolute', detail: `"${raw}" is not an absolute path` };
  if (path.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: 'path_escape', detail: `"${raw}" uses ".." to leave its directory` };
  }
  let p = posix.normalize(path);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const real = await realOrNearest(p, opts.fs);
  const root = posix.normalize(opts.workspaceRoot);
  const lexicallyInside = isWithin(p, root);
  const reallyInside = isWithin(real, root);
  if (lexicallyInside && !reallyInside) {
    return {
      ok: false,
      reason: 'path_escape',
      detail: `"${raw}" is a link that points outside the workspace (${real})`,
    };
  }
  return { ok: true, resource: `fs:${real}`, outsideRoot: !reallyInside };
}

export function normalizeUrl(raw: string): NormalizeResult {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'bad_url', detail: `"${raw}" is not a URL` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme', detail: `${u.protocol} URLs are not allowed` };
  }
  u.username = '';
  u.password = '';
  u.hash = '';
  // URL already lowercases the host and drops default ports.
  return { ok: true, resource: `http:${u.toString()}`, outsideRoot: true };
}

export async function normalizeResource(resource: string, opts: NormalizeOptions): Promise<NormalizeResult> {
  const s = scheme(resource);
  const rest = resource.slice(s.length + 1);
  switch (s) {
    case 'fs':
      return normalizeFsPath(rest, opts);
    case 'http':
      return normalizeUrl(rest);
    case 'shell':
      return { ok: true, resource: `shell:${rest.trim().replace(/\s+/g, ' ')}`, outsideRoot: false };
    case '':
      return {
        ok: false,
        reason: 'invalid',
        detail: `"${resource}" has no scheme (expected e.g. fs:/workspace/a.md)`,
      };
    default:
      if (rest.includes('\0'))
        return { ok: false, reason: 'invalid', detail: 'resource contains a NUL byte' };
      return { ok: true, resource: `${s}:${rest.trim()}`, outsideRoot: false };
  }
}
