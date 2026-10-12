/**
 * Where two scopes meet (docs/scopes.md, docs/notebooks.md): a merged
 * notebook takes the narrower value of every field and private wins; a
 * read across a context link passes the reading side's scope and the
 * linked side's.
 */
import { BUILTIN_TOOL_PRESETS, type ScopePatch } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { checkLinkRead, mergeScopes, resolveScope } from '../../src/scopes';

const scope = (patch: ScopePatch | null, priv = false, id = 'nbk_a') =>
  resolveScope({
    notebookId: id,
    threadId: null,
    private: priv,
    notebook: patch,
    thread: null,
    presets: new Map(BUILTIN_TOOL_PRESETS.map((p) => [p.id, p])),
  });

const PRESETS = new Map(BUILTIN_TOOL_PRESETS.map((p) => [p.id, p]));

describe('merging two notebooks’ scopes', () => {
  it('takes the narrower value of every field and never widens either notebook', () => {
    const a = scope({
      network: false,
      tools_allow: ['fs.*', 'git.*'],
      tools_deny: ['git.push_force'],
      models_allow: ['openai/**'],
      memory_write: true,
    });
    const b = scope({
      tools_allow: ['fs.read', 'web.*'],
      tools_deny: ['shell.*'],
      memory_write: false,
      folders: ['/work/repo'],
    });
    const m = mergeScopes({ scope: a, sourceIds: ['s1'] }, { scope: b, sourceIds: ['s2'] }, PRESETS);
    expect(m.values.network).toBe(false);
    expect(m.values.memory_write).toBe(false);
    expect(m.values.tools_allow).toEqual(['fs.read']);
    expect(m.values.tools_deny.sort()).toEqual(['git.push_force', 'shell.*']);
    expect(m.values.models_allow).toEqual(['openai/**']);
    expect(m.values.folders).toEqual(['/work/repo']);
    expect(m.private).toBe(false);
    // Every changed field says which side it narrows.
    const byField = new Map(m.changes.map((c) => [c.field, c]));
    expect(byField.get('memory_write')).toMatchObject({ narrows_into: true, narrows_from: false });
    expect(byField.get('network')).toMatchObject({ narrows_into: false, narrows_from: true });
    expect(byField.get('tools_allow')).toMatchObject({ narrows_into: true, narrows_from: true });
    // What is stored is exactly the merged values that differ from the defaults.
    expect(m.patch).toMatchObject({ network: false, memory_write: false, tools_allow: ['fs.read'] });
    expect(m.patch).not.toHaveProperty('engines');
  });

  it('keeps each notebook’s own limit on its own sources', () => {
    const a = scope({ sources: ['s1'] });
    const b = scope(null);
    const m = mergeScopes(
      { scope: a, sourceIds: ['s1', 's9'] },
      { scope: b, sourceIds: ['s2', 's3'] },
      PRESETS,
    );
    expect(m.values.sources?.sort()).toEqual(['s1', 's2', 's3']);
    expect(m.changes.find((c) => c.field === 'sources')).toMatchObject({
      narrows_into: false,
      narrows_from: false,
    });
    const none = mergeScopes(
      { scope: scope(null), sourceIds: ['s1'] },
      { scope: b, sourceIds: ['s2'] },
      PRESETS,
    );
    expect(none.values.sources).toBeNull();
  });

  it('private wins: the merged notebook keeps everything on this machine', () => {
    const a = scope({ engines: ['gateway_cloud', 'gateway_local', 'claude_code'] });
    const b = scope(null, true, 'nbk_b');
    const m = mergeScopes({ scope: a, sourceIds: [] }, { scope: b, sourceIds: [] }, PRESETS);
    expect(m.private).toBe(true);
    expect(m.values.data_leaves_machine).toBe(false);
    expect(m.values.engines).toEqual(['gateway_local']);
    expect(m.changes.find((c) => c.field === 'data_leaves_machine')).toMatchObject({ narrows_into: true });
  });

  it('keeps one tool preset and folds a second, different one into the tool fields', () => {
    const a = scope({ tool_preset: 'coding' });
    const b = scope({ tool_preset: 'read_only' });
    const m = mergeScopes({ scope: a, sourceIds: [] }, { scope: b, sourceIds: [] }, PRESETS);
    expect(m.toolPresets).toEqual({ into: 'coding', from: 'read_only', merged: 'coding', folded: true });
    expect(m.values.network).toBe(false);
    expect(m.values.mcp_servers_allow).toEqual([]);
    expect(m.values.tools_allow).toContain('fs.read');
    expect(m.values.tools_allow).not.toContain('shell.*');
    // One side's preset alone is kept as it is; a missing preset folds in as "no tool".
    const one = mergeScopes({ scope: scope(null), sourceIds: [] }, { scope: b, sourceIds: [] }, PRESETS);
    expect(one.toolPresets).toMatchObject({ merged: 'read_only', folded: false });
    const gone = mergeScopes(
      { scope: a, sourceIds: [] },
      { scope: scope({ tool_preset: 'tp_gone' }), sourceIds: [] },
      PRESETS,
    );
    expect(gone.values.tools_allow).toEqual([]);
  });
});

describe('reading across a context link', () => {
  const cloud = scope(null, false, 'nbk_reader');

  it('allows a read when both scopes do', () => {
    expect(checkLinkRead(cloud, scope(null, false, 'nbk_x'), 'X')).toEqual({ ok: true });
  });

  it('refuses when the reading side has context links off', () => {
    const r = checkLinkRead(scope({ context_links: false }), scope(null), 'X');
    expect(r).toMatchObject({ ok: false, code: 'scope.context_links_off', field: 'context_links' });
  });

  it('never links a private notebook into a place answers may leave from', () => {
    const r = checkLinkRead(cloud, scope(null, true, 'nbk_private'), 'The notebook "Diary"');
    expect(r).toMatchObject({ ok: false, code: 'scope.private_notebook', field: 'data_leaves_machine' });
    // A local-only reader may read it, but never through Claude Code.
    const local = scope({ data_leaves_machine: false });
    expect(checkLinkRead(local, scope(null, true), 'X')).toEqual({ ok: true });
    expect(
      checkLinkRead(local, scope(null, true), 'X', { engine: 'claude_code', local: false }),
    ).toMatchObject({
      ok: false,
      code: 'scope.private_notebook',
    });
    expect(checkLinkRead(local, scope(null, true), 'X', { engine: 'gateway', local: true })).toEqual({
      ok: true,
    });
  });

  it('keeps local-only data local', () => {
    const r = checkLinkRead(cloud, scope({ data_leaves_machine: false }), 'X');
    expect(r).toMatchObject({ ok: false, code: 'scope.data_stays_local' });
  });

  it('refuses where the linked side allows fewer engines or models than the reader', () => {
    expect(checkLinkRead(cloud, scope({ engines: ['gateway_cloud'] }), 'X')).toMatchObject({
      ok: false,
      code: 'scope.engine_not_allowed',
    });
    expect(
      checkLinkRead(
        scope({ engines: ['gateway_cloud'] }),
        scope({ engines: ['gateway_cloud', 'claude_code'] }),
        'X',
      ),
    ).toEqual({ ok: true });
    expect(checkLinkRead(cloud, scope({ models_allow: ['openai/**'] }), 'X')).toMatchObject({
      ok: false,
      code: 'scope.model_not_allowed',
      field: 'models_allow',
    });
    expect(checkLinkRead(cloud, scope({ models_deny: ['xai/**'] }), 'X')).toMatchObject({
      ok: false,
      field: 'models_deny',
    });
    expect(
      checkLinkRead(cloud, scope({ engines: ['gateway_cloud'] }), 'X', {
        engine: 'claude_code',
        local: false,
      }),
    ).toMatchObject({ ok: false, code: 'scope.engine_not_allowed' });
  });
});
