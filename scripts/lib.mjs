/**
 * ------------------------------------------------------------------
 *  Title    |  Script helpers
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Shared by boot, doctor and gen-keys: .env parsing,
 *           |  process running, terminal styling in the family voice.
 *  Note     |  No dependencies on purpose: these run before `pnpm i`.
 * ------------------------------------------------------------------
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const IS_WIN = process.platform === 'win32';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  dim: paint('2'),
  bold: paint('1'),
  ok: paint('38;2;123;201;111'),
  warn: paint('38;2;216;161;60'),
  fail: paint('38;2;196;97;74'),
  signal: paint('38;2;157;134;255'),
  hue: (rgb) => paint(`38;2;${rgb.join(';')}`),
};

export const mark = {
  ok: c.ok('✓'),
  fail: c.fail('✗'),
  warn: c.warn('!'),
  step: c.signal('›'),
};

/** Minimal .env parser: KEY=VALUE, # comments, optional quotes. */
export function readEnv(file = join(ROOT, '.env')) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Run a command to completion, capturing output. */
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    shell: IS_WIN,
    timeout: opts.timeout ?? 300_000,
  });
  return {
    ok: res.status === 0,
    code: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    error: res.error,
  };
}

/** Is a command on PATH, and what version does it report? */
export function probe(cmd, args = ['--version']) {
  const r = run(cmd, args, { timeout: 20_000 });
  if (!r.ok) return null;
  return r.out.trim().split(/\r?\n/)[0];
}

/** Start a long-running child with prefixed, coloured output. */
export function startPrefixed(name, rgb, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    // isolated: the child sees only opts.env (the agent engine), never this process's environment.
    env: opts.isolated
      ? { FORCE_COLOR: '1', ...opts.env }
      : { ...process.env, FORCE_COLOR: '1', ...opts.env },
    shell: IS_WIN,
    // Own process group on POSIX so killTree can stop grandchildren too.
    detached: !IS_WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = c.hue(rgb)(name.padEnd(11));
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`${tag} ${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

/** Kill a child and its whole tree, on every platform. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Version compare for "22.17.1" style strings. */
export function atLeast(version, min) {
  const a = (version.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) > b[i]) return true;
    if ((a[i] ?? 0) < b[i]) return false;
  }
  return true;
}
