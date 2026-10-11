/**
 * What each permission preset really does, through decide() with the shipped
 * Cedar files: Hands-off lets workspace file writes run without asking, and
 * nothing else; no preset ever eases anything critical or destructive.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCedarEvaluator } from '../../src/permissions/cedar';
import { decide } from '../../src/permissions/decide';
import { fakeFs, grant, ROOT, req } from './golden';

const DIR = join(__dirname, '../../../../config/policies');

async function deps(preset: string, grants = [] as ReturnType<typeof grant>[]) {
  const files: Record<string, string> = {};
  for (const f of await readdir(DIR))
    if (f.endsWith('.cedar')) files[f] = await readFile(join(DIR, f), 'utf8');
  return {
    policy: await loadCedarEvaluator({ files, preset }),
    grants: { forPrincipal: async () => grants },
    workspaceRoot: ROOT,
    fs: fakeFs,
  };
}

describe('permission presets', () => {
  it('Hands-off writes a workspace file without asking; Balanced and Careful ask', async () => {
    const write = req('fs.write', 'fs:/workspace/docs/a.md', 'gated');
    expect(await decide(write, await deps('hands_off'))).toMatchObject({ outcome: 'allow', via: 'auto' });
    expect(await decide(write, await deps('balanced'))).toMatchObject({ outcome: 'ask', tier: 'gated' });
    expect(await decide(write, await deps('careful'))).toMatchObject({ outcome: 'ask', tier: 'gated' });
  });

  it('Hands-off still asks every time for anything critical or destructive', async () => {
    const d = await deps('hands_off');
    expect(await decide(req('fs.write', 'fs:/etc/passwd', 'gated'), d)).toMatchObject({
      outcome: 'ask',
      tier: 'critical',
    });
    expect(
      await decide(req('fs.delete', 'fs:/workspace/docs/a.md', 'gated', { destructive: true }), d),
    ).toMatchObject({
      outcome: 'ask',
    });
    expect(await decide(req('compute.terminate', 'node:nod_1', 'gated'), d)).toMatchObject({
      outcome: 'ask',
      tier: 'critical',
    });
    // A symlink out of the workspace is outside it, whatever its name says.
    expect(await decide(req('fs.write', 'fs:/workspace/link/passwd', 'gated'), d)).toMatchObject({
      tier: 'critical',
    });
  });

  it('never eases anything for an outside app', async () => {
    const d = await deps('hands_off', [
      grant({ principal: 'mcp:cli_1', actionPattern: '*', resourcePattern: '*' }),
    ]);
    expect(
      await decide(req('fs.write', 'fs:/workspace/docs/a.md', 'gated', { principal: 'mcp:cli_1' }), d),
    ).toMatchObject({ outcome: 'deny', via: 'policy' });
  });
});
