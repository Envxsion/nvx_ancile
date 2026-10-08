import { describe, expect, it } from 'vitest';
import { matchAction, matchResource, specificity } from '../../src/permissions/glob';
import { normalizeResource } from '../../src/permissions/normalize';
import { suggestPatterns } from '../../src/permissions/suggest';

describe('globs', () => {
  it.each([
    ['fs:/workspace/**', 'fs:/workspace', true],
    ['fs:/workspace/**', 'fs:/workspace/a/b/c.md', true],
    ['fs:/workspace/**', 'fs:/workspaces/a', false],
    ['fs:/workspace/*', 'fs:/workspace/a.md', true],
    ['fs:/workspace/*', 'fs:/workspace/a/b.md', false],
    ['fs:/workspace/**/*.md', 'fs:/workspace/notes/x.md', true],
    ['fs:/workspace/a.md', 'fs:/workspace/a.md', true],
    ['fs:/workspace/a.md', 'fs:/workspace/aXmd', false],
    ['http:https://api.github.com/**', 'http:https://api.github.com/repos/x', true],
    ['http:https://api.github.com/**', 'http:https://api.github.com.evil.io/x', false],
  ])('resource %s ~ %s → %s', (p, v, want) => {
    expect(matchResource(p, v)).toBe(want);
  });

  it.each([
    ['fs.*', 'fs.read', true],
    ['fs.*', 'fs.read.meta', false],
    ['mcp.**', 'mcp.github.create_issue', true],
    ['mcp.github.*', 'mcp.gitlab.create_issue', false],
  ])('action %s ~ %s → %s', (p, v, want) => {
    expect(matchAction(p, v)).toBe(want);
  });

  it('ranks narrow patterns above wide ones', () => {
    expect(specificity('fs:/workspace/docs/**')).toBeGreaterThan(specificity('fs:/workspace/**'));
    expect(specificity('fs:/workspace/a.md')).toBeGreaterThan(specificity('fs:/workspace/*.md'));
  });
});

describe('normalizeResource', () => {
  const opts = { workspaceRoot: '/workspace' };

  it('collapses redundant segments and trailing slashes', async () => {
    expect(await normalizeResource('fs:/workspace//a/./b/', opts)).toMatchObject({
      ok: true,
      resource: 'fs:/workspace/a/b',
    });
  });

  it('accepts backslashes from Windows-y tools', async () => {
    expect(await normalizeResource('fs:\\workspace\\a.md', opts)).toMatchObject({
      ok: true,
      resource: 'fs:/workspace/a.md',
    });
  });

  it('rejects relative paths, .. and NUL', async () => {
    expect(await normalizeResource('fs:workspace/a', opts)).toMatchObject({
      ok: false,
      reason: 'not_absolute',
    });
    expect(await normalizeResource('fs:/workspace/a/../../etc', opts)).toMatchObject({
      ok: false,
      reason: 'path_escape',
    });
    expect(await normalizeResource('fs:/workspace/a\0b', opts)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('flags paths outside the root without refusing them (policy decides)', async () => {
    expect(await normalizeResource('fs:/etc/hosts', opts)).toMatchObject({ ok: true, outsideRoot: true });
  });

  it('canonicalises URLs', async () => {
    expect(await normalizeResource('http:https://u:p@Example.COM:443/a?b=1#frag', opts)).toMatchObject({
      ok: true,
      resource: 'http:https://example.com/a?b=1',
    });
    expect(await normalizeResource('http:file:///etc/passwd', opts)).toMatchObject({
      ok: false,
      reason: 'unsupported_scheme',
    });
  });

  it('requires a scheme', async () => {
    expect(await normalizeResource('/workspace/a', opts)).toMatchObject({ ok: false });
  });
});

describe('suggestPatterns', () => {
  it('never goes wider than the workspace', () => {
    expect(suggestPatterns('fs:/workspace/a.md', { workspaceRoot: '/workspace' })).toEqual([
      'fs:/workspace/a.md',
      'fs:/workspace/**',
    ]);
  });

  it('walks a URL path up to its host', () => {
    expect(suggestPatterns('http:https://api.github.com/repos/x/issues', { workspaceRoot: '/w' })).toEqual([
      'http:https://api.github.com/repos/x/issues',
      'http:https://api.github.com/repos/x/**',
      'http:https://api.github.com/repos/**',
      'http:https://api.github.com/**',
    ]);
  });

  it('offers server-wide and command-wide patterns', () => {
    expect(suggestPatterns('mcp:github/create_issue', { workspaceRoot: '/w' })).toEqual([
      'mcp:github/create_issue',
      'mcp:github/*',
    ]);
    expect(suggestPatterns('shell:git status --short', { workspaceRoot: '/w' })).toEqual([
      'shell:git status --short',
      'shell:git *',
    ]);
  });
});
