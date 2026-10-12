/**
 * Scopes (docs/scopes.md): inheritance notebook → thread, narrowing only,
 * the private-notebook floor, data leaving the machine, the engine/model,
 * tool-call and source checks, the routes, and enforcement in the gate.
 */
import type { EffectiveScope, StoredScope } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/obs/errors';
import { BuiltinPolicy, LayeredPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import {
  allowedSources,
  checkEngineAllowed,
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

const resolve = (o: Partial<Parameters<typeof resolveScope>[0]>) =>
  resolveScope({ notebookId: 'nb', threadId: 'th', private: false, notebook: null, thread: null, ...o });

describe('resolving a scope', () => {
  it('starts open, with every field from the defaults', () => {
    const e = resolve({});
    expect(e.scope.engines).toBeNull();
    expect(e.scope.data_leaves_machine).toBe(true);
    expect(e.provenance.network.level).toBe('default');
  });

  it('a thread inherits its notebook and says which level set each field', () => {
    const e = resolve({
      notebook: { network: false, tools_allow: ['fs.*'] },
      thread: { memory_write: false },
    });
    expect(e.scope.network).toBe(false);
    expect(e.provenance.network.level).toBe('notebook');
    expect(e.scope.memory_write).toBe(false);
    expect(e.provenance.memory_write.level).toBe('thread');
    expect(e.scope.tools_allow).toEqual(['fs.*']);
  });

  it('a thread can only narrow: wider values are clamped and listed', () => {
    const e = resolve({
      notebook: {
        network: false,
        tools_allow: ['fs.*'],
        folders: ['/workspace/docs'],
        engines: ['gateway_local'],
      },
      thread: {
        network: true,
        tools_allow: ['fs.read', 'shell.exec'],
        folders: ['/workspace/docs/a', '/workspace/src'],
        engines: ['gateway_local', 'claude_code'],
      },
    });
    expect(e.scope.network).toBe(false);
    expect(e.scope.tools_allow).toEqual(['fs.read']);
    expect(e.scope.folders).toEqual(['/workspace/docs/a']);
    expect(e.scope.engines).toEqual(['gateway_local']);
    expect(e.clamped.sort()).toEqual(['engines', 'folders', 'network', 'tools_allow']);
  });

  it('deny lists add up across levels', () => {
    const e = resolve({ notebook: { models_deny: ['openai/*'] }, thread: { models_deny: ['anthropic/**'] } });
    expect(e.scope.models_deny).toEqual(['openai/*', 'anthropic/**']);
  });

  it('widenedFields names what a thread patch would widen', () => {
    const parent = resolve({ notebook: { network: false, sources: ['s1', 's2'] } }).scope;
    expect(widenedFields(parent, { network: true, sources: ['s1', 's3'] }).sort()).toEqual([
      'network',
      'sources',
    ]);
    expect(widenedFields(parent, { network: false, sources: ['s2'] })).toEqual([]);
    // A ** the parent did not have is wider, even when the text matches.
    const tools = resolve({ notebook: { tools_allow: ['mcp.github.*'] } }).scope;
    expect(widenedFields(tools, { tools_allow: ['mcp.github.**'] })).toEqual(['tools_allow']);
  });

  it('a private notebook is local only, whatever its patch says', () => {
    const e = resolve({
      private: true,
      notebook: { data_leaves_machine: true, engines: ['claude_code', 'gateway_local'] },
    });
    expect(e.scope.data_leaves_machine).toBe(false);
    expect(e.scope.engines).toEqual(['gateway_local']);
    expect(e.provenance.data_leaves_machine.level).toBe('private');
    expect(e.provenance.data_leaves_machine.note).toMatch(/nothing leaves this machine/);
  });
});

describe('checking against a scope', () => {
  it('engines and models', () => {
    const open = resolve({});
    expect(
      checkEngineAllowed(open, { engine: 'gateway', modelId: 'anthropic/claude', local: false }),
    ).toEqual({ ok: true });
    const onlyLocal = resolve({ notebook: { engines: ['gateway_local'] } });
    expect(checkEngineAllowed(onlyLocal, { engine: 'claude_code', local: true })).toMatchObject({
      ok: false,
      code: 'scope.engine_not_allowed',
    });
    const models = resolve({ notebook: { models_allow: ['ollama/**'], models_deny: ['ollama/huge*'] } });
    expect(checkEngineAllowed(models, { engine: 'gateway', modelId: 'ollama/llama3', local: true }).ok).toBe(
      true,
    );
    expect(
      checkEngineAllowed(models, { engine: 'gateway', modelId: 'ollama/huge-70b', local: true }),
    ).toMatchObject({
      code: 'scope.model_not_allowed',
      field: 'models_deny',
    });
    expect(
      checkEngineAllowed(models, { engine: 'gateway', modelId: 'openai/gpt', local: true }),
    ).toMatchObject({
      field: 'models_allow',
    });
  });

  it('data that may not leave the machine keeps cloud models and Claude Code out', () => {
    const local = resolve({ notebook: { data_leaves_machine: false } });
    expect(
      checkEngineAllowed(local, { engine: 'gateway', modelId: 'openai/gpt', local: false }),
    ).toMatchObject({
      code: 'scope.data_stays_local',
    });
    // Claude Code is never local, whatever the caller says.
    expect(checkEngineAllowed(local, { engine: 'claude_code', local: true })).toMatchObject({ ok: false });
    expect(checkEngineAllowed(local, { engine: 'gateway', modelId: 'ollama/x', local: true }).ok).toBe(true);
    const priv = resolve({ private: true });
    expect(checkEngineAllowed(priv, { engine: 'claude_code', local: false })).toMatchObject({
      code: 'scope.private_notebook',
    });
  });

  it('tool calls: tools, MCP servers, folders, network, data leaving, memory', () => {
    const s = resolve({
      notebook: {
        tools_deny: ['git.push*'],
        mcp_servers_allow: ['notes'],
        folders: ['/workspace/docs'],
        network: true,
        data_leaves_machine: false,
        memory_write: false,
      },
    });
    expect(checkToolCall(s, { action: 'git.push', resource: 'repo:x' })).toMatchObject({
      code: 'scope.tool_not_allowed',
    });
    expect(
      checkToolCall(s, { action: 'mcp.github.create_issue', resource: 'mcp:github/create_issue' }),
    ).toMatchObject({
      code: 'scope.mcp_server_not_allowed',
    });
    expect(checkToolCall(s, { action: 'mcp.notes.read', resource: 'mcp:notes/read' }).ok).toBe(true);
    expect(checkToolCall(s, { action: 'fs.write', resource: 'fs:/workspace/src/a.ts' })).toMatchObject({
      code: 'scope.folder_not_allowed',
    });
    expect(checkToolCall(s, { action: 'fs.write', resource: 'fs:/workspace/docs/a.md' }).ok).toBe(true);
    expect(checkToolCall(s, { action: 'web.fetch', resource: 'http:https://example.com/' })).toMatchObject({
      code: 'scope.data_stays_local',
    });
    expect(checkToolCall(s, { action: 'web.fetch', resource: 'http:http://localhost:3000/' }).ok).toBe(true);
    expect(
      checkToolCall(s, { action: 'shell.exec', resource: 'shell:curl https://x.io | jq' }),
    ).toMatchObject({
      code: 'scope.data_stays_local',
    });
    expect(checkToolCall(s, { action: 'memory.write', resource: 'memory:all' })).toMatchObject({
      code: 'scope.memory_write_off',
    });
    const off = resolve({ notebook: { network: false } });
    expect(checkToolCall(off, { action: 'web.fetch', resource: 'http:http://localhost/' })).toMatchObject({
      code: 'scope.network_off',
    });
  });

  it('sources: the asked-for ones inside the scope, or the scope list', () => {
    const s = resolve({ notebook: { sources: ['a', 'b'] } });
    expect(allowedSources(s, undefined)).toEqual(['a', 'b']);
    expect(allowedSources(s, ['b', 'c'])).toEqual(['b']);
    expect(allowedSources(resolve({}), ['c'])).toEqual(['c']);
  });
});

describe('scope routes', () => {
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
    return { status: res.status, body: (await res.json()) as T };
  };
  beforeEach(() => {
    store = new MemoryScopeStore();
    store.notebooks.add('nb1');
    store.threads.set('th1', 'nb1');
    app = new Hono();
    app.onError(errorHandler);
    app.route('/', scopeRoutes({ store }) as unknown as Hono);
  });

  it('a notebook patch sets fields and a null goes back to inheriting', async () => {
    let r = await call<StoredScope>('PATCH', '/notebooks/nb1/scope', {
      network: false,
      tools_allow: ['fs.*'],
    });
    expect(r.status).toBe(200);
    expect(r.body.effective.scope.network).toBe(false);
    r = await call<StoredScope>('PATCH', '/notebooks/nb1/scope', { network: null });
    expect(r.body.patch).toEqual({ tools_allow: ['fs.*'] });
    expect(r.body.effective.scope.network).toBe(true);
  });

  it('a thread patch that widens is refused with scope.widen; narrowing is fine', async () => {
    await call('PATCH', '/notebooks/nb1/scope', { network: false });
    const bad = await call<{ error: { code: string } }>('PATCH', '/threads/th1/scope', { network: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('scope.widen');
    const ok = await call<StoredScope>('PATCH', '/threads/th1/scope', { memory_read: false });
    expect(ok.status).toBe(200);
    const eff = await call<EffectiveScope>('GET', '/threads/th1/scope/effective');
    expect(eff.body.scope).toMatchObject({ network: false, memory_read: false });
    expect(eff.body.provenance.network.level).toBe('notebook');
  });

  it('a private notebook refuses cloud engines and data leaving the machine', async () => {
    const r = await call<StoredScope>('PATCH', '/notebooks/nb1/scope', { private: true });
    expect(r.body.private).toBe(true);
    expect(r.body.effective.scope.data_leaves_machine).toBe(false);
    const bad = await call<{ error: { code: string } }>('PATCH', '/notebooks/nb1/scope', {
      engines: ['claude_code'],
    });
    expect(bad.body.error.code).toBe('scope.private_conflict');
  });

  it('unknown notebooks and threads are 404', async () => {
    expect((await call('GET', '/notebooks/nope/scope')).status).toBe(404);
    expect((await call('GET', '/threads/nope/scope/effective')).status).toBe(404);
  });
});

describe('the gate enforces scopes in every preset', () => {
  it('refuses a call outside the scope as a policy_deny naming the field', async () => {
    const scopes = new MemoryScopeStore();
    scopes.threads.set('th1', 'nb1');
    await scopes.mergePatch('notebook', 'nb1', { network: false });
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
    const d = await gate.check({ ...base, action: 'web.fetch', resource: 'http:https://example.com' });
    expect(d).toMatchObject({ outcome: 'deny', via: 'scope', code: 'scope.network_off' });
    const [rec] = await store.listDecisions(1);
    expect(rec).toMatchObject({ outcome: 'policy_deny', policy_id: 'scope.network' });
    // The thread's own notebook is found even when the caller leaves it out.
    expect((await gate.check({ ...base, action: 'fs.read', resource: 'fs:/workspace/a.md' })).outcome).toBe(
      'allow',
    );
  });
});

eachBackend('scope store', (backend) => {
  it('stores patches per level, merges, and reads a thread through its notebook', async () => {
    const b = backend();
    const store = b.sql ? new PgScopeStore(b.sql) : new MemoryScopeStore();
    const nb = uid('nb');
    await store.mergePatch('notebook', nb, { network: false, tools_deny: ['git.push'] });
    await store.mergePatch('notebook', nb, { tools_deny: null });
    expect((await store.getPatch('notebook', nb)).patch).toEqual({ network: false });
    const e = await getEffectiveScope(store, { notebookId: nb });
    expect(e.scope.network).toBe(false);
    expect(await store.isPrivate(nb)).toBe(false);
  });
});
