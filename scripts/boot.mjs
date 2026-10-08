#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  pnpm start
 *  Ref      |  DESIGN.md §14 (boot tests), ROADMAP.md Phase 1
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Boot Ancile identically every time: Postgres, then
 *           |  migrations, then each service's boot suite in
 *           |  dependency order, then every service in dev mode.
 *  How      |  A failing boot suite blocks startup (ANCILE_BOOT_TESTS
 *           |  = strict), prints what failed and the remediation the
 *           |  test declared. Ctrl+C stops everything it started.
 *  Note     |  Boot tests report remediation by printing lines that
 *           |  start with "remediation:"; this script surfaces them.
 *           |  Flags: --skip-tests  --only=core,knowledge
 *           |         --no-start (run checks and exit)
 *           |         --e2e (test profile: own database and data folder)
 * ------------------------------------------------------------------
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { forwardLogs, startControl, stopChild } from './control.mjs';
import { c, killTree, mark, probe, ROOT, readEnv, run, startPrefixed } from './lib.mjs';
import {
  AGENT_DIR,
  agentEnv,
  composeEnv,
  PROFILE_FILE,
  reapPorts,
  reapStale,
  recordPids,
  servicePorts,
  startPostgres,
} from './runtime.mjs';

const args = new Set(process.argv.slice(2));
const flag = (name) => [...args].find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = flag('only')?.split(',');
// `pnpm start:e2e` (or --e2e): a separate database and data folder for test runs.
if (args.has('--e2e')) process.env.ANCILE_PROFILE = 'e2e';

const t0 = Date.now();
const elapsed = () => c.dim(`${((Date.now() - t0) / 1000).toFixed(1)}s`);

function header(text) {
  console.log(`\n${mark.step} ${c.bold(text)}`);
}

function die(title, hint, detail) {
  console.log(`\n${mark.fail} ${c.bold(title)}`);
  if (detail)
    console.log(
      c.dim(
        detail
          .trimEnd()
          .split(/\r?\n/)
          .slice(-25)
          .map((l) => `    ${l}`)
          .join('\n'),
      ),
    );
  console.log(`\n  ${c.warn('What to do:')} ${hint}\n`);
  process.exit(1);
}

console.log(`\n${c.signal('◖◗')} ${c.bold('NVX Ancile')} ${c.dim('booting')}`);

// --- 1. Environment -----------------------------------------------------------
// No Docker and no .env required (DESIGN.md §1.4). A .env, when present,
// overrides the per-machine secrets the runtime generates on first boot.
header('Environment');
const hasEnvFile = existsSync(join(ROOT, '.env'));
const env = composeEnv(readEnv());
for (const tool of ['uv', 'pnpm']) {
  if (!probe(tool))
    die(`${tool} is not installed or not on PATH`, 'Run `pnpm doctor` for install instructions.');
}
// Bun runs the Agent Engine (the lab). Optional: everything else works without it.
const hasBun = Boolean(probe('bun'));
if (!hasBun)
  console.log(
    `  ${mark.warn} Bun is not installed, so the lab (Agent Engine) will not start ${c.dim('· https://bun.sh')}`,
  );

// Processes from a previous `pnpm start` that was killed rather than stopped
// (Windows does not take children down with their parent). Reap them first
// so ports are free and no worker runs twice.
reapStale();
reapPorts(servicePorts(env));
const childEnv = { ...env, NODE_ENV: env.NODE_ENV ?? 'development' };
// Which profile is running, so the e2e suite can refuse to write to your workspace.
mkdirSync(dirname(PROFILE_FILE), { recursive: true });
writeFileSync(PROFILE_FILE, env.ANCILE_PROFILE ?? 'dev');
if (env.ANCILE_PROFILE === 'e2e')
  console.log(
    `  ${mark.ok} Test profile ${c.dim(`· database ${env.POSTGRES_DB}, data in ${env.ANCILE_DATA_DIR}`)}`,
  );
const mode = (env.ANCILE_BOOT_TESTS ?? 'strict').toLowerCase();
console.log(
  `  ${mark.ok} ${hasEnvFile ? '.env loaded' : 'Using generated secrets in .ancile/secrets.json'} ${c.dim(`· boot tests ${mode}`)}`,
);

// --- 2. Postgres (embedded, native) -------------------------------------------
header('Database');
try {
  const port = await startPostgres(childEnv, (m) => console.log(`  ${c.dim(m)}`));
  console.log(`  ${mark.ok} Postgres + pgvector on ${port} ${elapsed()}`);
} catch (e) {
  die(
    'Could not start Postgres',
    'A port clash on 5433 is the usual cause: set POSTGRES_PORT, or stop the other server. `pnpm doctor` checks ports.',
    String(e.message ?? e),
  );
}

// --- 3. Migrations ------------------------------------------------------------
header('Migrations');
const migrations = [
  { name: 'core', cmd: 'pnpm', args: ['--filter', '@nvx/ancile-core', 'run', 'db:migrate'] },
  { name: 'controller', cmd: 'pnpm', args: ['--filter', '@nvx/ancile-controller', 'run', 'db:migrate'] },
  {
    name: 'knowledge',
    cmd: 'uv',
    args: ['run', '--extra', 'embed', '--extra', 'extract', 'alembic', 'upgrade', 'head'],
    cwd: join(ROOT, 'services/knowledge'),
  },
];
for (const m of migrations) {
  const r = run(m.cmd, m.args, { cwd: m.cwd, env: childEnv });
  if (!r.ok)
    die(
      `Migrations failed for ${m.name}`,
      `Read the error above. If the schema was edited by hand, see docs/runbooks/restore-backup.md.`,
      r.out,
    );
  console.log(`  ${mark.ok} ${m.name}`);
}

// --- 4. Boot tests --------------------------------------------------------------
// Dependency order: the Controller and Knowledge do not need Core; Core checks both.
const suites = [
  { name: 'controller', cmd: 'pnpm', args: ['--filter', '@nvx/ancile-controller', 'run', 'test:boot'] },
  {
    name: 'knowledge',
    cmd: 'uv',
    args: [
      'run',
      '--project',
      'services/knowledge',
      '--extra',
      'embed',
      '--extra',
      'extract',
      'pytest',
      'services/knowledge',
      '-m',
      'boot',
      '-q',
    ],
  },
  { name: 'core', cmd: 'pnpm', args: ['--filter', '@nvx/ancile-core', 'run', 'test:boot'] },
].filter((s) => !only || only.includes(s.name));

if (args.has('--skip-tests') || mode === 'off') {
  console.log(`\n${mark.warn} Boot tests skipped ${c.dim('(ANCILE_BOOT_TESTS=off or --skip-tests)')}`);
} else {
  header('Boot tests');
  const failed = [];
  for (const s of suites) {
    const started = Date.now();
    const r = run(s.cmd, s.args, { env: { ...childEnv, ANCILE_BOOT: '1' }, timeout: 120_000 });
    const ms = Date.now() - started;
    if (r.ok) {
      console.log(`  ${mark.ok} ${s.name} ${c.dim(`${(ms / 1000).toFixed(1)}s`)}`);
      continue;
    }
    failed.push(s.name);
    console.log(
      `  ${mode === 'strict' ? mark.fail : mark.warn} ${s.name} ${c.dim(`${(ms / 1000).toFixed(1)}s`)}`,
    );
    // Two conventions carry the fix: Python boot tests print "remediation: …"
    // (or "Fix: …" in a skip reason); Core's put it in the failing test's name
    // after " | fix: ". Both are surfaced the same way.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes is the point
    const plain = r.out.replace(/\x1b\[[0-9;]*m/g, '');
    const remediations = plain
      .split(/\r?\n/)
      .filter((l) => /remediation:|\|\s*fix:/i.test(l) && !/✓/.test(l))
      .map((l) =>
        l
          .replace(/^.*?(remediation:|\|\s*fix:)\s*/i, '')
          .replace(/\s+\d+ms\s*$/, '')
          .trim(),
      );
    const tail = plain
      .trimEnd()
      .split(/\r?\n/)
      .filter((l) => !/remediation:|\|\s*fix:/i.test(l))
      .slice(-15);
    console.log(c.dim(tail.map((l) => `      ${l}`).join('\n')));
    for (const fix of new Set(remediations)) console.log(`      ${c.warn('fix:')} ${fix}`);
  }
  if (failed.length && mode === 'strict') {
    die(
      `Boot tests failed: ${failed.join(', ')}`,
      'Fix the items above and run `pnpm start` again. To start anyway while you debug, set ANCILE_BOOT_TESTS=warn (not for daily use).',
    );
  }
}

if (args.has('--no-start')) {
  console.log(`\n${mark.ok} Checks passed ${elapsed()}\n`);
  process.exit(0);
}

// --- 5. Services ------------------------------------------------------------------
header('Starting services');
const services = [
  {
    name: 'controller',
    rgb: [79, 214, 234],
    cmd: 'pnpm',
    args: ['--filter', '@nvx/ancile-controller', 'run', 'dev'],
  },
  {
    name: 'knowledge',
    rgb: [63, 207, 142],
    cmd: 'uv',
    args: [
      'run',
      '--project',
      'services/knowledge',
      '--extra',
      'embed',
      '--extra',
      'extract',
      'uvicorn',
      'ancile_knowledge.main:app',
      '--port',
      String(env.KNOWLEDGE_PORT ?? 7710),
      '--reload',
      '--app-dir',
      'services/knowledge',
    ],
  },
  // The lab: our opencode fork, headless, reachable only with the agent token.
  ...(hasBun
    ? [
        {
          name: 'agent',
          rgb: [229, 110, 196],
          cwd: join(AGENT_DIR, 'packages', 'opencode'),
          env: agentEnv(childEnv),
          // Never inherits the service environment (secrets, DATABASE_URL).
          isolated: true,
          cmd: 'bun',
          args: [
            'run',
            './src/index.ts',
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(env.AGENT_ENGINE_PORT ?? 7730),
          ],
        },
      ]
    : []),
  { name: 'core', rgb: [157, 134, 255], cmd: 'pnpm', args: ['--filter', '@nvx/ancile-core', 'run', 'dev'] },
  {
    name: 'cockpit',
    rgb: [223, 228, 236],
    cmd: 'pnpm',
    args: ['--filter', '@nvx/ancile-cockpit', 'run', 'dev'],
  },
].filter((s) => !only || only.includes(s.name));

if (services.some((s) => s.name === 'agent') && !existsSync(join(AGENT_DIR, 'node_modules'))) {
  console.log(`  ${c.dim('Installing the Agent Engine’s dependencies (first run only)…')}`);
  const r = run('bun', ['install'], { cwd: AGENT_DIR, timeout: 900_000 });
  if (!r.ok)
    die(
      'Could not install the Agent Engine',
      'Run `bun install` in vendor/opencode to see the error.',
      r.out,
    );
}

// Core's supervisor restarts the others through this runner (restart adapter
// "process"), and their log lines are forwarded to Core for Admin → Logs.
const control = await startControl();
childEnv.ANCILE_CONTROL_URL = control.url;
childEnv.ANCILE_CONTROL_TOKEN = control.token;
if (!env.ANCILE_RESTART_ADAPTER) childEnv.ANCILE_RESTART_ADAPTER = 'process';
const coreUrl = `http://127.0.0.1:${env.ANCILE_PORT ?? 7700}`;

const spawnService = (s) => {
  const child = startPrefixed(s.name, s.rgb, s.cmd, s.args, {
    env: s.isolated ? s.env : { ...childEnv, ...s.env },
    cwd: s.cwd,
    isolated: !!s.isolated,
  });
  if (s.name !== 'core' && s.name !== 'cockpit')
    forwardLogs(child, s.name, { coreUrl, token: childEnv.ANCILE_SERVICE_TOKEN });
  return child;
};
const children = services.map((s) => ({ ...s, child: spawnService(s) }));
recordPids(children.map((s) => s.child.pid));
for (const s of children) {
  if (s.name === 'core' || s.name === 'cockpit') continue;
  control.on(s.name, async () => {
    console.log(`\n${mark.step} Restarting ${s.name} (asked by Core's supervisor)…`);
    // The old process exits on purpose: don't report it as a crash.
    s.restarting = true;
    await stopChild(s.child);
    s.child = spawnService(s);
    s.restarting = false;
    watchExit(s);
    recordPids(children.map((x) => x.child.pid));
  });
}
control.on('postgres', async () => {
  console.log(`\n${mark.step} Starting Postgres again (asked by Core's supervisor)…`);
  await startPostgres(childEnv, (m) => console.log(`  ${c.dim(m)}`));
});

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${mark.step} Stopping ${children.length} services…`);
  for (const s of children) killTree(s.child);
  control.close();
  console.log(c.dim('  Postgres keeps running in the background. `pnpm stop` stops it.\n'));
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
function watchExit(s) {
  const child = s.child;
  child.on('exit', (code) => {
    // A child replaced by a restart is expected to exit.
    if (!stopping && !s.restarting && s.child === child && code !== 0 && code !== null) {
      console.log(`\n${mark.fail} ${s.name} exited with code ${code}. Its last lines are above.`);
      console.log(c.dim('  The others keep running. Fix and save, or press Ctrl+C to stop everything.'));
    }
    // Every service is gone (`pnpm stop` from another terminal, or all crashed):
    // nothing is left to run or restart, so the launcher leaves too instead of
    // lingering with no services under it.
    setTimeout(() => {
      const alive = (x) => x.child.exitCode === null && x.child.signalCode === null;
      if (stopping || children.some((x) => x.restarting || alive(x))) return;
      console.log(`\n${mark.step} Every service has stopped, so this launcher is stopping too.`);
      stopping = true;
      control.close();
      process.exit(0);
    }, 1000);
  });
}
for (const s of children) watchExit(s);

const port = env.ANCILE_PORT ?? 7700;
console.log(`\n  ${mark.ok} NVX Ancile is starting ${elapsed()}`);
console.log(`    Cockpit (dev)  ${c.signal(`http://localhost:${env.COCKPIT_PORT ?? 7701}`)}`);
console.log(`    Core API       ${c.dim(`http://localhost:${port}/api/v1`)}`);
console.log(`    Health         ${c.dim(`http://localhost:${port}/api/v1/system/health`)}`);
console.log(c.dim('\n  Ctrl+C stops the services.\n'));
