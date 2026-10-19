/**
 * ------------------------------------------------------------------
 *  Title    |  Files for the editor
 *  Ref      |  packages/contracts/src/files.ts · CLAUDE.md ("every
 *           |  tool call goes through permissions/decide")
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read one text file for the Cockpit's code editor, and
 *           |  save it back, with the same permission gate a model's
 *           |  fs.read and fs.write pass, on the real path, at the
 *           |  moment of the read or the save.
 *  How      |  locate() → the gate (fs.read / fs.write, principal
 *           |  person:editor) → the disk. A save the gate would ask
 *           |  about is refused with files.needs_confirm until the
 *           |  person confirms it, and the confirmation is written to
 *           |  the decision log as "approved". A save over a file that
 *           |  changed since it was opened is refused (files.changed).
 *           |  Writes go to a temporary file beside the target, then
 *           |  rename over it, so a crash never leaves half a file.
 *  Note     |  Workspace paths are checked as /workspace/… with the
 *           |  main gate; repository and Claude Code folders with a
 *           |  gate rooted at that folder (as Claude Code's own calls
 *           |  are), so grants written for either apply here too.
 * ------------------------------------------------------------------
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  AncileError,
  FILE_EDITOR_MAX_BYTES,
  type FileContent,
  type FileWriteRequest,
  type FileWriteResult,
} from '@nvx/contracts';
import { gateRoot, resourcePath } from '../claudecode/permission-map';
import type { Gate, GateRequest } from '../permissions/gate';
import type { PermissionStore } from '../permissions/store';
import { confinedRename, confineEntry } from './confine';
import {
  type FileRoot,
  type Located,
  locate,
  type RootSource,
  realOrNearest,
  virtualPath,
  within,
} from './roots';

export const EDITOR_PRINCIPAL = 'person:editor';

export interface FileServiceDeps {
  roots: RootSource;
  workspace: { dir: string; root: string };
  /** The gate over /workspace/… (the main gate). */
  gate: Gate;
  /** A gate whose root is a repository or Claude Code folder (posix form, as gateRoot gives). */
  gateFor: (root: string) => Gate;
  store: Pick<PermissionStore, 'recordDecision'>;
  userId: string;
  workspaceId: string;
  /** The thread's notebook, so its scope applies. */
  notebookOf?: (threadId: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Not text the editor can show and save: a NUL byte, or bytes that are not UTF-8. */
export function isBinary(buf: Buffer): boolean {
  if (buf.subarray(0, 8000).includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

function outside(path: string): AncileError {
  return new AncileError({
    code: 'files.outside_roots',
    title: 'That file is outside the folders NVX Ancile can open',
    detail: path.slice(0, 300),
    hint: 'Open files in the workspace, a repository added in the Repo panel, or a Claude Code project folder.',
    status: 403,
    errorClass: 'policy',
  });
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  private async where(path: string): Promise<Located> {
    const roots = await this.deps.roots.roots();
    const at = await locate(path, roots, this.deps.workspace, this.deps.platform);
    if (!at) throw outside(path);
    return at;
  }

  /** The gate and resource for a real path under a root. */
  private gated(at: Located): { gate: Gate; resource: string } {
    if (at.root.kind === 'workspace')
      return {
        gate: this.deps.gate,
        resource: `fs:${virtualPath(at.path, at.root, this.deps.workspace.root)}`,
      };
    return {
      gate: this.deps.gateFor(gateRoot(at.root.path)),
      resource: `fs:${resourcePath(at.path, at.root.path)}`,
    };
  }

  private async check(at: Located, action: 'fs.read' | 'fs.write', threadId: string | null, traceId: string) {
    const { gate, resource } = this.gated(at);
    const notebookId = threadId ? ((await this.deps.notebookOf?.(threadId).catch(() => null)) ?? null) : null;
    const req: GateRequest = {
      userId: this.deps.userId,
      principal: EDITOR_PRINCIPAL,
      action,
      resource,
      toolTier: action === 'fs.read' ? 'auto' : 'gated',
      destructive: false,
      scope: { threadId, notebookId, workspaceId: this.deps.workspaceId },
      runId: null,
      traceId,
    };
    return { decision: await gate.check(req), req };
  }

  async read(path: string, threadId: string | null, traceId: string): Promise<FileContent> {
    const at = await this.where(path);
    const info = await stat(at.path).catch(() => null);
    if (!info)
      throw new AncileError({
        code: 'files.not_found',
        title: `${basename(at.path)} does not exist`,
        detail: at.path,
        hint: 'It may have been moved or deleted since the thread mentioned it.',
        status: 404,
        errorClass: 'permanent',
      });
    if (info.isDirectory())
      throw new AncileError({
        code: 'files.is_folder',
        title: `${basename(at.path)} is a folder`,
        hint: 'Open a file inside it instead.',
        status: 400,
        errorClass: 'permanent',
      });
    if (info.size > FILE_EDITOR_MAX_BYTES)
      throw new AncileError({
        code: 'files.too_large',
        title: `${basename(at.path)} is too large to open here`,
        detail: `${info.size} bytes; the editor opens files up to ${FILE_EDITOR_MAX_BYTES} bytes.`,
        hint: 'Open it in your own editor instead.',
        status: 413,
        errorClass: 'permanent',
      });
    const { decision } = await this.check(at, 'fs.read', threadId, traceId);
    // Opening a file you asked to see: only an outright refusal stops it.
    if (decision.outcome === 'deny')
      throw new AncileError({
        code: 'files.read_denied',
        title: `Reading ${basename(at.path)} is not allowed here`,
        detail: decision.reason,
        hint: "Check this thread's scope, or the policy named in Admin → Decisions.",
        status: 403,
        errorClass: 'policy',
      });
    const buf = await readFile(at.path);
    const binary = isBinary(buf);
    return {
      path: at.path,
      name: basename(at.path),
      root: rootOut(at.root),
      content: binary ? '' : buf.toString('utf8'),
      bytes: buf.length,
      sha256: sha256(buf),
      modified_at: info.mtime.toISOString(),
      binary,
    };
  }

  async write(req: FileWriteRequest, traceId: string): Promise<FileWriteResult> {
    const at = await this.where(req.path);
    const bytes = Buffer.byteLength(req.content, 'utf8');
    if (bytes > FILE_EDITOR_MAX_BYTES)
      throw new AncileError({
        code: 'files.too_large',
        title: `${basename(at.path)} is too large to save here`,
        detail: `${bytes} bytes; the editor saves files up to ${FILE_EDITOR_MAX_BYTES} bytes.`,
        hint: 'Save it from your own editor instead.',
        status: 413,
        errorClass: 'permanent',
      });
    const threadId = req.thread_id ?? null;
    const { decision, req: gateReq } = await this.check(at, 'fs.write', threadId, traceId);
    if (decision.outcome === 'deny')
      throw new AncileError({
        code: 'files.write_denied',
        title: `Saving ${basename(at.path)} is not allowed here`,
        detail: decision.reason,
        hint: "Check this thread's scope, or the policy named in Admin → Decisions.",
        status: 403,
        errorClass: 'policy',
        context: { resource: decision.resource, ...(decision.policyId && { policy_id: decision.policyId }) },
      });
    if (decision.outcome === 'ask' && !req.confirmed)
      throw new AncileError({
        code: 'files.needs_confirm',
        title: `Saving ${basename(at.path)} needs your confirmation`,
        detail: decision.reason,
        hint: 'Choose "Save anyway" to write it, or cancel.',
        status: 409,
        errorClass: 'policy',
        context: {
          tier: decision.tier,
          resource: decision.resource,
          reason:
            decision.reason ??
            (decision.tier === 'critical'
              ? 'Writing here is a critical action, which always asks'
              : 'Writing files asks first, unless you allowed it'),
        },
      });

    // Opened at one version, saved over another: refuse rather than lose the other change.
    const current = await readFile(at.path).catch(() => null);
    const currentSha = current ? sha256(current) : null;
    if (currentSha !== req.base_sha256)
      throw new AncileError({
        code: 'files.changed',
        title: `${basename(at.path)} changed since you opened it`,
        hint: 'Reload to see the new version, or keep editing and save again to replace it.',
        status: 409,
        errorClass: 'permanent',
        context: { sha256: currentSha },
      });

    // The folder must still be where the root says (no symlink swapped in since locate).
    const dir = await realOrNearest(dirname(at.path));
    if (!within(dir, at.root.path, this.deps.platform)) throw outside(req.path);
    if (!(await stat(dirname(at.path)).catch(() => null))?.isDirectory())
      throw new AncileError({
        code: 'files.no_folder',
        title: `The folder for ${basename(at.path)} does not exist`,
        detail: dirname(at.path),
        hint: 'The editor saves into existing folders only. Create the folder first, then save again.',
        status: 404,
        errorClass: 'permanent',
      });
    // SC1: the entry is not a link and its folder is still inside the root; checked again before the swap-in.
    const entry = (await confineEntry(at.path, [at.root.path], { platform: this.deps.platform })).path;
    const tmp = join(dirname(entry), `.${basename(entry)}.ancile-${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, req.content, { encoding: 'utf8', flag: 'wx' });
      await confinedRename(tmp, entry, [at.root.path], { platform: this.deps.platform });
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      if (err instanceof AncileError) throw err;
      throw new AncileError({
        code: 'files.write_failed',
        title: `${basename(at.path)} could not be saved`,
        detail: (err as Error).message,
        hint: 'Check the file is not open read-only elsewhere and the disk has space, then save again.',
        status: 500,
        errorClass: 'transient',
        retryable: true,
        cause: err,
      });
    }
    if (decision.outcome === 'ask')
      await this.deps.store.recordDecision({
        userId: gateReq.userId,
        principal: gateReq.principal,
        action: gateReq.action,
        resource: decision.resource,
        tier: decision.tier,
        outcome: 'approved',
        traceId,
      });
    const info = await stat(at.path);
    return { path: at.path, bytes, sha256: sha256(req.content), modified_at: info.mtime.toISOString() };
  }
}

function rootOut(r: FileRoot): FileContent['root'] {
  return { kind: r.kind, path: r.path, label: r.label };
}
