/**
 * Tool presets (docs/scopes.md, Tool presets): named tool rules a notebook
 * or thread chooses. They only narrow, compose notebook ∩ thread, fail closed
 * when missing, are enforced in the gate before decide(), and the routes keep
 * built-ins fixed and presets in use undeletable.
 */
import {
  BUILTIN_TOOL_PRESETS,
  type EffectiveScope,
  type StoredScope,
  type ToolPreset,
  type ToolPresetList,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/obs/errors';
import { BuiltinPolicy, LayeredPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import {
  checkToolCall,
  getEffectiveScope,
  MemoryScopeStore,
  PgScopeStore,
  resolveScope,
  scopeResolver,
  widenedFields,
} from '../../src/scopes';
import { scopeRoutes } from '../../src/scopes/routes';
import { eachBackend, uid } from '../support/stores';

const presets = new Map(BUILTIN_TOOL_PRESETS.map((p) => [p.id, p as ToolPreset]));
const resolve = (o: Partial<Parameters<typeof resolveScope>[0]>) =>
  resolveScope({
    notebookId: 'nb',
    threadId: 'th',
    private: false,
    notebook: null,
    thread: null,
    presets,
    ...o,
  });
const may = (s: EffectiveScope, action: string, resource = 'fs:/workspace/a.md') =>
  checkToolCall(s, { action, resource });

describe('tool presets narrow the scope', () => {
  it('ship three built-in presets with sentence case names', () => {
    expect(BUILTIN_TOOL_PRESETS.map((p) => p.id)).toEqual(['research', 'coding', 'read_only']);
    expect(BUILTIN_TOOL_PRESETS.map((p) => p.name)).toEqual(['Research', 'Coding', 'Read only']);
  });

  it('Read only lets reads through and refuses writes, the shell, MCP and the network', () => {
    const s = resolve({ notebook: { tool_preset: 'read_only' } });
    expect(s.scope.tool_preset).toBe('read_only');
    expect(s.provenance.tool_preset.level).toBe('notebook');
    expect(s.tool_presets).toHaveLength(1);
    expect(may(s, 'fs.read').ok).toBe(true);
    expect(may(s, 'git.diff', 'git:/workspace').ok).toBe(true);
    const write = may(s, 'fs.write');
    expect(write).toMatchObject({ ok: false, code: 'scope.tool_not_allowed', field: 'tool_preset' });
    expect(write.ok ? '' : write.reason).toBe('fs.write is not in the Read only tool preset');
    expect(may(s, 'shell.exec', 'shell:ls').ok).toBe(false);
    expect(may(s, 'mcp.github.create_issue', 'mcp:github/create_issue')).toMatchObject({
      ok: false,
      field: 'tool_preset',
    });
  });

  it('Coding allows the shell and git but never a force push', () => {
    const s = resolve({ notebook: { tool_preset: 'coding' } });
    expect(may(s, 'shell.exec', 'shell:pnpm test').ok).toBe(true);
    expect(may(s, 'git.commit', 'git:/workspace').ok).toBe(true);
    expect(may(s, 'git.push_force', 'git:/workspace')).toMatchObject({ ok: false, field: 'tool_preset' });
  });

  it('a preset with no network refuses calls that reach it, even ones it allows by name', () => {
    const own: ToolPreset = {
      id: 'tp_web_offline',
      name: 'Web offline',
      description: '',
      builtin: false,
      updated_at: null,
      tools_allow: ['web.*'],
      tools_deny: [],
      mcp_servers_allow: null,
      mcp_servers_deny: [],
      network: false,
    };
    const s = resolve({
      notebook: { tool_preset: own.id },
      presets: new Map([...presets, [own.id, own]]),
    });
    expect(may(s, 'web.fetch', 'http:https://example.com')).toMatchObject({
      ok: false,
      code: 'scope.network_off',
      field: 'tool_preset',
    });
  });

  it('notebook and thread presets compose: a call must pass both', () => {
    const s = resolve({ notebook: { tool_preset: 'coding' }, thread: { tool_preset: 'read_only' } });
    expect(s.tool_presets.map((p) => [p.level, p.id])).toEqual([
      ['notebook', 'coding'],
      ['thread', 'read_only'],
    ]);
    // The most specific choice is the one shown.
    expect(s.scope.tool_preset).toBe('read_only');
    expect(s.provenance.tool_preset.level).toBe('thread');
    expect(may(s, 'fs.read').ok).toBe(true);
    expect(may(s, 'fs.write').ok).toBe(false); // Coding allows it, Read only does not
    expect(may(s, 'web.search', 'web:q').ok).toBe(false); // Coding allows it, Read only has no network
    // A thread's Research cannot bring back the shell its notebook's Read only refused.
    const t = resolve({ notebook: { tool_preset: 'read_only' }, thread: { tool_preset: 'research' } });
    expect(may(t, 'shell.exec', 'shell:ls').ok).toBe(false);
    expect(may(t, 'web.fetch', 'http:https://example.com').ok).toBe(false);
  });

  it('a preset never widens the scope it sits in, and choosing one is never a widening', () => {
    const s = resolve({ notebook: { tools_deny: ['fs.write'], tool_preset: 'coding' } });
    expect(may(s, 'fs.write')).toMatchObject({ ok: false, field: 'tools_deny' });
    const parent = resolve({ notebook: { network: false } }).scope;
    expect(widenedFields(parent, { tool_preset: 'research' })).toEqual([]);
    const off = resolve({ notebook: { network: false, tool_preset: 'research' } });
    expect(may(off, 'web.fetch', 'http:https://example.com')).toMatchObject({ field: 'network' });
  });

  it('keeps the level’s own lists as they were set', () => {
    const s = resolve({ notebook: { tools_allow: ['fs.*'], tool_preset: 'read_only' } });
    expect(s.scope.tools_allow).toEqual(['fs.*']);
  });

  it('a preset that no longer exists fails closed', () => {
    const s = resolve({ notebook: { tool_preset: 'tp_gone' } });
    expect(s.tool_presets[0]).toMatchObject({ id: 'tp_gone', missing: true });
    expect(may(s, 'fs.read')).toMatchObject({ ok: false, field: 'tool_preset' });
  });
});

describe('tool preset routes', () => {
  let store: MemoryScopeStore;
  let app: Hono;
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    });
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as T };
  };
  type Err = { error: { code: string; title: string; hint: string } };

  beforeEach(() => {
    store = new MemoryScopeStore();
    store.notebooks.add('nb1');
    store.threads.set('th1', 'nb1');
    app = new Hono();
    app.onError(errorHandler);
    app.route('/', scopeRoutes({ store }) as unknown as Hono);
  });

  it('lists the built-in presets first, then your own by name', async () => {
    await call('POST', '/tool-presets', { name: 'Zeta' });
    await call('POST', '/tool-presets', { name: 'Alpha', tools_allow: ['fs.read'] });
    const r = await call<ToolPresetList>('GET', '/tool-presets');
    expect(r.body.presets.map((p) => p.name)).toEqual(['Research', 'Coding', 'Read only', 'Alpha', 'Zeta']);
    const alpha = r.body.presets.find((p) => p.name === 'Alpha');
    expect(alpha).toMatchObject({ builtin: false, tools_allow: ['fs.read'], network: true });
    expect(alpha?.id).toMatch(/^tp_[0-9a-z]{26}$/);
  });

  it('a notebook and its thread choose presets; an unknown one is refused', async () => {
    let r = await call<StoredScope>('PATCH', '/notebooks/nb1/scope', { tool_preset: 'coding' });
    expect(r.status).toBe(200);
    expect(r.body.effective.tool_presets.map((p) => p.id)).toEqual(['coding']);
    r = await call<StoredScope>('PATCH', '/threads/th1/scope', { tool_preset: 'read_only' });
    expect(r.status).toBe(200);
    expect(r.body.effective.tool_presets.map((p) => p.id)).toEqual(['coding', 'read_only']);
    const bad = await call<Err>('PATCH', '/threads/th1/scope', { tool_preset: 'tp_nope' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('tool_preset.not_found');
    // Back to inheriting.
    r = await call<StoredScope>('PATCH', '/threads/th1/scope', { tool_preset: null });
    expect(r.body.effective.tool_presets.map((p) => p.id)).toEqual(['coding']);
  });

  it('your own preset can be edited and applies on the next call', async () => {
    const made = await call<ToolPreset>('POST', '/tool-presets', { name: 'Docs', tools_allow: ['fs.*'] });
    expect(made.status).toBe(201);
    await call('PATCH', '/notebooks/nb1/scope', { tool_preset: made.body.id });
    let e = await getEffectiveScope(store, { threadId: 'th1' });
    expect(checkToolCall(e, { action: 'fs.write', resource: 'fs:/w/a' }).ok).toBe(true);
    const edited = await call<ToolPreset>('PATCH', `/tool-presets/${made.body.id}`, {
      tools_deny: ['fs.write'],
    });
    expect(edited.body.tools_deny).toEqual(['fs.write']);
    e = await getEffectiveScope(store, { threadId: 'th1' });
    expect(checkToolCall(e, { action: 'fs.write', resource: 'fs:/w/a' }).ok).toBe(false);
  });

  it('built-ins cannot be changed or deleted; a preset in use cannot be deleted', async () => {
    const b1 = await call<Err>('PATCH', '/tool-presets/coding', { name: 'Mine' });
    expect(b1.status).toBe(409);
    expect(b1.body.error.code).toBe('tool_preset.builtin');
    expect((await call<Err>('DELETE', '/tool-presets/read_only')).status).toBe(409);

    const made = await call<ToolPreset>('POST', '/tool-presets', { name: 'Docs' });
    await call('PATCH', '/threads/th1/scope', { tool_preset: made.body.id });
    const inUse = await call<Err>('DELETE', `/tool-presets/${made.body.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('tool_preset.in_use');
    expect(inUse.body.error.hint).toContain('1 notebook or thread uses it');
    await call('PATCH', '/threads/th1/scope', { tool_preset: null });
    expect((await call('DELETE', `/tool-presets/${made.body.id}`)).status).toBe(204);
    expect((await call<Err>('DELETE', `/tool-presets/${made.body.id}`)).status).toBe(404);
  });

  it('refuses rules that are not rules', async () => {
    const r = await call<Err>('POST', '/tool-presets', { name: 'x', tools_allow: 'fs.*' });
    expect(r.status).toBe(400);
    const extra = await call<Err>('POST', '/tool-presets', { name: 'x', grants: ['*'] });
    expect(extra.status).toBe(400);
  });
});

describe('the gate enforces tool presets before decide()', () => {
  it('refuses a call outside the preset as a policy_deny on scope.tool_preset', async () => {
    const scopes = new MemoryScopeStore();
    scopes.threads.set('th1', 'nb1');
    await scopes.mergePatch('notebook', 'nb1', { tool_preset: 'read_only' });
    const store = new MemoryPermissionStore();
    const gate = createGate({
      policy: new LayeredPolicy([new BuiltinPolicy()]),
      store,
      workspaceRoot: '/workspace',
      scopes: scopeResolver(scopes),
    });
    const base = {
      userId: 'u',
      principal: 'agent:default',
      toolTier: 'auto' as const,
      destructive: false,
      scope: { threadId: 'th1', notebookId: null, workspaceId: 'w' },
      runId: 'run1',
      traceId: 't',
    };
    const d = await gate.check({ ...base, action: 'fs.write', resource: 'fs:/workspace/a.md' });
    expect(d).toMatchObject({ outcome: 'deny', via: 'scope', code: 'scope.tool_not_allowed' });
    const [rec] = await store.listDecisions(1);
    expect(rec).toMatchObject({ outcome: 'policy_deny', policy_id: 'scope.tool_preset' });
    // Inside the preset, permissions decide as usual.
    expect((await gate.check({ ...base, action: 'fs.read', resource: 'fs:/workspace/a.md' })).outcome).toBe(
      'allow',
    );
  });
});

eachBackend('tool preset store', (backend) => {
  it('keeps your own presets, counts their uses and deletes them', async () => {
    const b = backend();
    const store = b.sql ? new PgScopeStore(b.sql) : new MemoryScopeStore();
    const id = `tp_${uid('t')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}`;
    const saved = await store.putPreset({
      id,
      name: 'Store test',
      description: 'Only for this test',
      builtin: false,
      updated_at: null,
      tools_allow: ['fs.read'],
      tools_deny: ['fs.delete'],
      mcp_servers_allow: [],
      mcp_servers_deny: [],
      network: false,
    });
    expect(saved).toMatchObject({ id, builtin: false, tools_allow: ['fs.read'], network: false });
    expect(saved.updated_at).not.toBeNull();
    expect((await store.listPresets()).some((p) => p.id === id)).toBe(true);
    const nb = uid('nb');
    await store.mergePatch('notebook', nb, { tool_preset: id });
    expect(await store.presetUsage(id)).toBe(1);
    const e = await getEffectiveScope(store, { notebookId: nb });
    expect(e.tool_presets[0]).toMatchObject({ id, name: 'Store test', missing: false });
    await store.mergePatch('notebook', nb, { tool_preset: null });
    expect(await store.presetUsage(id)).toBe(0);
    expect(await store.deletePreset(id)).toBe(true);
    expect(await store.deletePreset(id)).toBe(false);
  });
});
