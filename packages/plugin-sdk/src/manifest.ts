/**
 * ------------------------------------------------------------------
 *  Title    |  Plugin manifest validation
 *  ID       |  plugin-sdk
 * ------------------------------------------------------------------
 *  Purpose  |  Read ancile.plugin.json and say exactly what is wrong
 *           |  with it, in words a plugin author can act on.
 * ------------------------------------------------------------------
 */

import { PluginManifest } from '@nvx/contracts';

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; problems: string[] };

export function validateManifest(raw: unknown): ManifestResult {
  const parsed = PluginManifest.safeParse(raw);
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
