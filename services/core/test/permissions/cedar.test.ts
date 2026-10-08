/**
 * The shipped policy files, evaluated by Cedar exactly as Core loads them.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CedarPolicy, loadCedarEvaluator, PolicyParseError } from '../../src/permissions/cedar';

const DIR = join(__dirname, '../../../../config/policies');

async function files(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await readdir(DIR)) if (f.endsWith('.cedar')) out[f] = await readFile(join(DIR, f), 'utf8');
  return out;
}

const req = (action: string, resource: string, outsideRoot = false, principal = 'agent:default') => ({
  principal,
  action,
  resource,
  outsideRoot,
});

describe('Cedar policies', () => {
  it('parses every shipped file and names policies by their @id', async () => {
    const p = await CedarPolicy.load({ files: await files(), preset: 'balanced' });
    expect(p.policyIds).toContain('base.protect-internals');
    expect(p.policyIds).toContain('balanced.shell-dangerous');
  });

  it('forbids touching secrets, git internals and memory through tools', async () => {
    const p = await loadCedarEvaluator({ files: await files(), preset: 'balanced' });
    expect(await p.forbids(req('fs.read', 'fs:/workspace/.env'))).toMatchObject({
      forbidden: true,
      policyId: 'base.protect-internals',
    });
    expect(await p.forbids(req('fs.write', 'fs:/workspace/repo/.git/config'))).toMatchObject({
      forbidden: true,
    });
    expect(await p.forbids(req('fs.read', 'fs:/workspace/notes/a.md'))).toEqual({ forbidden: false });
  });

  it('keeps external clients read-only', async () => {
    const p = await loadCedarEvaluator({ files: await files(), preset: 'balanced' });
    expect(
      (await p.forbids(req('fs.write', 'fs:/workspace/a.md', false, 'external:claude-desktop'))).forbidden,
    ).toBe(true);
    expect(
      (await p.forbids(req('ancile.search', 'search:q', false, 'external:claude-desktop'))).forbidden,
    ).toBe(false);
  });

  it('escalates writes outside the workspace and dangerous shell to critical', async () => {
    const p = await loadCedarEvaluator({ files: await files(), preset: 'balanced' });
    expect(await p.escalation(req('fs.write', 'fs:/etc/hosts', true))).toBe('critical');
    expect(await p.escalation(req('fs.write', 'fs:/workspace/a.md', false))).toBeNull();
    expect(await p.escalation(req('shell.exec', 'shell:sudo ls'))).toBe('critical');
    expect(await p.escalation(req('compute.terminate', 'node:nod_1'))).toBe('critical');
  });

  it('loads only the chosen preset', async () => {
    const p = await CedarPolicy.load({ files: await files(), preset: 'careful' });
    expect(p.policyIds.some((id) => id.startsWith('balanced.'))).toBe(false);
  });

  it('names the file when a policy does not parse', async () => {
    await expect(
      CedarPolicy.load({ files: { 'broken.cedar': 'permit (principal action resource);' } }),
    ).rejects.toBeInstanceOf(PolicyParseError);
    await expect(
      CedarPolicy.load({ files: { 'broken.cedar': 'permit (principal action resource);' } }),
    ).rejects.toThrow(/broken\.cedar/);
  });
});
