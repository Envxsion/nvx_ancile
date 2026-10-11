#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop sidecars
 *  ID       |  desktop
 * ------------------------------------------------------------------
 *  Purpose  |  Build everything the desktop app runs into
 *           |  src-tauri/sidecars/, so the installer needs nothing on
 *           |  the person's machine: no Node, Python or Docker.
 *  How      |  pg0     the embedded Postgres + pgvector binary (pinned
 *           |          and checksummed by scripts/runtime.mjs).
 *           |  node    this machine's Node runtime (22.12 or later),
 *           |          shared by Core.
 *           |  core    Core bundled with esbuild (workspace packages
 *           |          inlined, npm packages external) next to its
 *           |          production node_modules from `pnpm deploy`,
 *           |          plus its SQL migrations.
 *           |  cockpit the Cockpit's production build, served by Core.
 *           |  share   config/, prompts/, memory-template/ and the
 *           |          database bootstrap SQL.
 *           |  knowledge  a python-build-standalone CPython 3.12 (uv's
 *           |          managed Python) with the locked dependencies
 *           |          (uv export --frozen) and ancile_knowledge
 *           |          installed into it, plus its Alembic migrations.
 *           |  models  (only with --with-models) the embedding and
 *           |          rerank models, so the first source needs no
 *           |          download.
 *           |  lab     the agent engine compiled to one binary
 *           |          (build-lab.ts, a pinned Bun from npm).
 *           |  controller  the Controller as one esbuild bundle (its
 *           |          npm packages inlined) plus its migrations.
 *  Note     |  Why not a Node single-executable for Core: SEA takes one
 *           |  CommonJS script and cannot load Core's WebAssembly
 *           |  policy engine or native-free ESM dependencies from disk
 *           |  without rewriting how they load. A bundled runtime plus
 *           |  an esbuild bundle works the same on every platform.
 *           |  The supervisor runs the lab and the Controller only
 *           |  when their folders exist, so a partial build still starts.
 * ------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const OUT = join(here, '..', 'src-tauri', 'sidecars');
const IS_WIN = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const only = [...args].filter((a) => !a.startsWith('--'));
const want = (part) => only.length === 0 || only.includes(part);
/** The Bun that compiles the lab (the engine's own build asks for 1.3.14 or later). */
const LAB_BUN = '1.3.14';

const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', shell: IS_WIN, cwd: ROOT, ...opts });

function fresh(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function size(path) {
  if (!existsSync(path)) return 0;
  const s = lstatSync(path);
  if (s.isSymbolicLink()) return 0;
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((n, f) => n + size(join(path, f)), 0);
}
/** Delete files whose names match, below a folder (never following links). */
function prune(dir, pattern) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) prune(p, pattern);
    else if (pattern.test(name) && !/^(license|licence|notice|copying)/i.test(name))
      rmSync(p, { force: true });
  }
}

/** The longest path below a folder, relative to it: installers on Windows stop at 260. */
function longest(dir, base = dir) {
  let max = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue;
    max = Math.max(max, s.isDirectory() ? longest(p, base) : p.length - base.length);
  }
  return max;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const report = [];
const done = (part) => report.push([part, mb(size(join(OUT, part)))]);

mkdirSync(OUT, { recursive: true });

// --- pg0 ----------------------------------------------------------------------
if (want('pg0')) {
  const { ensureBinary } = await import(pathToFileURL(join(ROOT, 'scripts', 'runtime.mjs')).href);
  const pg0 = await ensureBinary('pg0', (m) => console.log(`  ${m}`));
  cpSync(pg0, join(fresh(join(OUT, 'pg0')), IS_WIN ? 'pg0.exe' : 'pg0'));
  done('pg0');
}

// --- Node runtime -------------------------------------------------------------
if (want('node')) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error(`Node 22.12 or later is needed, this is ${process.version}`);
  cpSync(process.execPath, join(fresh(join(OUT, 'node')), IS_WIN ? 'node.exe' : 'node'));
  done('node');
}

// --- Core ---------------------------------------------------------------------
if (want('core')) {
  const dir = fresh(join(OUT, 'core'));
  console.log('Core: production dependencies (pnpm deploy)');
  // `pnpm deploy --prod` records "production only" in the workspace's own
  // install state, after which every pnpm command in this checkout tries to
  // reinstall without dev dependencies. Keep the workspace's state as it was.
  const state = join(ROOT, 'node_modules', '.pnpm-workspace-state-v1.json');
  const saved = existsSync(state) ? readFileSync(state) : null;
  try {
    // A flat (npm-style) node_modules: pnpm's nested store layout makes paths
    // longer than Windows installers can open (260 characters).
    sh('pnpm', [
      '--filter',
      '@nvx/ancile-core',
      'deploy',
      '--prod',
      '--legacy',
      '--config.node-linker=hoisted',
      dir,
    ]);
  } finally {
    if (saved) writeFileSync(state, saved);
  }
  // The deployed copy carries Core's TypeScript sources; the bundle replaces them.
  for (const f of ['src', 'test', 'tsconfig.json', 'vitest.config.ts', 'drizzle.config.ts'])
    rmSync(join(dir, f), { recursive: true, force: true });
  const esbuild = createRequire(import.meta.url)('esbuild');
  console.log('Core: bundle');
  await esbuild.build({
    entryPoints: [join(ROOT, 'services', 'core', 'src', 'main.ts')],
    outfile: join(dir, 'dist', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    logLevel: 'warning',
    // A release: only the licence keys built in are trusted, and the edition
    // is whatever was bundled here (services/core/src/build.ts).
    define: { __ANCILE_RELEASE__: 'true' },
    // CommonJS dependencies inside the ESM bundle still call require().
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    plugins: [
      {
        // Workspace packages ship TypeScript: inline them. npm packages stay
        // external and load from the deployed node_modules.
        name: 'externals',
        setup(b) {
          b.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (a) => {
            if (a.path.startsWith('@nvx/') || a.path.startsWith('node:')) return undefined;
            if (/^[a-z@]/i.test(a.path) && !a.path.includes(':')) return { path: a.path, external: true };
            return undefined;
          });
        },
      },
    ],
  });
  // The Pro edition: pro/ (the private submodule) becomes dist/pro.js, which
  // Core loads from beside itself. A free build (no pro/, or NVX_TIER=free at
  // build time) ships none of it.
  const proEntry = join(ROOT, 'pro', 'core', 'index.ts');
  if (existsSync(proEntry) && process.env.NVX_TIER !== 'free') {
    console.log('Core: bundle Pro');
    await esbuild.build({
      entryPoints: [proEntry],
      outfile: join(dir, 'dist', 'pro.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      minify: true,
      logLevel: 'warning',
      define: { __ANCILE_RELEASE__: 'true' },
    });
  } else console.log('Core: free edition (no Pro bundled)');
  cpSync(join(ROOT, 'services', 'core', 'src', 'db', 'migrations'), join(dir, 'dist', 'migrations'), {
    recursive: true,
  });
  // Nothing at run time reads type definitions, dependency source maps or docs.
  prune(join(dir, 'node_modules'), /\.(d\.ts|d\.mts|d\.cts|map|md|markdown)$/i);
  done('core');
}

// --- Cockpit ------------------------------------------------------------------
if (want('cockpit')) {
  console.log('Cockpit: production build');
  sh('pnpm', ['--filter', '@nvx/ancile-cockpit', 'build']);
  cpSync(join(ROOT, 'apps', 'cockpit', 'dist'), fresh(join(OUT, 'cockpit')), { recursive: true });
  done('cockpit');
}

// --- Controller ---------------------------------------------------------------
// GPU nodes. One self-contained bundle (its few npm packages inlined), run by
// the bundled Node, plus its SQL migrations, which it applies itself at start.
if (want('controller')) {
  const dir = fresh(join(OUT, 'controller'));
  const esbuild = createRequire(import.meta.url)('esbuild');
  console.log('Controller: bundle');
  await esbuild.build({
    entryPoints: [join(ROOT, 'services', 'controller', 'src', 'main.ts')],
    outfile: join(dir, 'dist', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    logLevel: 'warning',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
  cpSync(join(ROOT, 'services', 'controller', 'migrations'), join(dir, 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module", "private": true }\n');
  done('controller');
}

// --- Lab ----------------------------------------------------------------------
// The agent engine (vendor/opencode, unchanged) compiled to one binary by
// build-lab.ts with a pinned Bun, so nobody needs Bun installed. Its
// dependencies are a Bun workspace of their own, installed here if missing.
if (want('lab')) {
  const bun = ['-y', `bun@${LAB_BUN}`];
  const engine = join(ROOT, 'vendor', 'opencode');
  if (!existsSync(join(engine, 'node_modules'))) {
    console.log('Lab: engine dependencies (bun install)');
    sh('npx', [...bun, 'install', '--frozen-lockfile'], { cwd: engine });
  }
  sh('npx', [...bun, join(here, 'build-lab.ts')]);
  done('lab');
}

// --- Shared files -------------------------------------------------------------
if (want('share')) {
  const dir = fresh(join(OUT, 'share'));
  for (const d of ['config', 'prompts', 'memory-template'])
    cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  mkdirSync(join(dir, 'db'), { recursive: true });
  cpSync(join(ROOT, 'infra', 'db', 'init.sql'), join(dir, 'db', 'init.sql'));
  done('share');
}

// --- Knowledge ----------------------------------------------------------------
if (want('knowledge')) {
  const kn = join(ROOT, 'services', 'knowledge');
  const dir = fresh(join(OUT, 'knowledge'));
  console.log('Knowledge: standalone Python 3.12');
  sh('uv', ['python', 'install', '3.12']);
  const found = execFileSync('uv', ['python', 'find', '--managed-python', '3.12'], {
    encoding: 'utf8',
    shell: IS_WIN,
  })
    .trim()
    .split(/\r?\n/)
    .pop();
  // install_only layout: <root>/python.exe on Windows, <root>/bin/python3 elsewhere.
  const pyRoot = IS_WIN ? dirname(found) : dirname(dirname(found));
  const py = join(dir, 'python');
  cpSync(pyRoot, py, { recursive: true });
  const python = IS_WIN ? join(py, 'python.exe') : join(py, 'bin', 'python3');
  // uv-managed Pythons mark themselves externally managed; this copy is ours.
  const stdlibs = IS_WIN
    ? [join(py, 'Lib')]
    : readdirSync(join(py, 'lib'))
        .filter((d) => d.startsWith('python3'))
        .map((d) => join(py, 'lib', d));
  for (const lib of stdlibs) rmSync(join(lib, 'EXTERNALLY-MANAGED'), { force: true });
  console.log('Knowledge: locked dependencies');
  const req = join(dir, 'requirements.txt');
  sh(
    'uv',
    [
      'export',
      '--frozen',
      '--no-dev',
      '--no-hashes',
      '--extra',
      'embed',
      '--extra',
      'extract',
      '--no-emit-project',
      '-o',
      req,
    ],
    { cwd: kn },
  );
  sh('uv', ['pip', 'install', '--python', python, '-r', req]);
  sh('uv', ['pip', 'install', '--python', python, '--no-deps', kn]);
  // The working folder: Alembic's migrations, run before the server starts.
  const app = join(dir, 'app');
  mkdirSync(app, { recursive: true });
  cpSync(join(kn, 'alembic'), join(app, 'alembic'), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  });
  cpSync(join(kn, 'alembic.ini'), join(app, 'alembic.ini'));
  rmSync(req, { force: true });
  done('knowledge');
}

// --- Models (optional) --------------------------------------------------------
if (args.has('--with-models')) {
  const models = join(ROOT, 'data', 'models');
  if (!existsSync(models))
    throw new Error('No models in data/models yet: add one source in the dev stack first.');
  cpSync(models, fresh(join(OUT, 'models')), { recursive: true });
  done('models');
} else if (only.length === 0) {
  rmSync(join(OUT, 'models'), { recursive: true, force: true });
}

// Keep a record across partial rebuilds (`sidecars core` updates only core).
const manifestFile = join(OUT, 'MANIFEST.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
for (const [part, s] of report) manifest[part] = s;
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
const deepest = longest(OUT);
console.log(`Longest path inside sidecars: ${deepest} characters`);
if (deepest > 150)
  console.warn('Warning: Windows installers fail on paths over 260 characters once installed; shorten this.');
console.log('\nSidecars in src-tauri/sidecars:');
for (const [part, s] of report) console.log(`  ${part.padEnd(10)} ${s}`);
console.log(`  ${'total'.padEnd(10)} ${mb(size(OUT))}`);
