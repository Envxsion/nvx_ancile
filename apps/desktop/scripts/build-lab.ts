#!/usr/bin/env bun
/**
 * ------------------------------------------------------------------
 *  Title    |  The lab's engine as one binary
 *  Ref      |  vendor/opencode/PATCHES.md, packages/opencode/script/build.ts
 *  ID       |  desktop
 * ------------------------------------------------------------------
 *  Purpose  |  Compile the vendored agent engine (opencode, unchanged)
 *           |  for this machine into sidecars/lab/ancile-lab[.exe], so
 *           |  the desktop app runs the lab without Bun installed.
 *  How      |  The same Bun.build call as upstream's build script,
 *           |  for the current platform only, without the web UI the
 *           |  app switches off (OPENCODE_DISABLE_EMBEDDED_WEB_UI) and
 *           |  without upstream's release bookkeeping (it reads
 *           |  .github/ files the vendored copy does not carry).
 *           |  bun scripts/build-lab.ts   (Bun 1.3.14 or later)
 *  Note     |  models.dev is fetched once at build time, as upstream
 *           |  does; MODELS_DEV_API_JSON=<file> builds offline.
 * ------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const ENGINE = join(ROOT, 'vendor', 'opencode', 'packages', 'opencode');
const OUT = join(import.meta.dir, '..', 'src-tauri', 'sidecars', 'lab');
const IS_WIN = process.platform === 'win32';
const exe = IS_WIN ? 'ancile-lab.exe' : 'ancile-lab';

const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};
const resolveIn = (spec: string) => Bun.resolveSync(spec, ENGINE);
const { createSolidTransformPlugin } = (await import(resolveIn('@opentui/solid/bun-plugin'))) as {
  createSolidTransformPlugin: () => import('bun').BunPlugin;
};

const modelsData = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  : await fetch('https://models.dev/api.json').then((r) => {
      if (!r.ok) throw new Error(`models.dev answered ${r.status}`);
      return r.text();
    });
const treeSitterWorker = await Bun.file(resolveIn('@opentui/core/parser.worker')).text();

const os = IS_WIN ? 'windows' : process.platform;
const target = `bun-${os}-${process.arch}` as const;
const workerPath = './src/cli/tui/worker.ts';
const treeSitterWorkerPath = 'opentui-tree-sitter-worker.js';
const bunfsRoot = IS_WIN ? 'B:/~BUN/root/' : '/$bunfs/root/';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.chdir(ENGINE);
console.log(`Lab: compiling opencode ${pkg.version} for ${target}`);
const result = await Bun.build({
  conditions: ['bun', 'node'],
  tsconfig: './tsconfig.json',
  plugins: [createSolidTransformPlugin()],
  external: ['node-gyp'],
  format: 'esm',
  minify: true,
  sourcemap: 'none',
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: target as never,
    outfile: join(OUT, exe),
    execArgv: [`--user-agent=nvx-ancile-lab/${pkg.version}`, '--use-system-ca', '--'],
    windows: {},
  },
  files: { [treeSitterWorkerPath]: treeSitterWorker },
  entrypoints: ['./src/index.ts', workerPath, treeSitterWorkerPath],
  define: {
    FFF_LIBC: JSON.stringify('gnu'),
    OPENCODE_VERSION: `'${pkg.version}'`,
    OPENCODE_MODELS_DEV: modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'ancile'`,
    OPENCODE_LIBC: process.platform === 'linux' ? `'glibc'` : '',
    ...(process.platform === 'linux' ? { 'process.env.OPENTUI_LIBC': JSON.stringify('glibc') } : {}),
  },
});
if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
const bin = join(OUT, exe);
if (!existsSync(bin)) throw new Error(`no binary at ${bin}`);
if (process.platform === 'darwin') Bun.spawnSync(['codesign', '--force', '--sign', '-', bin]);
const version = Bun.spawnSync([bin, '--version']);
if (version.exitCode !== 0) {
  console.error(`Lab: the binary did not start: ${version.stderr.toString()}`);
  process.exit(1);
}
console.log(`Lab: ${exe} ${version.stdout.toString().trim()}`);
