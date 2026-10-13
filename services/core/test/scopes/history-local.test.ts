/**
 * ------------------------------------------------------------------
 *  Title    |  Your own server is not the cloud
 *  Ref      |  docs/scopes.md (Private after shared)
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: an Ollama server added as "Your server" on
 *           |  the LAN was counted under "Sent before it became
 *           |  private" as a cloud model. History is classified with
 *           |  the scopes module's local test, which knows LAN hosts.
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import { isLocalModel } from '../../src/engines/select';
import { classifier } from '../../src/scopes/history';

const server = (base_url: string) => ({ provider: 'endpoint-box', via: 'direct' as const, base_url });

describe('a server you added', () => {
  it('is local on this computer or your own network, and not elsewhere', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://192.168.1.20:11434/v1',
      'http://10.0.0.5:8000/v1',
      'http://172.20.1.2:11434/v1',
      'http://studio.local:11434/v1',
      'http://[fd12:3456::1]:11434/v1',
    ])
      expect(isLocalModel(server(url)), url).toBe(true);
    for (const url of ['https://abc-8000.proxy.runpod.net/v1', 'http://172.32.0.1/v1', 'http://8.8.8.8/v1'])
      expect(isLocalModel(server(url)), url).toBe(false);
  });

  it('is left out of what was sent before the notebook became private', () => {
    const models: Record<string, ReturnType<typeof server>> = {
      'endpoint-box/qwen': server('http://192.168.1.20:11434/v1'),
      'endpoint-cloud/qwen': server('https://api.example.com/v1'),
    };
    const classify = classifier((id) => {
      const m = models[id];
      return m ? { provider: m.provider, local: isLocalModel(m) } : undefined;
    });
    expect(classify('endpoint-box/qwen', false)).toBeNull();
    expect(classify('endpoint-cloud/qwen', false)).toBe('other_cloud');
  });
});
