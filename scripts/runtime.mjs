/**
 * ------------------------------------------------------------------
 *  Title    |  Native runtime (no Docker)
 *  Ref      |  DESIGN.md §1.4 Runtime modes
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Everything Ancile needs underneath it, as plain
 *           |  processes: embedded Postgres + pgvector (pg0, MIT).
 *           |  The desktop app's
 *           |  supervisor does the same thing from Tauri.
 *  How      |  Pinned binaries are fetched once into .ancile/bin and
 *           |  checked against their SHA-256 before first use. Postgres
 *           |  is started detached (it outlives `pnpm start`, like a
 *           |  service), and its data lives in data/pg.
 *  Note     |  Secrets: when there is no .env, per-machine secrets are
 *           |  generated once into .ancile/secrets.json, exactly as the
 *           |  desktop app does in AppData on first run. A .env, when
 *           |  present, always wins.
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { IS_WIN, ROOT, run, sleep } from './lib.mjs';

export const RUNTIME_DIR = join(ROOT, '.ancile');
export const BIN_DIR = join(RUNTIME_DIR, 'bin');
const SECRETS_FILE = join(RUNTIME_DIR, 'secrets.json');
const PG_INSTANCE = 'ancile-dev';

/**
 * Pinned runtime binaries. Bump deliberately: change the version, delete
 * .ancile/bin/<name>, run `pnpm start`, and record the new hash printed by
 * the mismatch error after checking the release page.
 */
const BINARIES = {
  pg0: {
    version: 'v0.15.2',
    asset: {
      'win32-x64': 'pg0-windows-x86_64.exe',
      'darwin-arm64': 'pg0-darwin-aarch64',
      'darwin-x64': 'pg0-darwin-x86_64',
      'linux-x64': 'pg0-linux-x86_64-gnu',
      'linux-arm64': 'pg0-linux-aarch64-gnu',
    },
    url: (v, a) => `https://github.com/vectorize-io/pg0/releases/download/${v}/${a}`,
    sha256: {
      'win32-x64': '8894575679886fef41e176608da16f4448fdeea4cc60c02380422adc147260b7',
      // TODO(phase-1): pin the other platforms from a machine of each kind.
    },
  },
};

const platformKey = () => `${process.platform}-${process.arch}`;
const exe = (name) => join(BIN_DIR, IS_WIN ? `${name}.exe` : name);

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Download a pinned binary once, verify it, and return its path. */
export async function ensureBinary(name, log = () => {}) {
  const spec = BINARIES[name];
  const key = platformKey();
  const asset = spec.asset[key];
  if (!asset)
    throw new Error(`${name} has no build for ${key}. Run Ancile with Docker instead: docker compose up -d`);
  const target = exe(name);
  const pinned = spec.sha256[key];

  if (!existsSync(target)) {
    mkdirSync(BIN_DIR, { recursive: true });
    const url = spec.url(spec.version, asset);
    log(`Downloading ${name} ${spec.version} (first run only)`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok)
      throw new Error(
        `Download failed (${res.status}) from ${url}. Check your connection, or fetch it by hand into ${BIN_DIR}.`,
      );
    const tmp = `${target}.part`;
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    if (asset.endsWith('.tgz')) {
      // Unix releases ship as a tarball holding the one binary. `tar` is on
      // every supported platform, Windows 10+ included.
      const dir = join(BIN_DIR, `${name}.extract`);
      mkdirSync(dir, { recursive: true });
      const r = run('tar', ['-xzf', tmp, '-C', dir]);
      if (!r.ok) throw new Error(`Could not unpack ${asset}:\n${r.out}`);
      renameSync(join(dir, name), target);
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmp, { force: true });
    } else {
      renameSync(tmp, target);
    }
    if (!IS_WIN) chmodSync(target, 0o755);
  }

  if (pinned) {
    const actual = sha256(target);
    if (actual !== pinned) {
      throw new Error(
        `${name} at ${target} does not match its pinned checksum (got ${actual}). Delete it and run again; if it still differs, the release changed and must be reviewed before use.`,
      );
    }
  } else {
    log(`${name}: no checksum pinned for ${key} yet, so it was not verified`);
  }
  return target;
}

/** Per-machine dev secrets, generated once. A .env value always wins. */
export function runtimeSecrets() {
  const key = () => randomBytes(32).toString('base64');
  const token = () => randomBytes(24).toString('base64url');
  const wanted = {
    ANCILE_SECRET_KEY: key,
    ANCILE_SERVICE_TOKEN: token,
    CONTROLLER_TOKEN: token,
    CONTROLLER_NODE_TOKEN: token,
    AGENT_ENGINE_TOKEN: token,
    // The lab's key to Core: model calls only (/internal/v1/openai/*).
    AGENT_GATEWAY_TOKEN: token,
    POSTGRES_PASSWORD: token,
  };
  const existing = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) : {};
  const missing = Object.keys(wanted).filter((k) => !existing[k]);
  if (missing.length === 0) return existing;
  // New secrets are added; existing ones are never rotated by an upgrade.
  const secrets = { ...existing, ...Object.fromEntries(missing.map((k) => [k, wanted[k]()])) };
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return secrets;
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    s.once('connect', () => {
      s.end();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => {
      s.destroy();
      resolve(false);
    });
  });
}

function instanceRunning(pg0) {
  const r = run(pg0, ['info', '--name', PG_INSTANCE, '-o', 'json'], { timeout: 15_000 });
  if (!r.ok) return false;
  try {
    return JSON.parse(r.out.slice(r.out.indexOf('{'))).running === true;
  } catch {
    return false;
  }
}

/**
 * Start embedded Postgres if it is not already up. pg0 keeps the server
 * attached to whoever started it, so it is spawned detached with no stdio:
 * it then lives on after this script, like a system service would.
 */
export async function startPostgres(env, log = () => {}) {
  const pg0 = await ensureBinary('pg0', log);
  const port = Number(env.POSTGRES_PORT ?? 5433);
  if (await portOpen(port)) {
    log(`Postgres already listening on ${port}`);
  } else {
    const dataDir = env.ANCILE_PG_DIR ?? resolve(ROOT, env.ANCILE_DATA_DIR ?? 'data', 'pg');
    mkdirSync(dataDir, { recursive: true });
    const child = spawn(
      pg0,
      [
        'start',
        '--name',
        PG_INSTANCE,
        '--port',
        String(port),
        '--data-dir',
        dataDir,
        '--username',
        env.POSTGRES_USER ?? 'ancile',
        '--password',
        env.POSTGRES_PASSWORD,
        '--database',
        env.POSTGRES_DB ?? 'ancile',
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    // Ready means pg0 has registered the instance as running, not merely that
    // the port is open: the server listens a moment before pg0 records it,
    // and `pg0 psql` refuses to connect until then.
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(500);
      up = (await portOpen(port)) && instanceRunning(pg0);
    }
    if (!up)
      throw new Error(
        `Postgres did not become ready on port ${port} within 60 s. See \`${pg0} logs --name ${PG_INSTANCE}\`.`,
      );
  }
  // A profile's own database (pnpm start:e2e) lives on the same server.
  const db = env.POSTGRES_DB ?? 'ancile';
  if (!/^[a-z0-9_]+$/.test(db)) throw new Error(`POSTGRES_DB must be lowercase letters, digits and _: ${db}`);
  // run() goes through cmd.exe on Windows, which splits unquoted SQL on spaces.
  const sql = (q) => (IS_WIN ? `"${q}"` : q);
  const exists = run(
    pg0,
    ['psql', '--name', PG_INSTANCE, '--', '-tAc', sql(`SELECT 1 FROM pg_database WHERE datname = '${db}'`)],
    {
      timeout: 30_000,
    },
  );
  if (exists.ok && !exists.out.includes('1')) {
    const made = run(pg0, ['psql', '--name', PG_INSTANCE, '--', '-c', sql(`CREATE DATABASE ${db}`)], {
      timeout: 30_000,
    });
    if (!made.ok)
      throw new Error(`Could not create the ${db} database:
${made.out}`);
    log(`Created the ${db} database`);
  }
  // Extensions and schemas: idempotent, so safe on every boot. pg0 connects
  // to its own database (ancile); another one needs a full connection URI,
  // because a bare -d would also drop pg0's host and port. The password
  // travels in PGPASSWORD, never on the command line.
  const target =
    db === 'ancile' ? [] : ['-d', `postgresql://${env.POSTGRES_USER ?? 'ancile'}@127.0.0.1:${port}/${db}`];
  const init = run(
    pg0,
    ['psql', '--name', PG_INSTANCE, '--', ...target, '-f', join(ROOT, 'infra', 'db', 'init.sql')],
    { timeout: 60_000, env: env.POSTGRES_PASSWORD ? { PGPASSWORD: env.POSTGRES_PASSWORD } : {} },
  );
  if (!init.ok) throw new Error(`Database bootstrap failed:\n${init.out}`);
  return port;
}

/**
 * Environment for the Agent Engine (our opencode fork) only. Kept out of the
 * shared env: the XDG overrides would otherwise move uv's and other tools'
 * caches too.
 *
 * What each switch is for (all real opencode flags, no code patches):
 * - its own data, config and DB under data/agent, so Ancile labs never mix
 *   with an opencode the user runs themselves
 * - no phone-home: no autoupdate, no share uploads, no models.dev fetch
 *   (models come from Core's gateway in Phase 2)
 * - no reading the user's Claude Code config or skills into Ancile labs
 * - no bundled provider-login plugins (consumer-subscription logins are a
 *   terms-of-service risk; see UPSTREAM.md)
 * - no embedded web UI: the Cockpit is the UI
 */
/**
 * The lab's whole configuration, injected so no project file can change it
 * (OPENCODE_DISABLE_PROJECT_CONFIG): Core's gateway is the only provider,
 * and every tool asks, so each call reaches Core's permission bridge
 * (services/core/src/lab). Core answers "once" or "reject", never
 * "always": grants live in Core, nowhere else. `question` is denied
 * because nobody is at the engine's own prompt. Tracked in
 * vendor/opencode/PATCHES.md.
 */
export function agentConfig(env) {
  const core = `http://127.0.0.1:${env.ANCILE_PORT ?? '7700'}`;
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      ancile: {
        npm: '@ai-sdk/openai-compatible',
        name: 'NVX Ancile',
        options: { baseURL: `${core}/internal/v1/openai`, apiKey: '{env:ANCILE_GATEWAY_TOKEN}' },
        models: {
          ancile: { name: 'Ancile routing', tool_call: true, limit: { context: 200000, output: 32000 } },
        },
      },
    },
    enabled_providers: ['ancile'],
    model: 'ancile/ancile',
    small_model: 'ancile/ancile',
    share: 'disabled',
    autoupdate: false,
    snapshot: true,
    permission: {
      '*': 'ask',
      question: 'deny',
      skill: 'deny',
      todowrite: 'allow',
      task: 'allow',
      lsp: 'allow',
    },
  };
}

/**
 * What a process may see of the parent environment when it must not see
 * Ancile's secrets: enough to find programs, a home and a temp dir.
 */
const SYSTEM_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'SystemDrive',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'USER',
  'USERNAME',
  'BUN_INSTALL',
  'NODE_EXTRA_CA_CERTS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
];

export function systemEnv(source = process.env) {
  return Object.fromEntries(SYSTEM_ENV.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
}

/**
 * The agent engine runs commands a model chose, so its environment is
 * built from nothing: system basics, its own server password, and a
 * gateway token that can only ask Core for model completions. It never
 * sees the service token, the database URL or any provider key.
 */
export function agentEnv(env) {
  const base = resolve(ROOT, env.ANCILE_DATA_DIR ?? 'data', 'agent');
  return {
    ...systemEnv(),
    OPENCODE_SERVER_PASSWORD: env.AGENT_ENGINE_TOKEN,
    ANCILE_GATEWAY_TOKEN: env.AGENT_GATEWAY_TOKEN,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(agentConfig(env)),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    XDG_DATA_HOME: join(base, 'data'),
    XDG_CONFIG_HOME: join(base, 'config'),
    XDG_CACHE_HOME: join(base, 'cache'),
    XDG_STATE_HOME: join(base, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  };
}

export const AGENT_DIR = join(ROOT, 'vendor', 'opencode');

// One file per profile: the test stack and your everyday stack run side by side.
const pidsFile = () => join(RUNTIME_DIR, `${process.env.ANCILE_PROFILE === 'e2e' ? 'e2e' : 'dev'}-pids.json`);

function commandLineOf(pid) {
  const r = IS_WIN
    ? run(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
        ],
        { timeout: 15_000 },
      )
    : run('ps', ['-o', 'command=', '-p', String(Number(pid))], { timeout: 5_000 });
  return r.ok ? r.out : '';
}

/** Signatures of the service commands boot.mjs starts, and nothing else. */
export function isOurs(cmd) {
  return /@nvx\/ancile-|ancile_knowledge|index\.ts['"]? serve/.test(cmd);
}

/** Remember the service process trees `pnpm start` started. */
export function recordPids(pids) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(pidsFile(), JSON.stringify(pids.filter(Boolean)));
}

/**
 * Stop service trees left by a previous `pnpm start` that was killed instead
 * of stopped. Only PIDs this script recorded are touched; Postgres is not
 * in the list and keeps running.
 */
export function reapStale() {
  if (!existsSync(pidsFile())) return 0;
  let reaped = 0;
  for (const pid of JSON.parse(readFileSync(pidsFile(), 'utf8'))) {
    try {
      process.kill(pid, 0); // still alive?
    } catch {
      continue;
    }
    // PIDs are reused (after a reboot, a recorded PID can be any program).
    // Only kill a process whose command line proves it is one of ours.
    if (!isOurs(commandLineOf(pid))) continue;
    if (IS_WIN) run('taskkill', ['/pid', String(pid), '/T', '/F']);
    else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    reaped++;
  }
  rmSync(pidsFile(), { force: true });
  return reaped;
}

/** The process listening on a TCP port on this machine, or null. */
function listenerOf(port) {
  const r = IS_WIN
    ? run(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          // No pipe: run() goes through cmd.exe on Windows, which would take `|` as its own.
          `@(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue)[0].OwningProcess`,
        ],
        { timeout: 15_000 },
      )
    : run('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { timeout: 5_000 });
  const pid = Number.parseInt((r.out ?? '').trim().split(/\s+/)[0] ?? '', 10);
  return r.ok && pid > 0 ? pid : null;
}

function parentOf(pid) {
  const r = IS_WIN
    ? run(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`,
        ],
        { timeout: 15_000 },
      )
    : run('ps', ['-o', 'ppid=', '-p', String(Number(pid))], { timeout: 5_000 });
  const ppid = Number.parseInt((r.out ?? '').trim(), 10);
  return r.ok && ppid > 1 ? ppid : null;
}

/** One of our services: a known signature, or a command run from this checkout. */
const ourService = (cmd) => !!cmd && (isOurs(cmd) || cmd.includes(ROOT));

/**
 * Stop services still holding our ports after their launcher died: the
 * recorded PIDs were wrappers, and the real servers (node, uvicorn, bun)
 * outlive them on Windows. Only a process whose command line shows it is
 * ours is touched, and the stop climbs to the highest ancestor that is
 * still ours (uvicorn's reloader, tsx watch) so nothing respawns it.
 */
export function reapPorts(ports) {
  let reaped = 0;
  for (const port of ports) {
    const pid = listenerOf(port);
    if (!pid || pid === process.pid || !ourService(commandLineOf(pid))) continue;
    let top = pid;
    for (let p = parentOf(top), hops = 0; p && hops < 6; p = parentOf(p), hops++) {
      if (p === process.pid || p === process.ppid || !ourService(commandLineOf(p))) break;
      top = p;
    }
    if (IS_WIN) run('taskkill', ['/pid', String(top), '/T', '/F']);
    else {
      try {
        process.kill(top, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    reaped++;
  }
  return reaped;
}

/** The service ports `pnpm start` uses, from the environment. */
export function servicePorts(env = process.env) {
  return [
    Number(env.ANCILE_PORT ?? 7700),
    Number(env.COCKPIT_PORT ?? 7701),
    Number(env.KNOWLEDGE_PORT ?? 7710),
    Number(env.CONTROLLER_PORT ?? 7720),
    Number(env.AGENT_ENGINE_PORT ?? 7730),
  ];
}

export async function stopPostgres() {
  const pg0 = exe('pg0');
  if (!existsSync(pg0)) return false;
  return run(pg0, ['stop', '--name', PG_INSTANCE], { timeout: 60_000 }).ok;
}

/**
 * The environment every service gets: .env (if any) over generated
 * secrets over defaults, plus DATABASE_URL derived from the runtime.
 */
export const PROFILE_FILE = join(RUNTIME_DIR, 'profile');

/** The test profile's ports: the everyday ones plus 100. */
export const E2E_PORTS = {
  ANCILE_PORT: '7800',
  COCKPIT_PORT: '7801',
  KNOWLEDGE_PORT: '7810',
  CONTROLLER_PORT: '7820',
  AGENT_ENGINE_PORT: '7830',
};

export function composeEnv(fileEnv) {
  const secrets = runtimeSecrets();
  const env = {
    POSTGRES_USER: 'ancile',
    POSTGRES_DB: 'ancile',
    POSTGRES_PORT: '5433',
    ANCILE_DATA_DIR: 'data',
    // The offline test model, so a fresh install answers before any key is
    // added. It says what it is in every reply; set to 0 to hide it.
    ANCILE_OFFLINE_MODELS: '1',
    ...secrets,
    ...Object.fromEntries(Object.entries(fileEnv).filter(([, v]) => v !== '')),
  };
  // `pnpm start:e2e`: the same Postgres server, but its own database and data
  // folder, so test runs never leave threads or approvals in your workspace.
  // The cluster itself stays in the main data folder: one server, two databases.
  if ((process.env.ANCILE_PROFILE ?? env.ANCILE_PROFILE) === 'e2e') {
    env.ANCILE_PROFILE = 'e2e';
    // The test stack drives sample GPU nodes; a real install never sees them.
    env.CONTROLLER_PROVIDER ??= 'fake';
    // Its own ports (+100), so the test stack runs beside your everyday one.
    Object.assign(env, E2E_PORTS);
    env.ANCILE_PG_DIR = resolve(ROOT, env.ANCILE_DATA_DIR, 'pg');
    env.POSTGRES_DB = 'ancile_e2e';
    env.ANCILE_DATA_DIR = join(env.ANCILE_DATA_DIR, 'e2e');
    if (env.DATABASE_URL) {
      const u = new URL(env.DATABASE_URL);
      u.pathname = '/ancile_e2e';
      env.DATABASE_URL = u.toString();
    }
  }
  // Every URL between services follows the ports, so a profile on other
  // ports talks only to itself.
  env.ANCILE_PORT ??= '7700';
  env.COCKPIT_PORT ??= '7701';
  env.KNOWLEDGE_PORT ??= '7710';
  env.CONTROLLER_PORT ??= '7720';
  env.AGENT_ENGINE_PORT ??= '7730';
  if (env.ANCILE_PROFILE === 'e2e' || !fileEnv.KNOWLEDGE_URL)
    env.KNOWLEDGE_URL = `http://localhost:${env.KNOWLEDGE_PORT}`;
  if (env.ANCILE_PROFILE === 'e2e' || !fileEnv.CONTROLLER_URL)
    env.CONTROLLER_URL = `http://localhost:${env.CONTROLLER_PORT}`;
  if (env.ANCILE_PROFILE === 'e2e' || !fileEnv.AGENT_ENGINE_URL)
    env.AGENT_ENGINE_URL = `http://localhost:${env.AGENT_ENGINE_PORT}`;
  if (env.ANCILE_PROFILE === 'e2e' || !fileEnv.CORE_INTERNAL_URL)
    env.CORE_INTERNAL_URL = `http://localhost:${env.ANCILE_PORT}/internal/v1`;
  if (env.ANCILE_PROFILE === 'e2e' || !fileEnv.ANCILE_PUBLIC_URL)
    env.ANCILE_PUBLIC_URL = `http://localhost:${env.ANCILE_PORT}`;
  env.ANCILE_CORE_URL = `http://localhost:${env.ANCILE_PORT}`;
  if (env.COCKPIT_PORT !== '7701') {
    const extra = [`http://localhost:${env.COCKPIT_PORT}`, `http://127.0.0.1:${env.COCKPIT_PORT}`];
    env.ANCILE_ALLOWED_ORIGINS = [env.ANCILE_ALLOWED_ORIGINS, ...extra].filter(Boolean).join(',');
  }
  env.DATABASE_URL ??= `postgres://${env.POSTGRES_USER}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;
  // Services start in their own package directory (pnpm --filter, uv
  // --project), so every path they are given is made absolute against the
  // repository root. The desktop app does the same against AppData.
  const abs = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));
  env.ANCILE_DATA_DIR = abs(env.ANCILE_DATA_DIR);
  env.ANCILE_CONFIG_DIR = abs(env.ANCILE_CONFIG_DIR ?? 'config');
  env.ANCILE_PROMPTS_DIR = abs(env.ANCILE_PROMPTS_DIR ?? 'prompts');
  env.KNOWLEDGE_MODEL_CACHE = abs(env.KNOWLEDGE_MODEL_CACHE || join(env.ANCILE_DATA_DIR, 'models'));
  if (env.KNOWLEDGE_DATA_DIR) env.KNOWLEDGE_DATA_DIR = abs(env.KNOWLEDGE_DATA_DIR);
  // Python block-buffers stdout when it is a pipe, which held Knowledge's
  // structured logs back until the buffer filled. Logs must be live.
  env.PYTHONUNBUFFERED = '1';
  // Windows consoles default Python to the legacy "charmap" encoding, and
  // the notebook worker crashed printing a ✅. UTF-8 everywhere.
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  // The notebook engine is reached only through Core, never from a browser.
  env.CORS_ORIGINS ??= env.ANCILE_PUBLIC_URL ?? 'http://localhost:7700';
  return env;
}
