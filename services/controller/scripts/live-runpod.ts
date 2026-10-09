/**
 * ------------------------------------------------------------------
 *  Title    |  Live RunPod shakedown
 *  Ref      |  docs/compute.md (Testing against RunPod)
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Prove the RunPod adapter against the real API before a
 *           |  release: the key, listing, and (with --create) a whole
 *           |  pod life: create, run, answer, stop, start, terminate.
 *  How      |  pnpm test:runpod              free: key and listing only
 *           |  pnpm test:runpod --create     spends a little money
 *           |  pnpm test:runpod --create --bootstrap   the same, through
 *           |    infra/node/bootstrap.sh from the repo's main branch
 *           |  Options: --gpu "NVIDIA RTX A4000" --secure --region ID
 *           |  --model HF_ID --max-usd-hour 0.40 --max-minutes 30 --keep
 *  Note     |  The pod it creates is terminated on every way out
 *           |  (success, failure, Ctrl+C, the time cap), unless --keep,
 *           |  which stops it instead so you can add it in the app.
 *           |  The key comes from RUNPOD_API_KEY or .env, never printed.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapPod, RunPodProvider } from '../src/providers/runpod';
import type { ProviderNode } from '../src/providers/types';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function fromDotEnv(key: string): string | undefined {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return undefined;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m?.[1] === key) return m[2]?.replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}

const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
};

const apiKey = process.env.RUNPOD_API_KEY || fromDotEnv('RUNPOD_API_KEY') || '';
const baseUrl = process.env.RUNPOD_API_BASE || fromDotEnv('RUNPOD_API_BASE') || 'https://api.runpod.io';
const gpu = opt('gpu', 'NVIDIA RTX A4000');
const cloud = flag('secure') ? 'secure' : 'community';
const region = opt('region', '');
const model = opt('model', 'Qwen/Qwen2.5-0.5B-Instruct');
const served = 'shakedown';
const bootstrap = flag('bootstrap');
const scriptsUrl = opt(
  'scripts-url',
  'https://raw.githubusercontent.com/Envxsion/nvx_ancile/main/infra/node',
);
// The bootstrap makes vLLM require a key; a throwaway one for this pod only.
const nodeKey = bootstrap ? randomUUID() : '';
const nodeAuth: Record<string, string> = nodeKey ? { authorization: `Bearer ${nodeKey}` } : {};
const maxRate = Number(opt('max-usd-hour', '0.40'));
const maxMinutes = Number(opt('max-minutes', flag('bootstrap') ? '50' : '30'));

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`;
const say = (s: string) => console.log(`[${elapsed()}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const record = (step: string, ok: boolean, note = '') => {
  results.push({ step, ok, note });
  say(`${ok ? 'PASS' : 'FAIL'}  ${step}${note ? `: ${note}` : ''}`);
};

const rp = new RunPodProvider({ apiKey, baseUrl, timeoutMs: 30_000 });
let podId: string | null = null;
let rate: number | null = null;
let cleaning = false;

async function until(
  what: string,
  check: () => Promise<boolean>,
  minutes: number,
  every = 10_000,
): Promise<boolean> {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    if (Date.now() - t0 > maxMinutes * 60_000) throw new Error(`the ${maxMinutes}-minute cap was reached`);
    try {
      if (await check()) return true;
    } catch (err) {
      say(`  still waiting for ${what} (${err instanceof Error ? err.message : String(err)})`);
    }
    await sleep(every);
  }
  return false;
}

async function waitState(want: ProviderNode['state'], minutes: number) {
  let last = '';
  return until(
    `the pod to be ${want}`,
    async () => {
      const n = await rp.getNode(podId ?? '');
      if (n.hourlyRate) rate = n.hourlyRate;
      if (n.state !== last) {
        last = n.state;
        say(`  pod is ${last}`);
      }
      if (n.state === 'error') throw new Error('RunPod reports the pod in ERROR');
      return n.state === want;
    },
    minutes,
  );
}

async function modelAnswers(minutes: number) {
  const url = `https://${podId}-8000.proxy.runpod.net/v1`;
  const up = await until(
    'vLLM to load the model',
    async () => {
      const r = await fetch(`${url}/models`, { headers: nodeAuth, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return false;
      const body = (await r.json()) as { data?: { id: string }[] };
      return Boolean(body.data?.some((m) => m.id === served));
    },
    minutes,
    15_000,
  );
  if (!up) return { ok: false, note: `/v1/models did not list "${served}" in ${minutes} min` };
  const r = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...nodeAuth },
    body: JSON.stringify({
      model: served,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 8,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) return { ok: false, note: `chat completion answered HTTP ${r.status}` };
  const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content?.trim() ?? '';
  return { ok: text.length > 0, note: `the model said "${text.slice(0, 40)}"` };
}

async function cleanUp() {
  if (!podId || cleaning) return;
  cleaning = true;
  if (flag('keep')) {
    say(`Stopping pod ${podId} (--keep): add it in Admin → Compute, and terminate it in RunPod when done.`);
    await rp
      .action(podId, 'stop', `shake-stop-${randomUUID()}`)
      .catch((e) => say(`  stop failed: ${e.message}`));
    return;
  }
  say(`Terminating pod ${podId}.`);
  try {
    await rp.action(podId, 'terminate', `shake-term-${randomUUID()}`);
    const gone = await until(
      'the pod to be gone',
      async () => {
        try {
          return (await rp.getNode(podId ?? '')).state === 'terminated';
        } catch (e) {
          return (e as { status?: number }).status === 404;
        }
      },
      3,
      5_000,
    ).catch(() => false);
    record('terminate', gone, gone ? 'RunPod no longer has the pod' : 'not confirmed: check RunPod now');
  } catch (e) {
    record('terminate', false, `${(e as Error).message}. TERMINATE POD ${podId} IN THE RUNPOD CONSOLE NOW.`);
  }
}

process.on('SIGINT', () => {
  say('Interrupted.');
  void cleanUp().finally(() => process.exit(130));
});

async function main() {
  if (!apiKey) {
    console.error(
      'No RunPod key. Put RUNPOD_API_KEY in .env (pod read/write scope), or set it for this command.',
    );
    process.exit(2);
  }
  say(`RunPod at ${baseUrl}, key ${apiKey.length} characters (not shown).`);

  // 1. Free checks: the key, and the shape of the pod list.
  const ping = await rp.ping();
  record('key accepted', ping.ok, ping.ok ? '' : ping.detail);
  if (!ping.ok) return;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v2/pods`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const list = (await res.json().catch(() => null)) as { pods?: Record<string, unknown>[] } | null;
  const shaped = res.ok && Array.isArray(list?.pods);
  record(
    'list pods (v2 {pods:[…]})',
    shaped,
    shaped ? `${list?.pods?.length ?? 0} pod(s)` : `HTTP ${res.status}`,
  );
  for (const p of list?.pods ?? []) {
    const n = mapPod(p);
    say(
      `  ${n.ref}  ${n.name}  ${n.state}  ${n.gpuType ?? '?'}  ${n.hourlyRate ? `$${n.hourlyRate}/h` : ''}`,
    );
  }
  if (!flag('create')) {
    say('Free checks done. Run with --create to test a whole pod life (a few US cents).');
    return;
  }

  // 2. A whole pod life.
  say(
    `Creating a ${cloud} pod: ${gpu}, ${bootstrap ? 'bootstrap.sh' : 'the vLLM image'} serving ${model}. Cap $${maxRate}/h, ${maxMinutes} min.`,
  );
  const pod = await rp.create(
    {
      name: `ancile-shakedown-${new Date().toISOString().slice(0, 16)}`,
      gpu_type_id: gpu,
      gpu_count: 1,
      cloud,
      ...(bootstrap
        ? {
            image: 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04',
            command: ['bash', '-c', `curl -fsSL ${scriptsUrl}/bootstrap.sh | bash`],
            env: {
              ANCILE_MODEL: model,
              ANCILE_SERVED_NAME: served,
              ANCILE_NODE_API_KEY: nodeKey,
              ANCILE_VLLM_ARGS: '--max-model-len 4096',
              ANCILE_NODE_SCRIPTS: scriptsUrl,
            },
          }
        : {
            image: 'vllm/vllm-openai:latest',
            env: {},
            command: [
              '--model',
              model,
              '--port',
              '8000',
              '--served-model-name',
              served,
              '--max-model-len',
              '4096',
            ],
          }),
      container_disk_gb: 30,
      // The bootstrap keeps vLLM and the weights on /workspace, so a restart reuses them.
      volume_gb: bootstrap ? 20 : 0,
      ports: ['8000/http'],
      ...(region && { region }),
    },
    `shake-create-${randomUUID()}`,
  );
  podId = pod.ref;
  rate = pod.hourlyRate;
  record(
    'create (v2 body)',
    Boolean(podId),
    `pod ${podId}, ${pod.state}, ${rate ? `$${rate}/h` : 'rate not reported yet'}`,
  );
  if (rate && rate > maxRate) {
    record('price under the cap', false, `$${rate}/h is over $${maxRate}/h`);
    return;
  }

  record('reaches running', await waitState('running', 15));
  if (rate && rate > maxRate) {
    record('price under the cap', false, `$${rate}/h is over $${maxRate}/h`);
    return;
  }
  const first = await modelAnswers(bootstrap ? 25 : 15);
  record('vLLM answers through the RunPod proxy', first.ok, first.note);

  const stop = await rp.action(podId, 'stop', `shake-stop-${randomUUID()}`);
  say(`  stop: ${stop.detail}`);
  record('stop reaches stopped (EXITED)', await waitState('stopped', 5));
  const stopped = await rp.getNode(podId);
  record(
    'a stopped pod keeps its known rate',
    stopped.hourlyRate === null || stopped.hourlyRate > 0,
    'cost 0.0 while EXITED is not read as free',
  );

  const start = await rp.action(podId, 'start', `shake-start-${randomUUID()}`);
  say(`  start: ${start.detail}`);
  record('start again reaches running', await waitState('running', 15));
  const second = await modelAnswers(15);
  record('vLLM answers after a restart', second.ok, second.note);

  const again = await rp.action(podId, 'start', `shake-start-${randomUUID()}`).then(
    () => 'accepted',
    (e) => `${(e as { error?: { code?: string } }).error?.code ?? 'error'}`,
  );
  say(`  starting a running pod: ${again} (invalid_state or accepted are both fine)`);
}

main()
  .catch((e) => record('unexpected error', false, e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await cleanUp();
    const minutes = (Date.now() - t0) / 60_000;
    const spent = rate ? (rate * minutes) / 60 : null;
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length}/${results.length} checks in ${minutes.toFixed(1)} min${spent ? `, about $${spent.toFixed(3)} of GPU time` : ''}.`,
    );
    for (const f of failed) console.log(`  - ${f.step}: ${f.note}`);
    process.exit(failed.length ? 1 : 0);
  });
