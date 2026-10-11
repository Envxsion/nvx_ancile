#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  pnpm doctor
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Checks everything Ancile needs before it can boot and
 *           |  says exactly how to fix what is missing.
 *  How      |  Prerequisites, .env completeness, free ports, disk
 *           |  space for the data directory, Docker (optional). Exit 1 if
 *           |  anything blocks a boot.
 * ------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { atLeast, c, mark, probe, ROOT, readEnv } from './lib.mjs';

const results = [];
const check = (ok, label, fix, level = 'fail') => results.push({ ok, label, fix, level });

// --- Prerequisites ---------------------------------------------------------
const node = process.version;
check(
  atLeast(node, '22.12'),
  `Node ${node}`,
  'Install Node 22.12 or later (https://nodejs.org or `nvm install 22`).',
);

const pnpm = probe('pnpm');
check(
  !!pnpm && atLeast(pnpm, '10.0'),
  pnpm ? `pnpm ${pnpm}` : 'pnpm not found',
  'Run `corepack enable` then `corepack prepare pnpm@11 --activate`.',
);

const uv = probe('uv');
check(!!uv, uv ?? 'uv not found', 'Install uv: https://docs.astral.sh/uv/getting-started/installation/');

const git = probe('git');
check(!!git, git ?? 'git not found', 'Install git. Memory is versioned with it.');

// Docker is optional: Postgres runs embedded (pg0), downloaded on the first
// `pnpm start`. It is only needed for `pnpm up:docker` and the restart adapter.
const docker = probe('docker');
check(
  !!docker,
  docker ? `${docker} (optional)` : 'Docker not found (optional)',
  'Not needed: Postgres runs embedded. Install Docker only to run everything in containers.',
  'warn',
);

// --- Environment -----------------------------------------------------------
// .env is optional: `pnpm start` makes every secret on first run into
// .ancile/secrets.json, and a value in .env wins over it. Only names are read
// here, never printed.
const envFile = join(ROOT, '.env');
const secretsFile = join(ROOT, '.ancile', 'secrets.json');
let made = {};
try {
  made = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {};
} catch {
  check(false, '.ancile/secrets.json readable', 'Delete .ancile/secrets.json; `pnpm start` makes it again.');
}
// A blank line in .env (KEY=) leaves the generated value in charge, as at start.
const env = { ...made, ...Object.fromEntries(Object.entries(readEnv()).filter(([, v]) => v !== '')) };
check(
  true,
  existsSync(envFile)
    ? '.env present (its values win)'
    : 'No .env: defaults, with secrets made on first start',
  '',
);
const firstRun = !existsSync(secretsFile);
for (const key of ['ANCILE_SECRET_KEY', 'ANCILE_SERVICE_TOKEN', 'CONTROLLER_TOKEN']) {
  check(
    !!env[key] || firstRun,
    env[key] ? `${key} set` : `${key} will be made on first start`,
    'Run `pnpm start` once to make it, or set it in .env.',
    env[key] ? 'fail' : 'warn',
  );
}
// The runner builds DATABASE_URL from the POSTGRES_* values when it is not set.
check(
  !!(env.DATABASE_URL || env.POSTGRES_PASSWORD) || firstRun,
  env.DATABASE_URL
    ? 'DATABASE_URL set'
    : env.POSTGRES_PASSWORD
      ? 'Postgres password set'
      : 'Postgres password will be made on first start',
  'Run `pnpm start` once to make it, or set POSTGRES_PASSWORD in .env.',
  env.DATABASE_URL || env.POSTGRES_PASSWORD ? 'fail' : 'warn',
);
if (env.ANCILE_SECRET_KEY) {
  const len = Buffer.from(env.ANCILE_SECRET_KEY, 'base64').length;
  check(
    len === 32,
    'ANCILE_SECRET_KEY is 32 bytes',
    'It must be 32 random bytes in base64. Generate one with `node scripts/gen-keys.mjs`.',
  );
}
const host = env.ANCILE_HOST ?? '127.0.0.1';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
check(
  loopback || env.ANCILE_PASSPHRASE_REQUIRED === 'true',
  `Bind address ${host}${loopback ? ' (loopback)' : ''}`,
  'Ancile is exposed beyond this machine without a passphrase. Set ANCILE_PASSPHRASE_REQUIRED=true or ANCILE_HOST=127.0.0.1.',
);
const anyProvider = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
].some((k) => env[k]);
check(
  anyProvider,
  'A cloud model key in .env',
  'Optional: you can add keys in the first-run setup instead, or use Ollama.',
  'warn',
);

// --- Ports -----------------------------------------------------------------
const portFree = (port) =>
  new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(false));
    srv.once('listening', () => srv.close(() => done(true)));
    srv.listen(port, '127.0.0.1');
  });
const ports = {
  Core: Number(env.ANCILE_PORT ?? 7700),
  'Cockpit (dev)': 7701,
  Knowledge: Number(env.KNOWLEDGE_PORT ?? 7710),
  Controller: Number(env.CONTROLLER_PORT ?? 7720),
  Postgres: Number(env.POSTGRES_PORT ?? 5433),
};
for (const [name, port] of Object.entries(ports)) {
  const free = await portFree(port);
  check(
    free,
    `Port ${port} free for ${name}`,
    `Something else is listening on ${port}. Stop it, or change the port in .env. If it's Ancile already running, that's fine.`,
    'warn',
  );
}

// --- Disk ------------------------------------------------------------------
const dataDir = resolve(ROOT, env.ANCILE_DATA_DIR ?? './data');
try {
  mkdirSync(dataDir, { recursive: true });
  const s = statfsSync(dataDir);
  const freeGb = (s.bavail * s.bsize) / 1e9;
  check(
    freeGb >= 5,
    `${freeGb.toFixed(1)} GB free for ${dataDir}`,
    'Ancile wants at least 5 GB free for models, sources and the database. Free space or move ANCILE_DATA_DIR.',
    freeGb >= 2 ? 'warn' : 'fail',
  );
} catch (e) {
  check(false, `Data directory ${dataDir} writable`, `Create it or fix permissions: ${e.message}`);
}

// --- Report ----------------------------------------------------------------
console.log(`\n${c.bold('NVX Ancile')} ${c.dim('doctor')}\n`);
let blocking = 0;
for (const r of results) {
  const icon = r.ok ? mark.ok : r.level === 'warn' ? mark.warn : mark.fail;
  console.log(`  ${icon} ${r.label}`);
  if (!r.ok) {
    console.log(`    ${c.dim(r.fix)}`);
    if (r.level !== 'warn') blocking++;
  }
}
console.log(
  blocking
    ? `\n${mark.fail} ${blocking} thing${blocking > 1 ? 's' : ''} to fix before Ancile can boot.\n`
    : `\n${mark.ok} Ready. Run ${c.signal('pnpm start')}.\n`,
);
process.exit(blocking ? 1 : 0);
