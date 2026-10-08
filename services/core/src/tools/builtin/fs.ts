/**
 * ------------------------------------------------------------------
 *  Title    |  Built-in file tools
 *  Ref      |  DESIGN.md §5.2, config/tools.yaml (fs.*)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read, list, write and delete files in the workspace:
 *           |  the smallest tool set that exercises every permission
 *           |  tier (read is AUTO, write is GATED, delete is CRITICAL).
 *  How      |  Models see one virtual root, /workspace, whatever the
 *           |  host. Workspace maps it to a real directory both ways:
 *           |  the permission check runs on the virtual path after
 *           |  symlinks are resolved on the real disk (fsProbe), and
 *           |  execution happens only after that check passed.
 *  Note     |  Paths may be given relative ("notes/a.md") or absolute
 *           |  ("/workspace/notes/a.md"); anything else is outside.
 * ------------------------------------------------------------------
 */

import { mkdir, readdir, readFile, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import type { FsProbe } from '../../permissions/normalize';
import type { ToolSpec } from '../registry';

const MAX_READ_BYTES = 256 * 1024;

export class Workspace {
  constructor(
    /** Real directory on this machine. */
    readonly dir: string,
    /** The path models and permissions see. */
    readonly root = '/workspace',
  ) {}

  /** Model-supplied path → absolute virtual path (not yet checked). */
  virtual(p: unknown): string {
    const raw = typeof p === 'string' && p.trim() ? p.trim().replace(/\\/g, '/') : '.';
    if (raw.startsWith('/')) return raw;
    return posix.join(this.root, raw);
  }

  /** Virtual path → real path, or null when it is not under the root. */
  real(virtual: string): string | null {
    const v = posix.normalize(virtual);
    if (v !== this.root && !v.startsWith(`${this.root}/`)) return null;
    const rest = v.slice(this.root.length).replace(/^\//, '');
    return rest ? join(this.dir, ...rest.split('/')) : this.dir;
  }

  /** Real path → virtual path when inside, or a posix form of the real path when not. */
  toVirtual(realPath: string, realRoot: string): string {
    const rel = relative(realRoot, realPath);
    if (rel === '') return this.root;
    if (!rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel)) return posix.join(this.root, ...rel.split(sep));
    const p = realPath.replace(/\\/g, '/');
    return p.startsWith('/') ? p : `/${p}`;
  }

  /** realpath() for the permission engine, over virtual paths. */
  probe(): FsProbe {
    return {
      realpath: async (virtual: string) => {
        const r = this.real(virtual);
        if (r === null) return virtual; // outside: nothing of ours to resolve
        const [resolved, root] = await Promise.all([realpath(r), realpath(this.dir)]);
        return this.toVirtual(resolved, root);
      },
    };
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }
}

const pathArg = {
  type: 'string',
  description: 'Path inside /workspace, relative ("notes/a.md") or absolute ("/workspace/notes/a.md").',
};

function need(ws: Workspace, args: unknown): string {
  const real = ws.real(ws.virtual((args as { path?: unknown })?.path));
  if (real === null) throw new Error('That path is outside the workspace.');
  return real;
}

export function fsTools(ws: Workspace): ToolSpec[] {
  const resource = (args: unknown) => `fs:${ws.virtual((args as { path?: unknown })?.path)}`;
  return [
    {
      name: 'fs_read',
      description: 'Read a text file from the workspace.',
      inputSchema: {
        type: 'object',
        properties: { path: pathArg },
        required: ['path'],
        additionalProperties: false,
      },
      action: 'fs.read',
      tier: 'auto',
      destructive: false,
      readOnly: true,
      source: { kind: 'builtin' },
      resource,
      async execute(args) {
        const file = need(ws, args);
        const info = await stat(file);
        if (info.isDirectory()) throw new Error('That is a folder; use fs_list.');
        const buf = await readFile(file);
        const truncated = buf.length > MAX_READ_BYTES;
        return {
          path: ws.virtual((args as { path: string }).path),
          bytes: buf.length,
          truncated,
          content: buf.subarray(0, MAX_READ_BYTES).toString('utf8'),
        };
      },
    },
    {
      name: 'fs_list',
      description: 'List the files and folders in a workspace folder.',
      inputSchema: {
        type: 'object',
        properties: { path: { ...pathArg, description: 'Folder to list; defaults to the workspace root.' } },
        additionalProperties: false,
      },
      action: 'fs.list',
      tier: 'auto',
      destructive: false,
      readOnly: true,
      source: { kind: 'builtin' },
      resource,
      async execute(args) {
        const dir = need(ws, args);
        const entries = await readdir(dir, { withFileTypes: true });
        return {
          path: ws.virtual((args as { path?: string })?.path),
          entries: entries
            .slice(0, 500)
            .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'folder' : 'file' })),
        };
      },
    },
    {
      name: 'fs_write',
      description: 'Create or overwrite a text file in the workspace. Folders are created as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathArg,
          content: { type: 'string', description: 'The whole new content of the file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      action: 'fs.write',
      tier: 'gated',
      destructive: false,
      source: { kind: 'builtin' },
      resource,
      async execute(args) {
        const file = need(ws, args);
        const content = String((args as { content?: unknown }).content ?? '');
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, 'utf8');
        return { path: ws.virtual((args as { path: string }).path), bytes: Buffer.byteLength(content) };
      },
    },
    {
      name: 'fs_delete',
      description: 'Delete a file or an empty folder from the workspace.',
      inputSchema: {
        type: 'object',
        properties: { path: pathArg },
        required: ['path'],
        additionalProperties: false,
      },
      action: 'fs.delete',
      tier: 'critical',
      destructive: true,
      source: { kind: 'builtin' },
      resource,
      async execute(args) {
        const file = need(ws, args);
        if (file === ws.dir) throw new Error('The workspace root cannot be deleted.');
        if ((await stat(file)).isDirectory()) await rmdir(file);
        else await unlink(file);
        return { path: ws.virtual((args as { path: string }).path), deleted: true };
      },
    },
  ];
}
