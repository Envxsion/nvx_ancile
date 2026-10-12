import { describe, expect, it } from 'vitest';
import { decide, refusalForModel } from '../../src/permissions/decide';
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

describe('what a model is told when a call is refused', () => {
  it("says a tool preset's refusal is a setting the person changes in the scope editor, not something to approve", () => {
    const msg = refusalForModel({
      outcome: 'deny',
      via: 'scope',
      tier: 'gated',
      resource: 'fs:/workspace/a.md',
      reason: 'fs.write is not in the Read only tool preset',
      policyId: 'scope.tool_preset',
    });
    expect(msg).toContain('fs.write is not in the Read only tool preset');
    expect(msg).toContain("this thread's tool preset");
    expect(msg).toContain('cannot be approved here');
    expect(msg).toContain('scope editor');
    expect(
      refusalForModel({
        outcome: 'deny',
        via: 'policy',
        tier: 'gated',
        resource: 'x',
        reason: 'r',
        policyId: 'p1',
      }),
    ).toBe('A policy blocks this (p1).');
  });
});
