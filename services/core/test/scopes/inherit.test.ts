/**
 * The limits a thread keeps when its notebook is deleted (scopes/inherit.ts): the notebook's private
 * switch and scope patch laid over the thread's own, the stricter value of every field winning,
 * and never anything wider than either had.
 */
import { BUILTIN_TOOL_PRESETS, type ScopePatch } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { inheritedPatch, limitsAnything } from '../../src/scopes/inherit';
import { resolveScope } from '../../src/scopes/resolve';

const merge = (notebook: ScopePatch, thread: ScopePatch = {}, priv = false) =>
  inheritedPatch({ private: priv, notebook, thread });

/** What the thread can do afterwards, with no notebook behind it. */
const after = (patch: ScopePatch) =>
  resolveScope({ notebookId: null, threadId: 't', private: false, notebook: null, thread: patch });

describe('inheritedPatch', () => {
  it('turns a private notebook into a thread that stays on this machine with local models', () => {
    expect(merge({}, {}, true)).toEqual({ data_leaves_machine: false, engines: ['gateway_local'] });
    const s = after(merge({}, {}, true)).scope;
    expect(s.data_leaves_machine).toBe(false);
    expect(s.engines).toEqual(['gateway_local']);
  });

  it('a private notebook that listed a cloud engine still ends up local only', () => {
    const p = merge({ engines: ['gateway_local', 'gateway_cloud', 'claude_code'] }, {}, true);
    expect(p.engines).toEqual(['gateway_local']);
  });

  it('keeps a thread’s own limit and adds the notebook’s: off wins, deny lists join, allow lists intersect', () => {
    const p = merge(
      { network: false, memory_write: true, tools_deny: ['shell.run'], tools_allow: ['fs.read', 'fs.list'] },
      { memory_write: false, tools_deny: ['fs.write'], tools_allow: ['fs.read'] },
    );
    expect(p.network).toBe(false);
    expect(p.memory_write).toBe(false);
    expect([...(p.tools_deny ?? [])].sort()).toEqual(['fs.write', 'shell.run']);
    expect(p.tools_allow).toEqual(['fs.read']);
  });

  it('never widens: a thread that already allowed less keeps allowing less', () => {
    const p = merge({ engines: ['gateway_local', 'gateway_cloud'] }, { engines: ['gateway_local'] });
    expect(p.engines).toEqual(['gateway_local']);
  });

  it('copies nothing for a notebook that limited nothing, and leaves the thread’s patch as it was', () => {
    expect(limitsAnything(false, {})).toBe(false);
    expect(limitsAnything(false, { network: false })).toBe(true);
    expect(limitsAnything(true, {})).toBe(true);
    expect(merge({}, { network: false })).toEqual({ network: false });
  });

  it('gives a thread the notebook’s tool preset, and folds it into a different one the thread chose', () => {
    const [a, b] = BUILTIN_TOOL_PRESETS.filter(
      (p) => p.tools_allow !== null || p.tools_deny.length || !p.network,
    );
    expect(a && b).toBeTruthy();
    const given = merge({ tool_preset: a?.id as string });
    expect(given.tool_preset).toBe(a?.id);
    const both = merge({ tool_preset: a?.id as string }, { tool_preset: b?.id as string });
    expect(both.tool_preset).toBe(b?.id);
    // The notebook's preset can no longer be a layer of its own, so its rules are in the thread's.
    if (!a?.network) expect(both.network).toBe(false);
    if (a?.tools_allow) expect(both.tools_allow).toBeDefined();
  });

  it('a notebook preset that no longer exists folds in as "no tool at all"', () => {
    const p = merge({ tool_preset: 'gone' }, { tool_preset: BUILTIN_TOOL_PRESETS[0]?.id as string });
    expect(p.tools_allow).toEqual([]);
    expect(p.network).toBe(false);
  });
});
