/**
 * decide() sees the call's real arguments (CLAUDE.md: "on the real arguments, at execution time").
 * A file path, a command or an address is already in the resource; an MCP or plugin tool's resource
 * is `mcp:<server>/<tool>` and names only the tool, so what it was asked to do reaches the policies
 * as Cedar's context.args (canonical JSON text), and a policy can forbid or escalate on it.
 */
import { describe, expect, it } from 'vitest';
import { argsText, BuiltinPolicy, loadCedarEvaluator } from '../../src/permissions/cedar';
import { type DecisionRequest, decide, type PolicyEvaluator } from '../../src/permissions/decide';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { fakeFs, ROOT } from './golden';

const POLICY = `
@id("mine.no-prod-issues")
forbid (principal, action == Ancile::Action::"mcp.github.create_issue", resource)
when { context.args like "*\\"repo\\":\\"prod\\"*" };

@id("mine.big-deletes-ask")
@escalate("critical")
permit (principal, action == Ancile::Action::"mcp.files.remove", resource)
when { context.args like "*\\"recursive\\":true*" };
`;

const mcp = (args: unknown): DecisionRequest => ({
  principal: 'agent:default',
  action: 'mcp.github.create_issue',
  resource: 'mcp:github/create_issue',
  toolTier: 'gated',
  scope: { workspaceId: 'w' },
  ...(args !== undefined && { args }),
});

describe('what a policy reads of an MCP tool call', () => {
  it('is its real arguments, not only the tool', async () => {
    const policy = await loadCedarEvaluator({ files: { 'mine.cedar': POLICY }, preset: 'balanced' });
    const deps = { policy, grants: { forPrincipal: async () => [] }, workspaceRoot: ROOT, fs: fakeFs };
    // The same tool, two sets of arguments: only the one for prod is forbidden.
    expect(await decide(mcp({ repo: 'prod', title: 'x' }), deps)).toMatchObject({
      outcome: 'deny',
      via: 'policy',
      policyId: 'mine.no-prod-issues',
    });
    expect(await decide(mcp({ title: 'x', repo: 'staging' }), deps)).toMatchObject({ outcome: 'ask' });
    // Key order does not hide it: policies read canonical JSON.
    expect(await decide(mcp({ title: 'x', repo: 'prod' }), deps)).toMatchObject({ outcome: 'deny' });
    // Without arguments there is nothing to match, as before.
    expect(await decide(mcp(undefined), deps)).toMatchObject({ outcome: 'ask' });
    // A policy can raise the tier on what a call is asked to do.
    const remove = await decide(
      { ...mcp({ path: 'a', recursive: true }), action: 'mcp.files.remove', resource: 'mcp:files/remove' },
      deps,
    );
    expect(remove).toMatchObject({ outcome: 'ask', tier: 'critical' });
    const single = await decide(
      { ...mcp({ path: 'a', recursive: false }), action: 'mcp.files.remove', resource: 'mcp:files/remove' },
      deps,
    );
    expect(single).toMatchObject({ outcome: 'ask', tier: 'gated' });
  });

  it('reaches the policy from the gate, on the arguments the caller passed', async () => {
    const seen: unknown[] = [];
    const builtin = new BuiltinPolicy();
    const spy: PolicyEvaluator = {
      forbids: async (r) => {
        seen.push(r.args);
        return builtin.forbids(r);
      },
      escalation: async (r) => {
        seen.push(r.args);
        return builtin.escalation(r);
      },
    };
    const gate = createGate({ policy: spy, store: new MemoryPermissionStore(), workspaceRoot: ROOT });
    const args = { repo: 'prod', title: 'x' };
    await gate.check({
      userId: 'u',
      principal: 'agent:default',
      action: 'mcp.github.create_issue',
      resource: 'mcp:github/create_issue',
      toolTier: 'gated',
      destructive: false,
      scope: { workspaceId: 'w' },
      runId: null,
      traceId: 't',
      tool: 'github__create_issue',
      args,
    });
    expect(seen).toEqual([args, args]);
  });

  it('is canonical JSON, cut short for a huge write', () => {
    expect(argsText({ b: 1, a: { d: 2, c: [3] } })).toBe('{"a":{"c":[3],"d":2},"b":1}');
    expect(argsText(undefined)).toBe('');
    expect(argsText('x'.repeat(50_000))).toHaveLength(20_000);
  });
});
