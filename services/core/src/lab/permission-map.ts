/**
 * ------------------------------------------------------------------
 *  Title    |  The lab's permissions, in Ancile's terms
 *  Ref      |  DESIGN.md §5, config/tools.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The engine asks in its own vocabulary ("edit" on a file
 *           |  path, "bash" with a command). Core decides in one
 *           |  vocabulary for every lane, so the same grants, policies
 *           |  and tiers cover chat tools and the lab alike: an edit is
 *           |  fs.write on fs:/workspace/…, a shell command is
 *           |  shell.exec on shell:<command>.
 *  How      |  A lab works in <workspace>/labs/<thread>, which models
 *           |  and grants see as /workspace/labs/<thread>. Paths the
 *           |  engine reports are real; they are mapped back to that
 *           |  virtual root, or kept as-is (and so outside the root)
 *           |  when they leave it.
 * ------------------------------------------------------------------
 */

import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { Tier } from '@nvx/contracts';

export interface LabAsk {
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

export interface MappedAsk {
  action: string;
  resource: string;
  tier: Tier;
  destructive: boolean;
  /** What the dialog and the tool step call it. */
  tool: string;
}

export interface LabPlace {
  /** Real folder the engine works in. */
  realDir: string;
  /** The same folder as models and grants see it, e.g. /workspace/labs/thr_… */
  virtualDir: string;
}

/** A path the engine reported → the resource Core checks. */
export function virtualPath(raw: string, place: LabPlace): string {
  const abs = isAbsolute(raw) ? raw : resolve(place.realDir, raw);
  const rel = relative(place.realDir, abs);
  if (rel === '') return place.virtualDir;
  if (!rel.startsWith('..') && !isAbsolute(rel)) return posix.join(place.virtualDir, ...rel.split(sep));
  const p = abs.replace(/\\/g, '/');
  return p.startsWith('/') ? p : `/${p}`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function mapAsk(ask: LabAsk, place: LabPlace): MappedAsk {
  const m = ask.metadata;
  const first = ask.patterns[0];
  const pathOf = () =>
    virtualPath(str(m.filepath) ?? str(m.filePath) ?? str(m.parentDir) ?? first ?? '.', place);
  switch (ask.permission) {
    case 'read':
    case 'glob':
    case 'grep':
    case 'list':
      return {
        action: 'fs.read',
        resource: `fs:${pathOf()}`,
        tier: 'auto',
        destructive: false,
        tool: ask.permission,
      };
    case 'edit':
    case 'write':
    case 'apply_patch':
      return {
        action: 'fs.write',
        resource: `fs:${pathOf()}`,
        tier: 'gated',
        destructive: false,
        tool: ask.permission,
      };
    case 'external_directory':
      // Leaving the lab folder: a write outside the workspace, so policy
      // escalates it to critical.
      return {
        action: 'fs.write',
        resource: `fs:${pathOf()}`,
        tier: 'critical',
        destructive: false,
        tool: 'external_directory',
      };
    case 'bash':
      return {
        action: 'shell.exec',
        resource: `shell:${str(m.command) ?? ask.patterns.join(' ')}`,
        tier: 'critical',
        destructive: true,
        tool: 'bash',
      };
    case 'webfetch':
    case 'websearch':
      return {
        action: ask.permission === 'websearch' ? 'web.search' : 'http.get',
        resource:
          ask.permission === 'websearch'
            ? `web:${str(m.query) ?? first ?? ''}`
            : `http:${str(m.url) ?? first ?? ''}`,
        tier: 'gated',
        destructive: false,
        tool: ask.permission,
      };
    case 'doom_loop':
      return {
        action: 'lab.repeat',
        resource: `lab:${place.virtualDir}`,
        tier: 'gated',
        destructive: false,
        tool: 'doom_loop',
      };
    default:
      return {
        action: `mcp.lab.${ask.permission}`,
        resource: `mcp:lab/${ask.permission}`,
        tier: 'gated',
        destructive: false,
        tool: ask.permission,
      };
  }
}
