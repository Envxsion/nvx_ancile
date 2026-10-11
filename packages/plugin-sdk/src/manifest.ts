/**
 * ------------------------------------------------------------------
 *  Title    |  Plugin manifest validation
 *  ID       |  plugin-sdk
 * ------------------------------------------------------------------
 *  Purpose  |  Read ancile.plugin.json and say exactly what is wrong
 *           |  with it, in words a plugin author can act on.
 *  How      |  The schema is the contract's (packages/contracts); the
 *           |  type below is spelled out so the published types stand
 *           |  alone. test/sdk.test.ts fails the typecheck if the two
 *           |  ever differ.
 * ------------------------------------------------------------------
 */

// The config module only: the bundle then carries this schema, not every contract.
import { PluginManifest as ManifestSchema } from '@nvx/contracts/config';
import type { Tier } from './tool';

/** ancile.plugin.json, after defaults are filled in. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: 'tools' | 'memory-provider' | 'panel';
  /** The built file Ancile runs, relative to the plugin folder. */
  entry: string;
  description: string;
  /** Resource patterns the plugin asks for, shown when it is enabled. */
  requests: string[];
  tools: { name: string; action: string; tier: Tier; destructive: boolean }[];
}

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; problems: string[] };

export function validateManifest(raw: unknown): ManifestResult {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const problems: string[] = [];
  for (const t of parsed.data.tools) {
    if (t.destructive && t.tier === 'auto')
      problems.push(`tools.${t.name}: destructive tools cannot be tier "auto"`);
  }
  if (parsed.data.kind === 'tools' && parsed.data.tools.length === 0)
    problems.push('tools: a tools plugin must declare at least one tool');
  return problems.length ? { ok: false, problems } : { ok: true, manifest: parsed.data };
}
