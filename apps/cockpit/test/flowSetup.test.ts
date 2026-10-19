/**
 * FW2: a flow node that needs a key, a GPU provider or an MCP server says
 * what is missing in words, with the fix that opens the right place.
 */
import type { FlowNode, McpServerView } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { newNode } from '../src/flows/kinds';
import type { FlowModel } from '../src/flows/models';
import { mcpServerOf, setupByNode, setupNeeds } from '../src/flows/setup';

const model = (over: Partial<FlowModel>): FlowModel =>
  ({
    id: 'anthropic/claude-x',
    name: 'Claude X',
    provider: 'anthropic',
    via: 'direct',
    status: 'ready',
    awake: null,
    ...over,
  }) as FlowModel;
const modelNode = (id: string, tools: string[] = []): FlowNode => {
  const n = newNode('model', 'm1', { x: 0, y: 0 }) as Extract<FlowNode, { kind: 'model' }>;
  return { ...n, label: 'Writer', params: { ...n.params, model: id, tools } };
};
const server = (over: Partial<McpServerView>): McpServerView =>
  ({
    id: 'srv_1',
    name: 'github',
    status: 'connected',
    last_error: null,
    tools: [],
    ...over,
  }) as McpServerView;
const ctx = (models: FlowModel[], servers?: McpServerView[]) => ({
  models: new Map(models.map((m) => [m.id, m])),
  servers,
  runpodConnected: undefined,
});

describe('setup needs', () => {
  it('names a missing key, why the step needs it, and opens that provider key inline', () => {
    const [need] = setupNeeds(modelNode('anthropic/claude-x'), ctx([model({ status: 'needs_key' })]));
    expect(need).toMatchObject({ code: 'key', fix: { kind: 'key', credential: 'anthropic' } });
    expect(need?.why).toContain('Writer');
    expect(need?.why).toContain('Claude X');
  });

  it('asks for the GPU provider when a node-hosted model cannot answer', () => {
    const m = model({ id: 'controller/llama', name: 'Llama', via: 'controller', status: 'needs_key' });
    expect(setupNeeds(modelNode('controller/llama'), ctx([m]))[0]).toMatchObject({
      code: 'runpod',
      fix: { kind: 'runpod' },
    });
  });

  it('does not ask for anything for a sleeping node, which wakes on use', () => {
    const m = model({ id: 'controller/llama', via: 'controller', status: 'ready', awake: false });
    expect(setupNeeds(modelNode('controller/llama'), ctx([m]))).toEqual([]);
  });

  it('points a signed-out Claude Code model at its sign-in, and a switched-off one at Models', () => {
    expect(
      setupNeeds(modelNode('anthropic/claude-x'), ctx([model({ status: 'signed_out' })]))[0]?.fix,
    ).toEqual({
      kind: 'claude',
    });
    expect(setupNeeds(modelNode('anthropic/claude-x'), ctx([model({ status: 'disabled' })]))[0]?.code).toBe(
      'model_off',
    );
  });

  it('says an MCP server is down, off or missing, and what to do about each', () => {
    const tool = modelNode('anthropic/claude-x', ['github__search']);
    const ready = [model({})];
    expect(
      setupNeeds(tool, ctx(ready, [server({ status: 'error', last_error: 'spawn failed' })]))[0],
    ).toMatchObject({
      code: 'mcp_down',
      fix: { kind: 'mcp', server: 'srv_1', status: 'error' },
    });
    expect(setupNeeds(tool, ctx(ready, [server({ status: 'disabled' })]))[0]?.action).toBe('Switch it on');
    expect(setupNeeds(tool, ctx(ready, []))[0]).toMatchObject({ code: 'mcp_missing' });
    expect(setupNeeds(tool, ctx(ready, [server({})]))).toEqual([]);
    expect(setupNeeds(tool, ctx(ready, undefined))).toEqual([]);
  });

  it('reads the server out of a tool name, and a Tool node counts too', () => {
    expect(mcpServerOf('github__search')).toBe('github');
    expect(mcpServerOf('my_srv__go', ['my_srv', 'my'])).toBe('my_srv');
    expect(mcpServerOf('web.search')).toBeNull();
    expect(mcpServerOf('web_search')).toBeNull();
    const n = { ...newNode('tool', 't1', { x: 0, y: 0 }) } as Extract<FlowNode, { kind: 'tool' }>;
    n.params = { ...n.params, tool: 'linear__create_issue' };
    expect(setupNeeds(n, ctx([], []))[0]?.code).toBe('mcp_missing');
  });

  it('skips bypassed nodes, and groups needs by node', () => {
    const n = { ...modelNode('anthropic/claude-x'), disabled: true };
    expect(setupNeeds(n, ctx([model({ status: 'needs_key' })]))).toEqual([]);
    const by = setupByNode([modelNode('anthropic/claude-x')], ctx([model({ status: 'needs_key' })]));
    expect(by.get('m1')).toHaveLength(1);
  });
});
