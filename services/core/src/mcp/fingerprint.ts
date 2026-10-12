/**
 * ------------------------------------------------------------------
 *  Title    |  MCP tool-list fingerprints
 *  Ref      |  docs/plugins.md (When a server changes its tools)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say exactly which tools an MCP server offers, so a list
 *           |  that changes after you approved it (a "rug pull": a new
 *           |  tool, or an old one with a new description or schema)
 *           |  is noticed, whatever order the server lists them in.
 *  How      |  Each tool is hashed (SHA-256) over canonical JSON of its
 *           |  name, description and input schema: object keys sorted
 *           |  at every depth, no whitespace. The server's fingerprint
 *           |  hashes the sorted name → hash pairs. diffTools compares
 *           |  two such maps by name.
 *  Note     |  Claude Code reports its servers' tool names only, so
 *           |  those are hashed on the name alone (coverage "names").
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import type { McpToolDiff } from '@nvx/contracts';

/** What is hashed for one tool. Absent fields are hashed as null, never skipped. */
export interface FingerprintTool {
  name: string;
  description?: string | null;
  inputSchema?: unknown;
}

/** name → SHA-256 of that tool. */
export type ToolHashes = Record<string, string>;

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function toolHash(t: FingerprintTool): string {
  return sha256(
    canonicalJson({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null }),
  );
}

export function toolHashes(tools: FingerprintTool[]): ToolHashes {
  const out: ToolHashes = {};
  for (const t of tools) out[t.name] = toolHash(t);
  return out;
}

/** The server's fingerprint: order-free over its tools. */
export function listFingerprint(hashes: ToolHashes): string {
  return sha256(canonicalJson(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** What came, went and changed between the approved list and the one offered now. */
export function diffTools(approved: ToolHashes, current: ToolHashes): McpToolDiff {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [name, h] of Object.entries(current)) {
    if (!(name in approved)) added.push(name);
    else if (approved[name] !== h) changed.push(name);
  }
  const removed = Object.keys(approved).filter((n) => !(n in current));
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export const emptyDiff = (d: McpToolDiff) => !d.added.length && !d.removed.length && !d.changed.length;
