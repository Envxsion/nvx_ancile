/**
 * ------------------------------------------------------------------
 *  Title    |  Editor roots
 *  Ref      |  packages/contracts/src/files.ts · docs/api.md (Files)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The folders the code editor may reach, and where a path
 *           |  asked for actually lands: the workspace (labs inside
 *           |  it), registered repositories, and Claude Code project
 *           |  folders. Nothing else on the machine.
 *  How      |  Every root and every path is resolved with realpath
 *           |  (the nearest existing parent for a file not made yet),
 *           |  so a symlink inside a root that points out of it lands
 *           |  outside, and is refused. The most specific root wins.
 *           |  "/workspace/…" is the workspace as models see it.
 *  Note     |  Comparison is case-insensitive on Windows and macOS'
 *           |  default volumes are not assumed: only win32 folds case.
 * ------------------------------------------------------------------
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileRootKind } from '@nvx/contracts';
import type { FsProbe } from '../permissions/normalize';

export interface FileRoot {
  kind: FileRootKind;
  /** Real, absolute, native path. */
  path: string;
  label: string;
}

export interface RootSource {
  roots(): Promise<FileRoot[]>;
}

export interface RootDeps {
  workspace: { dir: string; root: string };
  repos?: () => Promise<{ name: string; root: string }[]>;
  claudeProjects?: () => Promise<{ cwd: string }[]>;
  platform?: NodeJS.Platform;
}

async function real(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** realpath, or the realpath of the nearest existing parent with the rest appended. */
export async function realOrNearest(p: string): Promise<string> {
  const r = await real(p);
  if (r) return r;
  const parent = dirname(p);
  if (parent === p) return p;
  return join(await realOrNearest(parent), basename(p));
}

export function rootSource(deps: RootDeps): RootSource {
  return {
    async roots() {
      const out: FileRoot[] = [];
      const ws = await real(deps.workspace.dir);
      if (ws) out.push({ kind: 'workspace', path: ws, label: 'Workspace' });
      for (const r of (await deps.repos?.().catch(() => [])) ?? []) {
        const p = await real(r.root);
        if (p) out.push({ kind: 'repo', path: p, label: r.name });
      }
      for (const c of (await deps.claudeProjects?.().catch(() => [])) ?? []) {
        const p = await real(c.cwd);
        if (p) out.push({ kind: 'claude_code', path: p, label: basename(p) || p });
      }
      return out;
    },
  };
}

/** Is `child` the folder `root` or inside it (whole segments only)? */
export function within(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const rel = relative(fold(root), fold(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep));
}

/** "/C:/a/b" (a posix-form Windows path, as resources write it) → "C:/a/b". */
function nativeForm(p: string): string {
  return /^\/[a-zA-Z]:[\\/]/.test(p) ? p.slice(1) : p;
}

export interface Located {
  root: FileRoot;
  /** Real native path of the file (it may not exist yet). */
  path: string;
}

/**
 * Where an asked-for path lands, or null when it is outside every root.
 * Relative paths and "/workspace/…" are inside the workspace.
 */
export async function locate(
  asked: string,
  roots: FileRoot[],
  workspace: { dir: string; root: string },
  platform: NodeJS.Platform = process.platform,
): Promise<Located | null> {
  const raw = asked.trim();
  if (!raw || raw.includes('\0')) return null;
  const slashed = raw.replace(/\\/g, '/');
  let target: string;
  if (slashed === workspace.root || slashed.startsWith(`${workspace.root}/`)) {
    const rest = slashed.slice(workspace.root.length).replace(/^\/+/, '');
    target = rest ? join(workspace.dir, ...rest.split('/')) : workspace.dir;
  } else {
    const native = nativeForm(raw);
    target = isAbsolute(native) ? resolve(native) : resolve(workspace.dir, native);
  }
  const resolved = await realOrNearest(target);
  let best: FileRoot | null = null;
  for (const r of roots)
    if (within(resolved, r.path, platform) && (!best || r.path.length > best.path.length)) best = r;
  return best ? { root: best, path: resolved } : null;
}

/** The workspace path as models and grants see it: /workspace/… */
export function virtualPath(path: string, root: FileRoot, workspaceRoot: string): string {
  const rel = relative(root.path, path).split(sep).join('/');
  return rel ? `${workspaceRoot}/${rel}` : workspaceRoot;
}

/** realpath for a gate over posix-form real paths ("/C:/a/b"). */
export function nativeProbe(): FsProbe {
  return {
    realpath: async (p: string) => {
      const r = (await realpath(nativeForm(p))).replace(/\\/g, '/');
      return r.startsWith('/') ? r : `/${r}`;
    },
  };
}
