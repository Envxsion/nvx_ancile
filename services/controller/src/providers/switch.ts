/**
 * ------------------------------------------------------------------
 *  Title    |  Switchable provider
 *  Ref      |  docs/compute.md (Connecting RunPod)
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  One provider for the life of the process, whose inside
 *           |  can change: sample nodes until RunPod is connected from
 *           |  the app, RunPod after, sample nodes again on disconnect.
 *  How      |  Every call goes to the provider in use at that moment.
 *           |  The optional parts (create, serve) appear and disappear
 *           |  with it, so routes that ask "can it create?" stay true.
 *  Note     |  The key is held only in memory here; Core keeps it
 *           |  encrypted and gives it again after a restart.
 * ------------------------------------------------------------------
 */

import type { NodeAction, ProviderStatus } from '@nvx/contracts/controller';
import type { Store } from '../store';
import type { ComputeProvider } from './types';

export class SwitchableProvider implements ComputeProvider {
  constructor(private current: ComputeProvider) {}

  get id(): string {
    return this.current.id;
  }

  /** The provider in use now. */
  get inner(): ComputeProvider {
    return this.current;
  }

  use(next: ComputeProvider): void {
    this.current = next;
  }

  getNode(ref: string, signal?: AbortSignal) {
    return this.current.getNode(ref, signal);
  }

  action(ref: string, action: NodeAction, idempotencyKey: string, signal?: AbortSignal) {
    return this.current.action(ref, action, idempotencyKey, signal);
  }

  get create(): ComputeProvider['create'] {
    return this.current.create?.bind(this.current);
  }

  get serve(): ComputeProvider['serve'] {
    return this.current.serve?.bind(this.current);
  }

  ping(signal?: AbortSignal) {
    return this.current.ping(signal);
  }
}

/**
 * Connect a provider with a key, checked first (sample nodes are cleared once
 * it is accepted), or go back to sample nodes with null.
 */
export function providerSwitch(deps: {
  store: Store;
  provider: SwitchableProvider;
  samples: () => Promise<ComputeProvider>;
  connect: (apiKey: string) => ComputeProvider;
  onConnected?: () => void;
}) {
  return async (apiKey: string | null): Promise<ProviderStatus & { ok: boolean }> => {
    if (!apiKey) {
      deps.provider.use(await deps.samples());
      return { ok: true, kind: 'fake', connected: false, detail: 'Sample nodes: no provider is connected.' };
    }
    const next = deps.connect(apiKey);
    const ping = await next.ping();
    if (!ping.ok)
      return {
        ok: false,
        kind: deps.provider.id,
        connected: deps.provider.id !== 'fake',
        detail: ping.detail,
      };
    for (const n of await deps.store.listNodes())
      if (n.provider === 'fake') await deps.store.deleteNode(n.id);
    deps.provider.use(next);
    deps.onConnected?.();
    return { ok: true, kind: next.id, connected: true, detail: ping.detail };
  };
}
