/**
 * ------------------------------------------------------------------
 *  Title    |  Live test suite (LT1)
 *  Ref      |  docs/testing.md · scripts/test-live.mjs · gateway/e2e-guard.ts
 *  ID       |  tests
 * ------------------------------------------------------------------
 *  Purpose  |  Prove with real models what offline fakes cannot. One
 *           |  chat moves from Claude Haiku to a small open model on a
 *           |  RunPod pod and back, and four things are checked: context
 *           |  carries across models, Haiku's prompt cache is read after
 *           |  switching back, each receipt names the right payer, and
 *           |  the pod is stopped at the end.
 *  How      |  Plain HTTP against Core's API with Playwright's `request`
 *           |  (no browser unless LIVE_SHOTS=1 asks for screenshots). It
 *           |  is Playwright, not vitest, because the e2e suite already
 *           |  runs on it: one toolchain, traces and screenshots on
 *           |  failure, and serial steps with a long timeout and no
 *           |  retries (a retry here would spend money twice). The runner
 *           |  (pnpm test:live) sets the environment below; run on its
 *           |  own the spec refuses to start.
 *  Note     |  LIVE_MODE=live: Core runs with ANCILE_LIVE_ALLOW and a
 *           |  spending cap, the models are Haiku and a Qwen pod.
 *           |  LIVE_MODE=dry: the e2e profile, offline/test for both
 *           |  models and the Controller's fake provider for the node;
 *           |  cache assertions only check "reported or not". Turns pin
 *           |  their model with `model` on the message; in a live run
 *           |  Core gives that model no fallback chain (registry.chain).
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';

/** What the runner passes in. Nothing here is a secret except the Controller token, which is never printed. */
const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === '')
    throw new Error(`${k} is not set. Run this suite with pnpm test:live (or pnpm test:live --dry).`);
  return v;
};

const MODE = env('LIVE_MODE');
const DRY = MODE === 'dry';
const CORE = env('LIVE_CORE_URL').replace(/\/$/, '');
/** Core answers /api/v1 only to its owner: the runner hands over the install key's file, and it is never printed. */
const CORE_KEY = readFileSync(env('LIVE_CORE_KEY_FILE'), 'utf8').trim();
const COCKPIT = process.env.LIVE_COCKPIT_URL;
const CONTROLLER = env('LIVE_CONTROLLER_URL').replace(/\/$/, '');
const CONTROLLER_TOKEN = env('LIVE_CONTROLLER_TOKEN');
const CAP_USD = Number(env('LIVE_CAP_USD', '2'));
const HAIKU = env('LIVE_HAIKU_MODEL');
const POD_MODEL = env('LIVE_POD_MODEL');
const HF_MODEL = env('LIVE_HF_MODEL', 'Qwen/Qwen2.5-1.5B-Instruct');
const SERVED_NAME = env('LIVE_SERVED_NAME', 'qwen2.5-1.5b');
const MAX_POD_USD_HOUR = Number(env('LIVE_MAX_POD_USD_HOUR', '0.60'));
// The node bootstrap serves its status page here when ANCILE_STATUS_PORT is set.
const STATUS_PORT = 8001;
const READY_MINUTES = 10;
const SHOTS = process.env.LIVE_SHOTS === '1';

/** The payer text of a model paid from the plan's monthly API credit (contracts/billing.ts PLAN_CREDIT_PAYER). */
const PLAN_CREDIT_PAYER = "Your plan's monthly API credit";

/**
 * Haiku 4.5 caches nothing under 4,096 tokens (Anthropic prompt caching docs, "Cache limitations":
 * "4,096 tokens for Claude Haiku 4.5"). The padding aims at about twice that, so a rough count that is
 * off by a third still clears it.
 */
const HAIKU_MIN_CACHEABLE_TOKENS = 4_096;
const PADDING_CHARS = HAIKU_MIN_CACHEABLE_TOKENS * 4 * 2;

/**
 * The cheapest GPUs that serve a 1.5B model on vLLM, tried in order, community cloud first
 * (the same list as the RunPod shakedown, services/controller/scripts/live-runpod.ts).
 */
const GPUS = [
  'NVIDIA RTX A4000',
  'NVIDIA RTX A4500',
  'NVIDIA RTX A5000',
  'NVIDIA GeForce RTX 3090',
  'NVIDIA RTX 4000 Ada Generation',
];

const FACT_A = 'marigold-4417';
const FACT_B = 'Quillon-902';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`[live] ${s}`);

/** Reference text for the prefix: stable, plain English, and not worth reading. */
function padding(): string {
  const things = ['harbour', 'ledger', 'lantern', 'orchard', 'compass', 'archive', 'foundry', 'meadow'];
  const verbs = ['was inspected', 'was catalogued', 'was relocated', 'was repaired', 'was measured'];
  let out = '';
  for (let i = 1; out.length < PADDING_CHARS; i++) {
    const t = things[i % things.length];
    const v = verbs[i % verbs.length];
    out += `Entry ${i}: the ${t} on the eastern side ${v} during the third survey, and the surveyors recorded that nothing about it needed further attention that season.\n`;
  }
  return out;
}

interface Receipt {
  id: string;
  status: string;
  model_id: string | null;
  requested_model_id: string | null;
  parts: { type: string; text?: string }[];
  usage: {
    cost_usd: number;
    billed_usd?: number;
    cached_tokens: number;
    cache_write_tokens?: number;
    cache_reported?: boolean;
    input_tokens: number;
    output_tokens: number;
    billing?: { kind: string; payer: string | null };
    calls?: { model_id: string }[];
  } | null;
}

const textOf = (m: Receipt) =>
  m.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');

test.describe.configure({ mode: 'serial', retries: 0 });

test('live: Haiku, a RunPod model, and back', async ({ request }) => {
  test.setTimeout(45 * 60_000);
  say(`${MODE} run. Core ${CORE}. Cap $${CAP_USD}. Haiku: ${HAIKU}. Pod model: ${POD_MODEL}.`);

  const core = async <T>(
    method: string,
    path: string,
    body?: unknown,
    ok = [200, 201, 202, 204],
  ): Promise<T> => {
    const res = await request.fetch(`${CORE}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CORE_KEY}` },
      ...(body !== undefined && { data: body }),
    });
    if (!ok.includes(res.status()))
      throw new Error(`${method} ${path} answered ${res.status()}: ${(await res.text()).slice(0, 400)}`);
    return (res.status() === 204 ? undefined : await res.json()) as T;
  };

  const controller = async <T>(method: string, path: string, body?: unknown, ok = [200, 201, 202, 204]) => {
    const res = await request.fetch(`${CONTROLLER}/control/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${CONTROLLER_TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { data: body }),
    });
    if (!ok.includes(res.status()))
      throw new Error(
        `Controller ${method} ${path} answered ${res.status()}: ${(await res.text()).slice(0, 400)}`,
      );
    return (res.status() === 204 ? undefined : await res.json()) as T;
  };

  interface Node {
    id: string;
    observed_state: string;
    healthy: boolean;
    hourly_rate: number;
    provider: string;
    provider_ref: string;
  }
  const nodeNow = async (id: string): Promise<Node | undefined> =>
    (await controller<{ items: Node[] }>('GET', '/nodes')).items.find((n) => n.id === id);

  let notebookId: string | null = null;
  let threadId: string | null = null;
  let nodeId: string | null = null;
  let ruleId: string | null = null;
  let podStartedAt = 0;
  let podRate = 0;
  let podEnded = false;
  const spent: { turn: string; usd: number }[] = [];

  let failure: unknown = null;
  try {
    // 1. A throwaway notebook and a thread in it.
    const notebook = await core<{ id: string }>('POST', '/notebooks', {
      title: 'Live tests (safe to delete)',
      description: 'Made by pnpm test:live. It goes to the Trash when the run ends.',
    });
    notebookId = notebook.id;
    const thread = await core<{ id: string }>('POST', '/threads', {
      title: 'Live test: Haiku, a pod model, and back',
      notebook_id: notebookId,
    });
    threadId = thread.id;
    say(`Notebook ${notebookId}, thread ${threadId}.`);

    // Who pays for Haiku: the key, or the plan's monthly credit when the key is marked as such (CR1).
    const credit = await core<{ enabled: boolean }>('GET', '/providers/anthropic/credit');
    const haikuBilling = DRY
      ? { kind: 'none', payer: null }
      : credit.enabled
        ? { kind: 'credit', payer: PLAN_CREDIT_PAYER }
        : { kind: 'key', payer: 'anthropic' };
    const podBilling = DRY ? { kind: 'none', payer: null } : { kind: 'rented', payer: null };

    // 2. The pod: create it through the Controller, start it, wait for it (at most 10 minutes).
    //    A node that was already there is never touched.
    say(`Creating a node for ${HF_MODEL} on vLLM (the cheapest GPU with room).`);
    let created: { operation_id: string; node_id: string } | null = null;
    outer: for (const cloud of ['community', 'secure'] as const) {
      for (const gpu of GPUS) {
        const res = await request.fetch(`${CONTROLLER}/control/v1/nodes/create`, {
          method: 'POST',
          headers: { authorization: `Bearer ${CONTROLLER_TOKEN}`, 'content-type': 'application/json' },
          data: {
            name: `ancile-live-test-${new Date().toISOString().slice(0, 16)}`,
            idempotency_key: `live-${randomUUID()}`,
            served_models: [SERVED_NAME],
            reason: 'pnpm test:live',
            spec: {
              gpu_type_id: gpu,
              gpu_count: 1,
              cloud,
              image: 'vllm/vllm-openai:v0.11.0',
              // The node bootstrap serves the model under SERVED_NAME so node/<SERVED_NAME> resolves.
              entrypoint: [
                'bash',
                '-c',
                "(curl -fsSL https://raw.githubusercontent.com/Envxsion/nvx_ancile/main/infra/node/bootstrap.sh || python3 -c 'import sys,urllib.request; sys.stdout.write(urllib.request.urlopen(sys.argv[1]).read().decode())' https://raw.githubusercontent.com/Envxsion/nvx_ancile/main/infra/node/bootstrap.sh) | bash",
              ],
              env: {
                ANCILE_MODEL: HF_MODEL,
                ANCILE_SERVED_NAME: SERVED_NAME,
                // The prefix is about 8,000 tokens and the thread carries all of it to the pod.
                ANCILE_VLLM_ARGS: '--max-model-len 16384',
                // The node's status page (its own log, the node key taken out), read if a turn fails.
                ANCILE_STATUS_PORT: String(STATUS_PORT),
              },
              container_disk_gb: 30,
              volume_gb: 10,
              ports: ['8000/http', `${STATUS_PORT}/http`],
            },
          },
        });
        if (res.status() === 202) {
          created = (await res.json()) as { operation_id: string; node_id: string };
          say(`Created on ${gpu} (${cloud}).`);
          break outer;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; hint?: string } };
        if (body.error?.code === 'provider.capacity_unavailable') {
          say(`No ${cloud} ${gpu} free right now.`);
          continue;
        }
        throw new Error(
          `Creating the node failed (${res.status()} ${body.error?.code ?? ''}): ${body.error?.hint ?? ''}`,
        );
      }
    }
    if (!created) throw new Error('RunPod had none of the listed GPUs free. Try again later.');
    nodeId = created.node_id;
    podStartedAt = Date.now();

    // The idle stop is a backstop: if this run dies before cleaning up, the Controller stops the node.
    const rule = await controller<{ id: string }>('POST', '/rules', {
      kind: 'idle_timeout',
      enabled: true,
      config: { node_ids: [nodeId], idle_minutes: 30 },
    });
    ruleId = rule.id;

    const deadline = Date.now() + READY_MINUTES * 60_000;
    let last = '';
    for (;;) {
      const n = await nodeNow(nodeId);
      if (n) {
        podRate = n.hourly_rate || podRate;
        if (podRate > MAX_POD_USD_HOUR && !DRY)
          throw new Error(
            `The node costs $${podRate}/h, over the $${MAX_POD_USD_HOUR}/h limit. It will be terminated.`,
          );
        if (n.observed_state !== last) {
          last = n.observed_state;
          say(`Node is ${last}.`);
        }
        if (n.observed_state === 'error') throw new Error('RunPod reports the node in error.');
        if (n.observed_state === 'running' && n.healthy) break;
      }
      if (Date.now() > deadline)
        throw new Error(
          `The node was not ready after ${READY_MINUTES} minutes (last state: ${last || 'unknown'}). It will be terminated.`,
        );
      await sleep(10_000);
    }
    // Core learns of the node's model from the Controller; wait until it can be chosen.
    for (;;) {
      const models = await core<{ items: { id: string; status?: string }[] }>('GET', '/models');
      if (models.items.some((m) => m.id === POD_MODEL && (m.status === 'ready' || m.status === undefined)))
        break;
      if (Date.now() > deadline)
        throw new Error(`Core does not list ${POD_MODEL} as ready after ${READY_MINUTES} minutes.`);
      await sleep(5_000);
    }
    say(`Node ready after ${((Date.now() - podStartedAt) / 60_000).toFixed(1)} min.`);

    // One turn: send it pinned to a model, wait for the run, and read the answer's receipt.
    let head: string | null = null;
    const turn = async (label: string, model: string, text: string, waitMinutes = 6): Promise<Receipt> => {
      const sent = await core<{ run_id: string; assistant_message_id: string }>(
        'POST',
        `/threads/${threadId}/messages`,
        { parent_id: head, parts: [{ type: 'text', text }], model },
      );
      const end = Date.now() + waitMinutes * 60_000;
      for (;;) {
        const run = await core<{ status: string; error?: unknown }>('GET', `/runs/${sent.run_id}`);
        if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          if (run.status !== 'succeeded')
            throw new Error(
              `${label}: the run ${run.status}: ${JSON.stringify(run.error ?? null).slice(0, 400)}`,
            );
          break;
        }
        if (Date.now() > end) throw new Error(`${label}: no answer after ${waitMinutes} minutes.`);
        await sleep(1_500);
      }
      const path = await core<{ messages: Receipt[] }>('GET', `/threads/${threadId}/path`);
      const msg = path.messages.find((m) => m.id === sent.assistant_message_id);
      if (!msg) throw new Error(`${label}: the answer is not on the thread.`);
      head = msg.id;
      const usd = msg.usage ? (msg.usage.billed_usd ?? msg.usage.cost_usd) : 0;
      spent.push({ turn: label, usd });
      say(
        `${label}: ${model} said "${textOf(msg).slice(0, 80).replace(/\s+/g, ' ')}" ($${usd.toFixed(4)}, cached ${msg.usage?.cached_tokens ?? 0}).`,
      );
      return msg;
    };

    /** The model that answered is the one asked for, with no fallback, and the payer is right. */
    const checkReceipt = (
      label: string,
      m: Receipt,
      model: string,
      billing: { kind: string; payer: string | null },
    ) => {
      expect(m.status, `${label}: status`).toBe('complete');
      expect(m.requested_model_id, `${label}: requested model`).toBe(model);
      expect(m.model_id, `${label}: the model that answered`).toBe(model);
      expect(
        m.parts.filter((p) => p.type === 'seam'),
        `${label}: a fallback model continued the answer`,
      ).toEqual([]);
      expect(m.usage, `${label}: usage`).not.toBeNull();
      for (const c of m.usage?.calls ?? [])
        expect(c.model_id, `${label}: a call went to another model`).toBe(model);
      expect(m.usage?.billing, `${label}: who paid`).toEqual(billing);
    };

    // 3. Turn 1, Haiku: the long stable prefix and fact A. The reply is asked to be tiny.
    const prefix = `Reference material follows. It is only padding for a caching test: do not summarise it.\n\n${padding()}\n--- end of reference material ---\n\n`;
    const t1 = await turn(
      'turn 1 (Haiku)',
      HAIKU,
      `${prefix}Fact A: the access word is ${FACT_A}. Reply with the single word: noted.`,
    );
    checkReceipt('turn 1', t1, HAIKU, haikuBilling);

    // 4. Turn 2, the pod model: it must know fact A, which proves the context crossed over.
    const t2 = await turn(
      'turn 2 (pod model)',
      POD_MODEL,
      `What was the access word in fact A? Answer with only that word. Also keep in mind fact B: the harbour is called ${FACT_B}.`,
      // A new pod's first answer waits for the model server to load (often 5 to 10 minutes).
      14,
    );
    checkReceipt('turn 2', t2, POD_MODEL, podBilling);
    if (DRY)
      say('Dry run: the offline model cannot show that context carried over, so that check is skipped.');
    else
      expect(textOf(t2).toLowerCase(), 'the pod model did not know fact A').toContain(FACT_A.toLowerCase());

    // 5. Turn 3, Haiku again: it must know fact B, and its cache must be read.
    const t3 = await turn(
      'turn 3 (Haiku)',
      HAIKU,
      'What was fact B, the harbour name? Answer with only that name.',
    );
    checkReceipt('turn 3', t3, HAIKU, haikuBilling);
    if (!DRY) expect(textOf(t3), 'Haiku did not know fact B').toContain(FACT_B);
    if (DRY) {
      expect(typeof (t3.usage?.cache_reported ?? false), 'cache_reported is reported or not').toBe('boolean');
    } else {
      expect(t3.usage?.cache_reported, 'turn 3: Anthropic reported cache figures').toBe(true);
      expect(t3.usage?.cached_tokens ?? 0, 'turn 3: tokens read from the cache').toBeGreaterThan(0);
      expect(t3.usage?.cached_tokens ?? 0, 'turn 3: more than a stray few tokens').toBeGreaterThanOrEqual(
        HAIKU_MIN_CACHEABLE_TOKENS,
      );
    }
    const state = await core<{
      items: { model_id: string; warm_until: string | null; prefix_tokens: number; reported: boolean }[];
    }>('GET', `/threads/${threadId}/cache-state`);
    const haikuState = state.items.find((i) => i.model_id === HAIKU);
    expect(haikuState, 'cache-state lists the Haiku model').toBeTruthy();
    if (DRY) {
      expect(typeof haikuState?.reported).toBe('boolean');
    } else {
      expect(haikuState?.reported, 'cache-state: Anthropic reports its cache').toBe(true);
      expect(haikuState?.warm_until, 'cache-state: warm mark').not.toBeNull();
      expect(new Date(haikuState?.warm_until ?? 0).getTime(), 'cache-state: still warm').toBeGreaterThan(
        Date.now(),
      );
      expect(haikuState?.prefix_tokens ?? 0, 'cache-state: prefix tokens').toBeGreaterThan(0);
    }

    // 6. Turn 4, Haiku once more: the cache is read again.
    const t4 = await turn(
      'turn 4 (Haiku)',
      HAIKU,
      'Repeat fact A and fact B, separated by a comma, and nothing else.',
    );
    checkReceipt('turn 4', t4, HAIKU, haikuBilling);
    if (!DRY) {
      expect(textOf(t4), 'Haiku lost fact A').toContain(FACT_A);
      expect(textOf(t4), 'Haiku lost fact B').toContain(FACT_B);
      expect(t4.usage?.cached_tokens ?? 0, 'turn 4: tokens read from the cache').toBeGreaterThan(0);
    }

    // 7. The bill: under the cap, and Core's own count agrees there was no stray spending.
    const total = spent.reduce((a, s) => a + s.usd, 0);
    say(`Billed in the four answers: $${total.toFixed(4)} of $${CAP_USD}.`);
    expect(total, 'total billed by the answers').toBeLessThan(CAP_USD);

    if (SHOTS && COCKPIT) {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        // Connect this browser first: a one-time code from Core, spent by the pairing address, then on to the thread.
        const minted = await core<{ code: string }>('POST', '/session/pair-codes', undefined, [201]);
        await page.goto(
          `${COCKPIT.replace(/\/$/, '')}/api/v1/session/pair?code=${minted.code}&next=${encodeURIComponent(`/t/${threadId}`)}`,
        );
        await page.waitForTimeout(2_000);
        await page.screenshot({ path: 'test-results/live/thread.png', fullPage: true });
      } finally {
        await browser.close();
      }
    }
  } catch (e) {
    failure = e;
  }
  {
    // Whatever happened above, the pod is stopped and the notebook goes to the Trash.
    const failures: string[] = [];
    if (failure && nodeId && !DRY) await nodeStatus(nodeId);
    if (nodeId) {
      try {
        await endPod(nodeId);
        podEnded = true;
      } catch (e) {
        failures.push(
          `THE NODE ${nodeId} MAY STILL BE RUNNING: ${(e as Error).message} Stop it in Admin → Compute or the RunPod console now.`,
        );
      }
    }
    if (ruleId) await controller('DELETE', `/rules/${ruleId}`).catch(() => undefined);
    if (threadId)
      await core('DELETE', `/threads/${threadId}`).catch((e) =>
        say(`Could not trash the thread: ${e.message}`),
      );
    if (notebookId) {
      await core('DELETE', `/notebooks/${notebookId}`).catch((e) =>
        failures.push(`Could not trash the notebook: ${e.message}`),
      );
    }
    if (podStartedAt) {
      const hours = (Date.now() - podStartedAt) / 3_600_000;
      say(
        `Node time ${(hours * 60).toFixed(1)} min, about $${(hours * podRate).toFixed(3)} at $${podRate}/h (not part of the answers' bill).`,
      );
    }
    for (const f of failures) console.error(`[live] ${f}`);
    if (failure) throw failure;
    if (failures.length) throw new Error(failures.join('\n'));
    if (nodeId) expect(podEnded, 'the node was stopped at the end').toBe(true);
  }

  /** After a failure, the node's own status page: what its setup script and vLLM said. */
  async function nodeStatus(id: string): Promise<void> {
    try {
      const ref = (await nodeNow(id))?.provider_ref;
      if (!ref) return;
      const res = await request.fetch(`https://${ref}-${STATUS_PORT}.proxy.runpod.net/index.txt`, {
        timeout: 20_000,
      });
      const text = res.ok() ? await res.text() : `(the status page answered ${res.status()})`;
      mkdirSync('test-results/live', { recursive: true });
      writeFileSync('test-results/live/node-status.txt', text);
      console.error(
        `[live] The node's status page, last 40 lines:\n${text.split('\n').slice(-40).join('\n')}`,
      );
    } catch (e) {
      say(`Could not read the node's status page: ${(e as Error).message}`);
    }
  }

  /** Terminate the node (it stops billing for compute and storage), and wait until the Controller agrees. */
  async function endPod(id: string): Promise<void> {
    say(`Ending node ${id}.`);
    const give = Date.now() + 3 * 60_000;
    let asked = false;
    for (;;) {
      const n = await nodeNow(id);
      if (!n || ['terminated', 'stopped'].includes(n.observed_state)) {
        say(`Node is ${n?.observed_state ?? 'gone'}.`);
        return;
      }
      if (!asked || Date.now() > give - 60_000) {
        // A creation still in progress refuses actions for a moment: ask again until it takes.
        const res = await request.fetch(`${CONTROLLER}/control/v1/nodes/${encodeURIComponent(id)}/actions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${CONTROLLER_TOKEN}`, 'content-type': 'application/json' },
          data: {
            action: 'terminate',
            idempotency_key: `live-end-${randomUUID()}`,
            reason: 'pnpm test:live finished',
          },
        });
        asked = asked || res.status() === 202;
      }
      if (Date.now() > give) throw new Error(`It is still ${n.observed_state} after 3 minutes.`);
      await sleep(5_000);
    }
  }
});
