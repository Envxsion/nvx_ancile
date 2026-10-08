import { describe, expect, it } from 'vitest';
import { decide } from '../../src/permissions/decide';
import { depsWith, GOLDEN } from './golden';

describe('decide(): golden table (DESIGN.md §5.3)', () => {
  it.each(GOLDEN.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const out = await decide(c.request, depsWith(c.grants));
    expect(out.outcome).toBe(c.expect.outcome);
    if (c.expect.via) expect('via' in out ? out.via : undefined).toBe(c.expect.via);
    if (c.expect.tier) expect(out.tier).toBe(c.expect.tier);
  });

  it('offers pattern suggestions narrowest first when asking', async () => {
    const out = await decide(
      {
        principal: 'agent:default',
        action: 'fs.write',
        resource: 'fs:/workspace/docs/2024/a.md',
        toolTier: 'gated',
        scope: { workspaceId: 'w' },
      },
      depsWith([]),
    );
    expect(out.outcome).toBe('ask');
    if (out.outcome === 'ask') {
      expect(out.suggestions).toEqual([
        'fs:/workspace/docs/2024/a.md',
        'fs:/workspace/docs/2024/**',
        'fs:/workspace/docs/**',
        'fs:/workspace/**',
      ]);
    }
  });

  it('never offers suggestions for critical actions', async () => {
    const out = await decide(
      {
        principal: 'agent:default',
        action: 'fs.delete',
        resource: 'fs:/workspace/docs/a.md',
        toolTier: 'critical',
        scope: { workspaceId: 'w' },
      },
      depsWith([]),
    );
    expect(out.outcome === 'ask' && out.suggestions).toEqual([]);
  });
});
