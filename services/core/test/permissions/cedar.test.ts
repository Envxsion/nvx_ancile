/**
 * The shipped policy files, evaluated by Cedar exactly as Core loads them.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BuiltinPolicy,
  CedarPolicy,
  isExternal,
  loadCedarEvaluator,
  PolicyParseError,
  presetRelax,
  principalKind,
  principalUid,
} from '../../src/permissions/cedar';

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
      (await p.forbids(req('knowledge.search', 'search:q', false, 'external:claude-desktop'))).forbidden,
    ).toBe(false);
  });

  it('treats apps connected to /mcp as outside apps: they read, never write', async () => {
    const p = await loadCedarEvaluator({ files: await files(), preset: 'balanced' });
    for (const read of ['knowledge.search', 'notebooks.read', 'memory.read'])
      expect((await p.forbids(req(read, 'workspace:wsp_1', false, 'mcp:cli_1'))).forbidden).toBe(false);
    for (const write of ['fs.write', 'memory.write', 'shell.exec', 'repo.push', 'compute.start'])
      expect(await p.forbids(req(write, 'workspace:wsp_1', false, 'mcp:cli_1'))).toMatchObject({
        forbidden: true,
        policyId: 'base.external-read-only',
      });
  });

  it('reads a principal by its prefix, and never reads a name it does not know as a person', () => {
    for (const [name, kind] of [
      ['user', 'user'],
      ['person:editor', 'user'],
      ['usr_01ABC', 'user'],
      ['agent:default', 'agent'],
      ['agent:claude-code', 'agent'],
      ['external:claude-desktop', 'external'],
      ['mcp:cli_1', 'external'],
      // Nothing here recognises these: none is a person.
      ['assistant', 'unknown'],
      ['admin', 'unknown'],
      ['root', 'unknown'],
      ['system:cron', 'unknown'],
      ['Agent:default', 'unknown'],
      ['agent', 'unknown'],
      ['users:me', 'unknown'],
      ['', 'unknown'],
    ] as const)
      expect(principalKind(name), name).toBe(kind);
    expect(principalUid('person:editor')).toEqual({ type: 'Ancile::User', id: 'person:editor' });
    expect(principalUid('agent:lab')).toEqual({ type: 'Ancile::Agent', id: 'lab' });
    expect(principalUid('mcp:cli_1')).toEqual({ type: 'Ancile::External', id: 'cli_1' });
    // An unknown prefix fails closed: the most restricted caller, an outside app.
    expect(principalUid('admin')).toEqual({ type: 'Ancile::External', id: 'admin' });
    expect(isExternal('admin')).toBe(true);
    expect(isExternal('person:editor')).toBe(false);
    expect(isExternal('agent:default')).toBe(false);
  });

  it('keeps a caller with an unknown prefix to reading, in Cedar and in the built-in rules', async () => {
    const cedar = await loadCedarEvaluator({ files: await files(), preset: 'balanced' });
    for (const who of ['assistant', 'admin', 'system:cron', 'Agent:default']) {
      for (const write of ['fs.write', 'shell.exec', 'memory.write', 'http.post', 'compute.start'])
        expect(
          await cedar.forbids(req(write, 'fs:/workspace/a.md', false, who)),
          `${who} ${write}`,
        ).toMatchObject({
          forbidden: true,
          policyId: 'base.external-read-only',
        });
      expect((await cedar.forbids(req('knowledge.search', 'search:q', false, who))).forbidden).toBe(false);
      // The built-in floor that holds when no policy file loads says the same.
      expect(await new BuiltinPolicy().forbids({ principal: who, action: 'fs.write' })).toMatchObject({
        forbidden: true,
      });
    }
    // The same calls by a person and by an agent are not forbidden by this rule.
    for (const who of ['user', 'person:editor', 'agent:default'])
      expect((await cedar.forbids(req('fs.write', 'fs:/workspace/a.md', false, who))).forbidden).toBe(false);
  });

  it('never eases anything for a caller with an unknown prefix, even under Hands-off', () => {
    const relax = presetRelax('hands_off');
    const ask = (principal: string) => ({
      principal,
      action: 'fs.write',
      resource: 'fs:/workspace/a.md',
      outsideRoot: false,
      toolTier: 'gated' as const,
      destructive: false,
    });
    expect(relax?.(ask('agent:default'))).toBe('auto');
    expect(relax?.(ask('person:editor'))).toBe('auto');
    expect(relax?.(ask('assistant'))).toBeNull();
    expect(relax?.(ask('admin'))).toBeNull();
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

  it('loads the hands-off preset file (id hands_off, file preset-hands-off.cedar)', async () => {
    const p = await CedarPolicy.load({ files: await files(), preset: 'hands_off' });
    expect(p.policyIds).toContain('hands-off.no-recursive-delete');
    const e = await loadCedarEvaluator({ files: await files(), preset: 'hands_off' });
    expect(await e.forbids(req('fs.delete', 'fs:/workspace/project/**'))).toMatchObject({
      forbidden: true,
      policyId: 'hands-off.no-recursive-delete',
    });
    // One named file is not a wildcard: it asks, as critical, like every delete.
    expect(await e.forbids(req('fs.delete', 'fs:/workspace/docs/a.md'))).toEqual({ forbidden: false });
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
