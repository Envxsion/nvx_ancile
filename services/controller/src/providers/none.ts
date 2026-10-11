/**
 * ------------------------------------------------------------------
 *  Title    |  No provider yet
 *  Ref      |  docs/compute.md (Connecting RunPod)
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  What the Controller manages before RunPod is connected:
 *           |  nothing. No sample nodes or invented costs in a real
 *           |  install; those are only for CONTROLLER_PROVIDER=fake.
 *  How      |  Every node call says how to connect a provider.
 * ------------------------------------------------------------------
 */

import { type ComputeProvider, ProviderError } from './types';

const notConnected = () =>
  new ProviderError(
    {
      code: 'not_connected',
      provider_message: 'No GPU provider is connected.',
      suggestion: 'Connect RunPod in Admin → Compute, then try again.',
    },
    null,
    false,
  );

export class NoProvider implements ComputeProvider {
  readonly id = 'none';

  async getNode(): Promise<never> {
    throw notConnected();
  }

  async action(): Promise<never> {
    throw notConnected();
  }

  async ping() {
    return { ok: false, detail: 'No GPU provider is connected. Connect RunPod in Admin → Compute.' };
  }
}
