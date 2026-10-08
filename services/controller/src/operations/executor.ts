/**
 * ------------------------------------------------------------------
 *  Title    |  Operation executor
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Drive one operation through the confirmation chain
 *           |  against a real provider: ask, record the provider's
 *           |  acknowledgement, poll until the node reaches the target
 *           |  state, confirm. Every step is persisted and streamed.
 *  How      |  machine.ts decides transitions; this file only does I/O.
 *           |  Transient provider errors on the action are retried with
 *           |  backoff before the operation is failed.
 *  Note     |  Usage intervals open and close on confirmed running /
 *           |  stopped, which is what cost tracking is computed from.
 * ------------------------------------------------------------------
 */

import type { NodeAction, Operation } from '@nvx/contracts/controller';
import { componentLogger } from '../logger';
import { type ComputeProvider, ProviderError } from '../providers/types';
import type { NodeRecord, Store } from '../store';
import { advance, checkTimeout, type DEFAULT_BUDGETS_MS, isTerminal, targetState } from './machine';

export interface ExecutorDeps {
  store: Store;
  provider: ComputeProvider;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  budgets?: typeof DEFAULT_BUDGETS_MS;
  maxActionAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runOperation(
  opId: string,
  idempotencyKey: string,
  deps: ExecutorDeps,
): Promise<Operation> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 3_000;
  const { store, provider } = deps;
  let op = await store.getOperation(opId);
  if (!op) throw new Error(`operation ${opId} not found`);
  const log = componentLogger('executor', op.trace_id);
  const node = await store.getNode(op.node_id);
  if (!node) {
    op = advance(op, 'failed', 'Node not found', now(), {
      code: 'node_unknown',
      provider_message: 'This node is not registered with the Controller.',
      suggestion: 'Refresh the node list; it may have been removed.',
    });
    await store.putOperation(op);
    return op;
  }
  const action = op.action as NodeAction;
  const save = async (next: Operation) => {
    op = next;
    await store.putOperation(op);
  };

  // 1. Ask the provider, retrying transient failures. An operation resumed
  // after a restart that the provider already acknowledged skips this.
  const attempts = deps.maxActionAttempts ?? 3;
  const asked = op.status === 'acknowledged' || op.status === 'in_progress';
  for (let i = 1; !asked; i++) {
    try {
      const ack = await provider.action(node.provider_ref, action, idempotencyKey);
      await save(advance(op, 'acknowledged', ack.detail, now()));
      // The provider took the request: that is now what the node should be.
      const fresh = (await store.getNode(node.id)) ?? node;
      await store.putNode({ ...fresh, desired_state: targetState(action) });
      break;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable && i < attempts) {
        await save(
          advance(op, op.status, `${err.error.provider_message}. Retrying (${i}/${attempts - 1})…`, now()),
        );
        await sleep(Math.min(8_000, 500 * 2 ** (i - 1)));
        continue;
      }
      const error =
        err instanceof ProviderError
          ? err.error
          : {
              code: 'internal',
              provider_message: String(err),
              suggestion: 'Check the Controller logs for this trace id.',
            };
      log.warn({ err: error }, 'provider rejected action');
      await save(advance(op, 'failed', `The provider did not accept ${action}.`, now(), error));
      return op;
    }
  }

  // 2. Watch until the node reaches the target state.
  if (op.status !== 'in_progress')
    await save(advance(op, 'in_progress', `Waiting for the node to become ${targetState(action)}.`, now()));
  const want = targetState(action);
  let lastState = node.observed_state;
  while (!isTerminal(op.status)) {
    const timed = checkTimeout(op, now(), deps.budgets);
    if (timed !== op) {
      await save(timed);
      break;
    }
    try {
      const seen = await provider.getNode(node.provider_ref);
      if (seen.state !== lastState) {
        lastState = seen.state;
        await updateNode(store, node, seen.state, seen.endpointUrl, seen.hourlyRate, now());
        if (seen.state !== want) await save(advance(op, 'in_progress', `Node is ${seen.state}.`, now()));
      }
      if (seen.state === want) {
        await save(advance(op, 'confirmed', `Confirmed: the provider reports the node ${want}.`, now()));
        break;
      }
      if (seen.state === 'error') {
        await save(
          advance(op, 'failed', 'The node entered an error state.', now(), {
            code: 'node_error',
            provider_message: 'The provider reports the node in an error state.',
            suggestion:
              'Open the node in the provider console for its logs; restarting usually clears a failed start.',
          }),
        );
        break;
      }
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) {
        await save(advance(op, 'failed', 'Could not read the node state.', now(), err.error));
        break;
      }
      // transient read failure: keep polling until the state budget runs out
    }
    await sleep(pollMs);
  }
  return op;
}

async function updateNode(
  store: Store,
  node: NodeRecord,
  state: NodeRecord['observed_state'],
  endpointUrl: string | null,
  hourlyRate: number | null,
  at: Date,
) {
  const fresh = (await store.getNode(node.id)) ?? node;
  const next: NodeRecord = {
    ...fresh,
    observed_state: state,
    endpoint_url: endpointUrl,
    hourly_rate: hourlyRate ?? fresh.hourly_rate,
    healthy: state === 'running',
    runningSince: state === 'running' ? (fresh.runningSince ?? at) : null,
    terminatedAt: state === 'terminated' ? at : fresh.terminatedAt,
  };
  await store.putNode(next);
  if (state === 'running') await store.openInterval(node.id, at, next.hourly_rate);
  if (state === 'stopped' || state === 'terminated' || state === 'error')
    await store.closeInterval(node.id, at);
}

/**
 * After a restart, pick up every operation that was still live: an
 * operation nobody watches never confirms or times out, and it blocks every
 * later action on its node ("Another operation on this node has not
 * finished"). Acknowledged ones go back to watching; one that was only
 * requested is asked again (start and stop are idempotent at the provider).
 */
export async function recoverOperations(deps: ExecutorDeps): Promise<number> {
  let resumed = 0;
  for (const node of await deps.store.listNodes()) {
    const op = await deps.store.liveOperationFor(node.id);
    if (!op || isTerminal(op.status)) continue;
    const log = componentLogger('executor', op.trace_id);
    log.info({ operation_id: op.id, status: op.status }, 'resuming an operation interrupted by a restart');
    void runOperation(op.id, `resume:${op.id}`, deps).catch((err) =>
      log.error({ err }, 'resumed executor crashed'),
    );
    resumed++;
  }
  return resumed;
}
