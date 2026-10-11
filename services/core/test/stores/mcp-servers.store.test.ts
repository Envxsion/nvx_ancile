/**
 * MCP servers added in the app, from both backends: created with their
 * env, headers and secret keys (never values), renamed without taking a
 * name already used, changed and removed.
 */
import { beforeEach, expect, it } from 'vitest';
import {
  type McpServerRow,
  type McpServerStore,
  MemoryMcpServerStore,
  PgMcpServerStore,
} from '../../src/mcp/store';
import { eachBackend, uid } from '../support/stores';

eachBackend('MCP server store', (backend) => {
  let store: McpServerStore;
  beforeEach(() => {
    const b = backend();
    store = b.sql ? new PgMcpServerStore(b.sql) : new MemoryMcpServerStore();
  });

  const row = (over: Partial<McpServerRow> = {}): Omit<McpServerRow, 'created_at'> => ({
    id: uid('mcp'),
    name: uid('srv').toLowerCase(),
    transport: 'stdio',
    command: 'notes-server',
    args: ['--fast'],
    env: { LOG_LEVEL: 'debug' },
    url: null,
    headers: {},
    secret_keys: ['NOTES_TOKEN'],
    enabled: true,
    tool_overrides: {},
    ...over,
  });

  it('creates, reads by id and name, changes and removes', async () => {
    const r = row();
    expect(await store.create(r)).toBe(true);
    const got = await store.get(r.id);
    expect(got).toMatchObject({ ...r });
    expect(got?.created_at).toMatch(/^\d{4}-/);
    expect((await store.byName(r.name))?.id).toBe(r.id);
    expect((await store.list()).some((x) => x.id === r.id)).toBe(true);

    const changed = await store.update(r.id, {
      enabled: false,
      args: [],
      secret_keys: ['A', 'B'],
      tool_overrides: { post: { tier: 'critical' }, wipe: { disabled: true } },
    });
    expect(changed).toMatchObject({
      enabled: false,
      args: [],
      secret_keys: ['A', 'B'],
      tool_overrides: { post: { tier: 'critical' }, wipe: { disabled: true } },
      command: 'notes-server',
    });
    expect(await store.update(uid('mcp'), { enabled: true })).toBeUndefined();
    expect(await store.remove(r.id)).toBe(true);
    expect(await store.remove(r.id)).toBe(false);
    expect(await store.get(r.id)).toBeUndefined();
  });

  it('keeps names unique on create and rename', async () => {
    const a = row();
    const b = row({
      transport: 'http',
      command: null,
      args: [],
      url: 'https://x.example/mcp',
      headers: { 'X-A': '1' },
    });
    expect(await store.create(a)).toBe(true);
    expect(await store.create(b)).toBe(true);
    expect(await store.get(b.id)).toMatchObject({
      transport: 'http',
      url: 'https://x.example/mcp',
      headers: { 'X-A': '1' },
    });
    expect(await store.create({ ...row(), name: a.name })).toBe(false);
    expect(await store.update(b.id, { name: a.name })).toBe(false);
    expect((await store.get(b.id))?.name).toBe(b.name);
    await store.remove(a.id);
    await store.remove(b.id);
  });
});
