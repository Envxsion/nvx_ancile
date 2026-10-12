/**
 * ------------------------------------------------------------------
 *  Title    |  A pod deleted outside the Controller
 *  Ref      |  nodes.ts (reconcile, markGone)
 *  ID       |  controller/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: a pod deleted in RunPod's console stayed
 *           |  "running" in Admin → Compute. Reconcile now marks a
 *           |  node the provider no longer has as terminated, with a
 *           |  notice, and leaves nodes it merely cannot reach alone.
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import { reconcile, register } from '../../src/nodes';
import { FakeProvider } from '../../src/providers/fake';
import { ProviderError } from '../../src/providers/types';
import { MemoryStore, type StoreEvent } from '../../src/store';

async function world() {
  const store = new MemoryStore();
  const provider = new FakeProvider(0).add({
    ref: 'p1',
    name: 'Pod 3060',
    state: 'running',
    gpuType: 'RTX 3060',
    hourlyRate: 0.2,
    endpointUrl: 'http://pod.test/v1',
  });
  const node = await register(store, provider, { provider_ref: 'p1', served_models: ['qwen'] });
  return { store, provider, node };
}

describe('reconciling with the provider', () => {
  it('marks a pod the provider no longer has as terminated, with a notice', async () => {
    const w = await world();
    const notices: StoreEvent[] = [];
    w.store.events.on('event', (e) => e.type === 'notice' && notices.push(e));
    w.provider.getNode = async () => {
      throw new ProviderError(
        { code: 'not_found', provider_message: 'pod not found', suggestion: 'Remove the node.' },
        404,
        false,
      );
    };
    expect(await reconcile(w.store, w.provider)).toBe(1);
    const after = await w.store.getNode(w.node.id);
    expect(after).toMatchObject({ observed_state: 'terminated', endpoint_url: null, healthy: false });
    expect(notices[0]).toMatchObject({ level: 'warn', title: 'Pod 3060 was deleted outside NVX Ancile' });
  });

  it('leaves a node alone when the provider cannot be reached', async () => {
    const w = await world();
    w.provider.getNode = async () => {
      throw new ProviderError(
        { code: 'network', provider_message: 'timeout', suggestion: 'Retry.' },
        null,
        true,
      );
    };
    expect(await reconcile(w.store, w.provider)).toBe(0);
    expect((await w.store.getNode(w.node.id))?.observed_state).toBe('running');
  });
});
