#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  pnpm test:live
 *  Ref      |  docs/testing.md · tests/live/live.spec.ts · gateway/e2e-guard.ts
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Run the opt-in live suite: real Claude Haiku and a small
 *           |  model on a RunPod pod, in a throwaway notebook, with a
 *           |  hard spending cap (LT1).
 *  How      |  pnpm test:live --yes     the real run, on your everyday
 *           |    stack (ports 7700/7701): it stops that stack, starts it
 *           |    again with ANCILE_LIVE_ALLOW and ANCILE_LIVE_CAP_USD so
 *           |    Core refuses every other model, runs the spec, and
 *           |    always stops the stack it started.
 *           |  pnpm test:live --dry     the same spec against the test
 *           |    profile (pnpm start:e2e): offline/test for both models,
 *           |    the Controller's fake provider for the node. Free.
 *           |  Options: --haiku <model id>  --cap <usd>  --shots
 *           |  (--shots saves a screenshot of the thread).
 *  Note     |  Without --yes it only says what it would do. Keys are
 *           |  checked through GET /credentials, which shows set: true
 *           |  or false and nothing else; no key value is read or shown.
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { c, IS_WIN, killTree, mark, ROOT, readEnv, run, sleep } from './lib.mjs';
import { bearer, keyFileIn, readKeyFile } from './local-api.mjs';
import { composeEnv, RUNTIME_DIR } from './runtime.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
};

const DRY = has('--dry');
const HAIKU = opt('--haiku', 'anthropic/claude-haiku-4-5');
// The model the pod serves, and the id Core gives it (compute/bridge.ts nodeModelId).
const HF_MODEL = 'Qwen/Qwen2.5-1.5B-Instruct';
const SERVED_NAME = 'qwen2.5-1.5b';
const NODE_ID = `node/${SERVED_NAME}`;
const CAP = Number(opt('--cap', '2'));
if (!Number.isFinite(CAP) || CAP <= 0) {
  console.error(`${mark.fail} --cap must be a positive number of US dollars.`);
  process.exit(2);
}

// The profile decides the ports: the test profile runs beside the everyday stack, +100.
if (DRY) process.env.ANCILE_PROFILE = 'e2e';
const env = composeEnv(readEnv());
const corePort = env.ANCILE_PORT;
const core = `http://127.0.0.1:${corePort}`;
const cockpit = `http://localhost:${env.COCKPIT_PORT}`;
const controller = `http://127.0.0.1:${env.CONTROLLER_PORT}`;

const say = (s) => console.log(`  ${s}`);
const fail = (title, hint) => {
  console.log(`\n${mark.fail} ${c.bold(title)}\n  ${c.warn('What to do:')} ${hint}\n`);
  process.exit(1);
};

// Core answers /api/v1 only to its owner (docs/api.md): this run holds the install key's file, not its value.
const keyFile = keyFileIn(env.ANCILE_DATA_DIR);
const asOwner = () => {
  const key = readKeyFile(keyFile);
  if (!key) throw new Error(`Core has not made its install key yet (${keyFile}).`);
  return bearer(key);
};

async function healthy(base = core) {
  try {
    // /ready needs no key, so it answers before Core has made one.
    const r = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(3_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Which keys are set, from GET /credentials: only `set` true or false is read. */
async function keysSet() {
  const r = await fetch(`${core}/api/v1/credentials`, {
    headers: asOwner(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`GET /credentials answered ${r.status}`);
  const { items } = await r.json();
  const set = (id) => items.find((i) => i.id === id)?.set === true;
  return { anthropic: set('anthropic'), runpod: set('runpod') };
}

function refuseWithoutKeys(keys) {
  const missing = [];
  if (!keys.anthropic) missing.push('an Anthropic key (Settings → Keys → Anthropic)');
  if (!keys.runpod) missing.push('a RunPod key (Admin → Compute → Connect RunPod)');
  if (missing.length)
    fail(
      'The live suite needs two keys first',
      `Add ${missing.join(' and ')}, then run it again. Nothing was started or stopped.`,
    );
}

// --- 1. Say what will happen ---------------------------------------------------------------

console.log(`\n${c.signal('◖◗')} ${c.bold('NVX Ancile live tests')} ${DRY ? c.dim('· dry run') : ''}`);
if (DRY) {
  say(
    `Dry run: the test profile on ports ${env.ANCILE_PORT}/${env.COCKPIT_PORT}, offline/test standing in for both models,`,
  );
  say(
    "and the Controller's sample provider standing in for RunPod. Nothing real is called and nothing is spent.",
  );
} else {
  say(`This run uses REAL models on your everyday stack (ports ${corePort}/${env.COCKPIT_PORT}):`);
  say(`  - ${HAIKU} (Anthropic, billed to your key or your plan's monthly API credit)`);
  say(`  - ${HF_MODEL} on a RunPod pod, created now and terminated at the end (a few US cents)`);
  say(
    `Spending cap: $${CAP.toFixed(2)} for the model calls (ANCILE_LIVE_CAP_USD), plus the pod's hourly rate.`,
  );
  say(`Core will refuse every other model, Claude Code, images and the reviewer services while it runs.`);
  say('It uses a notebook called "Live tests (safe to delete)" and moves it to the Trash at the end.');
  say('It stops your everyday stack, starts it with the guard, and stops it again afterwards.');
}
if (!has('--yes') && !DRY) {
  console.log(`\n  Add ${c.bold('--yes')} to go on:  pnpm test:live --yes\n`);
  process.exit(1);
}

// --- 2. Bring the stack up ----------------------------------------------------------------

const logDir = join(RUNTIME_DIR, 'logs');
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, DRY ? 'test-live-dry.log' : 'test-live.log');
let boot = null;
let startedByUs = false;
let stoppedEveryday = false;

function stopStack() {
  if (boot) killTree(boot);
  boot = null;
  const r = run('node', [join(ROOT, 'scripts', 'down.mjs'), ...(DRY ? ['--e2e'] : [])], {
    timeout: 120_000,
  });
  if (!r.ok)
    say(`${mark.warn} The stop command reported a problem: run ${DRY ? 'pnpm stop:e2e' : 'pnpm stop'}.`);
}

let cleaned = false;
function cleanUp() {
  if (cleaned) return;
  cleaned = true;
  if (startedByUs) {
    console.log(`\n${mark.step} Stopping the stack this run started`);
    stopStack();
  }
  if (!DRY && (startedByUs || stoppedEveryday)) {
    console.log(`\n  ${mark.ok} Done. Start NVX Ancile normally again with ${c.bold('pnpm start')}.\n`);
  }
}
process.on('SIGINT', () => {
  cleanUp();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanUp();
  process.exit(143);
});

async function main() {
  const wasRunning = await healthy();
  if (wasRunning && DRY) {
    say(`${mark.ok} The test profile is already running; it stays up afterwards.`);
  } else {
    if (wasRunning) {
      // Check the keys on the stack that is up before touching it: no key, nothing is stopped.
      refuseWithoutKeys(
        await keysSet().catch((e) => fail('Could not read your keys', String(e.message ?? e))),
      );
      console.log(`\n${mark.step} Stopping your everyday stack (pnpm stop)`);
      const r = run('node', [join(ROOT, 'scripts', 'down.mjs')], { timeout: 120_000 });
      stoppedEveryday = true;
      if (!r.ok) fail('Could not stop the everyday stack', 'Run pnpm stop yourself, then try again.');
      for (let i = 0; i < 20 && (await healthy()); i++) await sleep(1_000);
      if (await healthy())
        fail('The everyday stack is still answering', 'Run pnpm stop yourself, then try again.');
    }
    console.log(`\n${mark.step} Starting the stack ${DRY ? '(test profile)' : 'with the live guard'}`);
    const childEnv = { ...process.env };
    // The guard is the point: set for a live run, never for a dry one.
    delete childEnv.ANCILE_LIVE_ALLOW;
    delete childEnv.ANCILE_LIVE_CAP_USD;
    if (!DRY) {
      childEnv.ANCILE_LIVE_ALLOW = [HAIKU, NODE_ID].join(',');
      childEnv.ANCILE_LIVE_CAP_USD = String(CAP);
    }
    const out = createWriteStream(logFile);
    boot = spawn(process.execPath, [join(ROOT, 'scripts', 'boot.mjs'), ...(DRY ? ['--e2e'] : [])], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WIN,
    });
    boot.stdout.pipe(out);
    boot.stderr.pipe(out);
    startedByUs = true;
    say(c.dim(`Its log: ${logFile}`));
    let up = false;
    for (let i = 0; i < 180 && !up; i++) {
      await sleep(2_000);
      if (boot.exitCode !== null) break;
      up = await healthy();
    }
    if (!up)
      fail(
        'The stack did not come up',
        `Read ${logFile}. Boot tests that fail block startup; the log says which.`,
      );
    say(`${mark.ok} Core answers on ${corePort}`);
    // Give the Controller and the log a moment to settle.
    await sleep(3_000);
  }

  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes is the point
  const log = readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  if (DRY) {
    if (startedByUs && !/Claude Code is off/.test(log))
      fail(
        'The test profile did not say "Claude Code is off"',
        `Read ${logFile}: Claude Code must be off in the test profile.`,
      );
    if (startedByUs) say(`${mark.ok} The log says Claude Code is off`);
    await fetch(`${core}/api/v1/setup/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...asOwner() },
      body: JSON.stringify({ preset: 'balanced' }),
    }).catch(() => undefined);
  } else {
    if (!/Live test guard is on/.test(log))
      fail(
        'Core did not report the live guard',
        `Read ${logFile}. The run stops here rather than call real models without it.`,
      );
    say(`${mark.ok} Core reports the live guard is on`);
    // Only reached when the stack was not already up: the keys are checked now.
    if (!wasRunning) refuseWithoutKeys(await keysSet());
    say(`${mark.ok} An Anthropic key and a RunPod key are set`);
  }

  // --- 3. The spec ------------------------------------------------------------------------
  console.log(`\n${mark.step} Running the spec ${c.dim('(the pod can take up to 10 minutes to load)')}\n`);
  const specEnv = {
    ...process.env,
    LIVE_MODE: DRY ? 'dry' : 'live',
    LIVE_CORE_URL: core,
    // The file, not the key: an environment is copied and logged, a file is not.
    LIVE_CORE_KEY_FILE: keyFile,
    LIVE_COCKPIT_URL: cockpit,
    LIVE_CONTROLLER_URL: controller,
    // Passed to the spec through the environment, never printed.
    LIVE_CONTROLLER_TOKEN: env.CONTROLLER_TOKEN,
    LIVE_CAP_USD: String(CAP),
    LIVE_HAIKU_MODEL: DRY ? 'offline/test' : HAIKU,
    LIVE_POD_MODEL: DRY ? 'offline/test' : NODE_ID,
    LIVE_HF_MODEL: HF_MODEL,
    LIVE_SERVED_NAME: SERVED_NAME,
    ...(has('--shots') && { LIVE_SHOTS: '1' }),
  };
  const code = await new Promise((resolve) => {
    const p = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'tests/live/playwright.config.ts'], {
      cwd: ROOT,
      env: specEnv,
      stdio: 'inherit',
      shell: IS_WIN,
    });
    p.on('exit', (k) => resolve(k ?? 1));
    p.on('error', () => resolve(1));
  });
  console.log(
    `\n${code === 0 ? mark.ok : mark.fail} The live spec ${code === 0 ? 'passed' : 'failed'}${DRY ? ' (dry run)' : ''}`,
  );
  return code;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.log(`\n${mark.fail} ${e?.message ?? e}`);
} finally {
  cleanUp();
}
process.exit(exitCode);
