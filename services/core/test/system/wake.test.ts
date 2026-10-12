/**
 * Laptop sleep mid-run (ROADMAP.md track G), on a fake clock: the wake is
 * noticed, the run the worker holds carries on (not restarted), a run whose
 * worker is gone is picked up, and the Claude bridge socket reconnects.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { BridgeClient, type BridgeLauncher } from '../../src/claudecode/bridge';
import type { RunHandler } from '../../src/runs/engine';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { RunWorker } from '../../src/runs/worker';
import { WakeWatch } from '../../src/system/wake';

const T = Date.parse('2026-10-12T09:00:00Z');
const MIN = 60_000;

const until = async (check: () => Promise<boolean> | boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('noticing a wake', () => {
  it('calls back only when a beat comes far too late, with the gap', async () => {
    let now = T;
    const watch = new WakeWatch({ now: () => now, setInterval: () => 1, clearInterval: () => undefined });
    const gaps: number[] = [];
    watch.onWake((g) => {
      gaps.push(g);
    });
    watch.onWake(() => {
      throw new Error('one listener failing does not stop the others');
    });
    watch.onWake((g) => {
      gaps.push(-g);
    });
    watch.start();
    now += 5_000;
    expect(await watch.beat()).toBeNull();
    now += 20_000; // a slow beat, not a sleep
    expect(await watch.beat()).toBeNull();
    now += 45 * MIN;
    expect(await watch.beat()).toBe(45 * MIN);
    expect(gaps).toEqual([45 * MIN, -45 * MIN]);
    watch.stop();
  });
});

describe('durable runs after a sleep', () => {
  function setup(handler: RunHandler) {
    let now = T;
    const clock = { now: () => now, advance: (ms: number) => (now += ms) };
    const store = new MemoryRunStore();
    store.now = clock.now;
    const worker = new RunWorker({
      store,
      events: new MemoryRunEventLog(),
      handlers: { agent: handler },
      pollMs: 10,
      sweepMs: 60_000,
      leaseMs: 1_000,
      now: clock.now,
    });
    const watch = new WakeWatch({ now: clock.now, setInterval: () => 1, clearInterval: () => undefined });
    watch.onWake(() => worker.wake());
    return { store, worker, watch, clock };
  }
  const newRun = (store: MemoryRunStore, id: string) =>
    store.create({
      id,
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: {},
    });

  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('carry on where they were, under the same worker, when the computer wakes', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let starts = 0;
    const { store, worker, watch, clock } = setup({
      async execute() {
        starts++;
        await gate;
        return { kind: 'done' };
      },
    });
    stop = () => worker.stop();
    await newRun(store, 'run_sleep');
    await worker.start();
    watch.start();
    await until(async () => (await store.get('run_sleep'))?.status === 'running');

    clock.advance(40 * MIN); // the lid closes; the lease lapses while asleep
    expect(await watch.beat()).toBe(40 * MIN);

    const run = await store.get('run_sleep');
    expect(run).toMatchObject({ status: 'running', leaseOwner: worker.owner, attempt: 0 });
    expect(run?.leaseUntil).toBe(clock.now() + 1_000);
    expect(worker.isExecuting('run_sleep')).toBe(true);

    release();
    await until(async () => (await store.get('run_sleep'))?.status === 'succeeded');
    expect(starts).toBe(1);
    expect((await store.get('run_sleep'))?.attempt).toBe(0);
  });

  it('keep their run when the sweeper beats first after the sleep', async () => {
    const { store, worker, clock } = setup({ execute: () => new Promise(() => undefined) });
    stop = () => worker.stop();
    await newRun(store, 'run_sweep');
    await worker.start();
    await until(async () => (await store.get('run_sweep'))?.status === 'running');
    clock.advance(40 * MIN);
    await worker.sweepTick();
    expect(await store.get('run_sweep')).toMatchObject({
      status: 'running',
      leaseOwner: worker.owner,
      attempt: 0,
    });
  });

  it('pick up a run whose worker did not come back', async () => {
    const { store, worker, watch, clock } = setup({ execute: async () => ({ kind: 'done' }) });
    stop = () => worker.stop();
    await newRun(store, 'run_orphan');
    await store.claim('core-gone', 1_000); // another Core held it, then vanished
    await worker.start();
    watch.start();
    clock.advance(40 * MIN);
    await watch.beat();
    await until(async () => (await store.get('run_orphan'))?.status === 'succeeded');
    expect((await store.get('run_orphan'))?.attempt).toBe(1);
  });
});

describe('the Claude bridge after a sleep', () => {
  /** A bridge that answers until told to hang, like a socket left half-open by a sleep. */
  function hangingBridge() {
    const state = { launches: 0, hang: false, servers: [] as WebSocketServer[] };
    const launch: BridgeLauncher = async () => {
      state.launches++;
      const token = `tok-${state.launches}-${'x'.repeat(24)}`;
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      state.servers.push(wss);
      await new Promise<void>((r) => wss.once('listening', () => r()));
      const mine = state.launches;
      wss.on('connection', (ws) =>
        ws.on('message', (raw) => {
          const req = JSON.parse(String(raw)) as { id: number; op: string; params?: { protocol?: number } };
          if (state.hang && mine === 1) return;
          const result =
            req.op === 'hello'
              ? {
                  protocol: Number(req.params?.protocol ?? 1),
                  sdk: { ready: true, version: 'x', error: null },
                }
              : { ready: true, version: 'x', error: null };
          ws.send(JSON.stringify({ id: req.id, ok: true, result }));
        }),
      );
      let exit: () => void = () => undefined;
      const exited = new Promise<void>((r) => {
        exit = r;
      });
      return {
        url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        token,
        exited,
        stop: () => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          exit();
        },
      };
    };
    return { state, launch };
  }

  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const f of cleanup) f();
    cleanup = [];
  });

  it('keeps a socket that still answers', async () => {
    const { state, launch } = hangingBridge();
    const client = new BridgeClient({ launch });
    cleanup.push(
      () => client.stop(),
      () => {
        for (const s of state.servers) s.close();
      },
    );
    await client.sdkStatus();
    expect(await client.wake(500)).toBe('ok');
    expect(state.launches).toBe(1);
  });

  it('reconnects a socket that stopped answering while live sessions are open', async () => {
    const { state, launch } = hangingBridge();
    const client = new BridgeClient({ launch });
    cleanup.push(
      () => client.stop(),
      () => {
        for (const s of state.servers) s.close();
      },
    );
    client.setKeepAlive(() => true);
    const closed: string[] = [];
    client.onEvent((e) => closed.push(e.event));
    await client.sdkStatus();
    state.hang = true;
    expect(await client.wake(200)).toBe('reconnected');
    expect(state.launches).toBe(2);
    expect(closed).toContain('bridge.closed');
    expect(client.running).toBe(true);
    expect((await client.sdkStatus()).ready).toBe(true);
  });

  it('leaves an idle bridge stopped, ready to start on the next request', async () => {
    const { state, launch } = hangingBridge();
    const client = new BridgeClient({ launch });
    cleanup.push(
      () => client.stop(),
      () => {
        for (const s of state.servers) s.close();
      },
    );
    await client.sdkStatus();
    state.hang = true;
    expect(await client.wake(200)).toBe('idle');
    expect(client.running).toBe(false);
    state.hang = false;
    expect((await client.sdkStatus()).ready).toBe(true);
    expect(state.launches).toBe(2);
  });
});
