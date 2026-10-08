/**
 * The local network provider: a box on your LAN running Ollama, vLLM or any
 * OpenAI-compatible server is a node whose state comes from probing it.
 */
import { describe, expect, it } from 'vitest';
import { LocalNetworkProvider, parseLocalNodes } from '../../src/providers/local';
import { ProviderError } from '../../src/providers/types';

const spec = { name: 'Desk 3090', url: 'http://192.168.1.20:11434/v1', gpu: 'RTX 3090', models: [] };

function fetchFrom(routes: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const r = routes[String(url)];
    if (!r) throw new TypeError('fetch failed');
    return r();
  }) as typeof fetch;
}

describe('local network provider', () => {
  it('is running when /v1/models answers, and reports what it serves', async () => {
    const p = new LocalNetworkProvider([spec], {
      fetch: fetchFrom({
        'http://192.168.1.20:11434/v1/models': () =>
          Response.json({ data: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5:14b' }] }),
      }),
    });
    const n = await p.getNode(spec.url);
    expect(n).toMatchObject({ state: 'running', hourlyRate: 0, endpointUrl: spec.url });
    expect(n.servedModels).toEqual(['llama3.1:8b', 'qwen2.5:14b']);
  });

  it("falls back to Ollama's /api/version, and is stopped when nothing answers", async () => {
    const ollama = new LocalNetworkProvider([{ ...spec, models: ['llama3.1:8b'] }], {
      fetch: fetchFrom({ 'http://192.168.1.20:11434/api/version': () => Response.json({ version: '0.6' }) }),
    });
    expect((await ollama.getNode(spec.url)).state).toBe('running');
    const off = new LocalNetworkProvider([spec], { fetch: fetchFrom({}) });
    const n = await off.getNode(spec.url);
    expect(n.state).toBe('stopped');
    expect(n.endpointUrl).toBeNull();
  });

  it('cannot power a machine on, and says what to do instead', async () => {
    const p = new LocalNetworkProvider([spec], { fetch: fetchFrom({}) });
    const err = await p.action(spec.url, 'start').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.error.code).toBe('manual_node');
    expect(err.error.suggestion).toMatch(/Turn Desk 3090 on/);
  });

  it('parses CONTROLLER_LOCAL_NODES and rejects a bad URL', () => {
    expect(parseLocalNodes('')).toEqual([]);
    expect(parseLocalNodes(JSON.stringify([{ name: 'A', url: 'http://a:8000/v1' }]))[0]?.gpu).toBe(
      'Local GPU',
    );
    expect(() => parseLocalNodes(JSON.stringify([{ name: 'A', url: 'not a url' }]))).toThrow();
  });
});
