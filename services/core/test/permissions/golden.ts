/**
 * The golden table for decide(): shared by the unit suite and the boot suite
 * (test/boot/permissions-golden.boot.test.ts), so a broken permission engine
 * can never start serving.
 */
import type { Tier } from '@nvx/contracts';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import type { DecideDeps, DecisionRequest, GrantLike } from '../../src/permissions/decide';
import type { FsProbe } from '../../src/permissions/normalize';

export const ROOT = '/workspace';
export const NOW = Date.parse('2026-10-07T12:00:00Z');

/** /workspace/link → /etc (a symlink escape); /workspace/docs is real. */
export const fakeFs: FsProbe = {
  async realpath(p: string) {
    if (p === '/workspace/link' || p.startsWith('/workspace/link/'))
      return p.replace('/workspace/link', '/etc');
    if (p === '/workspace' || p.startsWith('/workspace/docs') || p === '/etc' || p === '/etc/passwd')
      return p;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
};

export function grant(
  partial: Partial<GrantLike> & Pick<GrantLike, 'actionPattern' | 'resourcePattern'>,
): GrantLike {
  return {
    id: `gnt_${partial.actionPattern}_${partial.resourcePattern}_${partial.effect ?? 'allow'}`,
    principal: 'agent:default',
    effect: 'allow',
    scope: 'always',
    scopeRef: null,
    expiresAt: null,
    revokedAt: null,
    ...partial,
  };
}

export function depsWith(grants: GrantLike[]): DecideDeps {
  return {
    policy: new BuiltinPolicy(),
    grants: { forPrincipal: async () => grants },
    workspaceRoot: ROOT,
    fs: fakeFs,
    now: () => NOW,
  };
}

export const req = (
  action: string,
  resource: string,
  toolTier: Tier,
  extra: Partial<DecisionRequest> = {},
): DecisionRequest => ({
  principal: 'agent:default',
  action,
  resource,
  toolTier,
  scope: { workspaceId: 'wsp_1', notebookId: 'nbk_1', threadId: 'thr_1' },
  ...extra,
});

export interface GoldenCase {
  name: string;
  request: DecisionRequest;
  grants: GrantLike[];
  expect: { outcome: 'allow' | 'deny' | 'ask'; via?: string; tier?: Tier };
}

const readDocs = grant({ actionPattern: 'fs.read', resourcePattern: 'fs:/workspace/docs/**' });

export const GOLDEN: GoldenCase[] = [
  {
    name: 'auto read is allowed without asking',
    request: req('fs.read', 'fs:/workspace/docs/a.md', 'auto'),
    grants: [],
    expect: { outcome: 'allow', via: 'auto' },
  },
  {
    name: 'gated with no grant asks',
    request: req('fs.write', 'fs:/workspace/docs/a.md', 'gated'),
    grants: [],
    expect: { outcome: 'ask', tier: 'gated' },
  },
  {
    name: 'gated with a matching grant is allowed',
    request: req('fs.read', 'fs:/workspace/docs/deep/b.md', 'gated'),
    grants: [readDocs],
    expect: { outcome: 'allow', via: 'grant' },
  },
  {
    name: 'a grant does not cover a different action',
    request: req('fs.write', 'fs:/workspace/docs/b.md', 'gated'),
    grants: [readDocs],
    expect: { outcome: 'ask' },
  },
  {
    name: 'critical always asks, even with a matching grant',
    request: req('fs.delete', 'fs:/workspace/docs/a.md', 'critical'),
    grants: [grant({ actionPattern: 'fs.*', resourcePattern: 'fs:/workspace/**' })],
    expect: { outcome: 'ask', tier: 'critical' },
  },
  {
    name: 'destructive actions are floored to gated',
    request: req('fs.delete', 'fs:/workspace/docs/a.md', 'auto', { destructive: true }),
    grants: [],
    expect: { outcome: 'ask', tier: 'gated' },
  },
  {
    name: 'writing outside the workspace escalates to critical',
    request: req('fs.write', 'fs:/etc/hosts', 'gated'),
    grants: [grant({ actionPattern: 'fs.write', resourcePattern: 'fs:/**' })],
    expect: { outcome: 'ask', tier: 'critical' },
  },
  {
    name: '.. traversal is denied',
    request: req('fs.read', 'fs:/workspace/../etc/passwd', 'auto'),
    grants: [],
    expect: { outcome: 'deny', via: 'normalize' },
  },
  {
    name: 'symlink escape is denied',
    request: req('fs.read', 'fs:/workspace/link/passwd', 'auto'),
    grants: [],
    expect: { outcome: 'deny', via: 'normalize' },
  },
  {
    name: 'deny beats allow at equal specificity',
    request: req('fs.read', 'fs:/workspace/docs/a.md', 'gated'),
    grants: [
      readDocs,
      grant({ actionPattern: 'fs.read', resourcePattern: 'fs:/workspace/docs/**', effect: 'deny' }),
    ],
    expect: { outcome: 'deny', via: 'grant' },
  },
  {
    name: 'a more specific allow beats a broad deny',
    request: req('fs.read', 'fs:/workspace/docs/a.md', 'gated'),
    grants: [grant({ actionPattern: 'fs.*', resourcePattern: 'fs:/workspace/**', effect: 'deny' }), readDocs],
    expect: { outcome: 'allow', via: 'grant' },
  },
  {
    name: 'expired grants are ignored',
    request: req('fs.read', 'fs:/workspace/docs/a.md', 'gated'),
    grants: [{ ...readDocs, expiresAt: '2026-10-07T11:00:00Z' }],
    expect: { outcome: 'ask' },
  },
  {
    name: 'revoked grants are ignored',
    request: req('fs.read', 'fs:/workspace/docs/a.md', 'gated'),
    grants: [{ ...readDocs, revokedAt: '2026-10-07T11:00:00Z' }],
    expect: { outcome: 'ask' },
  },
  {
    name: 'a thread-scoped grant does not leak to another thread',
    request: req('fs.read', 'fs:/workspace/docs/a.md', 'gated', {
      scope: { workspaceId: 'wsp_1', threadId: 'thr_2', notebookId: null },
    }),
    grants: [{ ...readDocs, scope: 'thread', scopeRef: 'thr_1' }],
    expect: { outcome: 'ask' },
  },
  {
    name: 'grants belong to their principal',
    request: req('fs.read', 'fs:/workspace/docs/a.md', 'gated', { principal: 'agent:reviewer' }),
    grants: [readDocs],
    expect: { outcome: 'ask' },
  },
  {
    name: 'an app on /mcp cannot write, even with a grant for everything',
    request: req('fs.write', 'fs:/workspace/docs/a.md', 'gated', { principal: 'mcp:cli_1' }),
    grants: [grant({ principal: 'mcp:cli_1', actionPattern: '*', resourcePattern: '*' })],
    expect: { outcome: 'deny', via: 'policy' },
  },
  {
    name: 'an app on /mcp reads what it was granted',
    request: req('knowledge.search', 'search:launch plan', 'gated', { principal: 'mcp:cli_1' }),
    grants: [grant({ principal: 'mcp:cli_1', actionPattern: 'knowledge.search', resourcePattern: '*' })],
    expect: { outcome: 'allow', via: 'grant' },
  },
  {
    name: 'URL credentials are stripped before matching',
    request: req('http.get', 'http:https://user:pw@API.github.com/repos/x', 'gated'),
    grants: [grant({ actionPattern: 'http.get', resourcePattern: 'http:https://api.github.com/**' })],
    expect: { outcome: 'allow', via: 'grant' },
  },
  {
    name: 'sending is always critical',
    request: req('email.send', 'mcp:mail/send', 'gated'),
    grants: [],
    expect: { outcome: 'ask', tier: 'critical' },
  },
];
