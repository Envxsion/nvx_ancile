/**
 * Phase 5: the models your GPU nodes serve appear in the model switcher,
 * and Core's /compute routes speak to the Controller with its token.
 */
import { describe, expect, it } from 'vitest';
import { nodeModelId, nodeModels } from '../../src/compute/bridge';
import { controllerClient } from '../../src/compute/controller';

describe('node models', () => {
  it('lists each served model once, named for its node, skipping terminated nodes', () => {
    const models = nodeModels([
      {
        id: 'n1',
        name: 'Studio A100',
        gpu_type: 'A100',
        provider: 'runpod',
        served_models: ['llama-3.3-70b-instruct', 'meta/llama 3'],
        observed_state: 'stopped',
      },
      {
        id: 'n2',
        name: 'Old',
        gpu_type: 'A10',
        provider: 'runpod',
        served_models: ['gone'],
        observed_state: 'terminated',
      },
    ]);
    expect(models.map((m) => m.id)).toEqual(['node/llama-3.3-70b-instruct', 'node/meta-llama-3']);
    expect(models[0]).toMatchObject({
      via: 'controller',
      provider_model: 'node/llama-3.3-70b-instruct',
      display_name: 'llama-3.3-70b-instruct on Studio A100',
    });
    expect(nodeModelId('a/b c')).toBe('node/a-b-c');
  });
});

describe('controller client', () => {
  it('sends the token and turns Controller errors into NVX Ancile errors', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const client = controllerClient({
      url: 'http://ctl:7720/',
      token: 'tok-1234567890abcdef',
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return Response.json(
          { error: { code: 'node.not_found', title: 'No such node', hint: 'Refresh the node list.' } },
          { status: 404 },
        );
      }) as typeof fetch,
    });
    const err = await client.get('/nodes/x').catch((e) => e);
    expect(seen[0]).toEqual({
      url: 'http://ctl:7720/control/v1/nodes/x',
      auth: 'Bearer tok-1234567890abcdef',
    });
    expect(err).toMatchObject({ code: 'node.not_found', title: 'No such node', status: 404 });
  });

  it('says plainly when remote compute is not set up', async () => {
    const client = controllerClient({ url: undefined, token: undefined });
    expect(client.configured).toBe(false);
    await expect(client.get('/nodes')).rejects.toMatchObject({ code: 'compute.not_configured' });
  });
});
