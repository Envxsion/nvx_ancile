#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  Generate secrets for .env
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Prints fresh random values for every secret .env needs.
 *  How      |  `node scripts/gen-keys.mjs` prints them; `--write` fills
 *           |  any that are empty in .env and leaves set ones alone.
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { c, mark, ROOT } from './lib.mjs';

const KEYS = {
  ANCILE_SECRET_KEY: () => randomBytes(32).toString('base64'),
  ANCILE_SERVICE_TOKEN: () => randomBytes(32).toString('base64url'),
  CONTROLLER_TOKEN: () => randomBytes(32).toString('base64url'),
  CONTROLLER_NODE_TOKEN: () => randomBytes(32).toString('base64url'),
  POSTGRES_PASSWORD: () => randomBytes(18).toString('base64url'),
};

const values = Object.fromEntries(Object.entries(KEYS).map(([k, gen]) => [k, gen()]));

if (!process.argv.includes('--write')) {
  for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
  console.log(c.dim('\nPaste these into .env, or run with --write to fill empty ones automatically.'));
  console.log(c.dim('If you change POSTGRES_PASSWORD after the database exists, update DATABASE_URL too.'));
  process.exit(0);
}

const envPath = join(ROOT, '.env');
if (!existsSync(envPath)) copyFileSync(join(ROOT, '.env.example'), envPath);
let text = readFileSync(envPath, 'utf8');
const filled = [];
for (const [k, v] of Object.entries(values)) {
  const re = new RegExp(`^${k}=\\s*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, `${k}=${v}`);
    filled.push(k);
    if (k === 'POSTGRES_PASSWORD') {
      text = text.replace(/^DATABASE_URL=postgres:\/\/([^:]+):[^@]*@/m, `DATABASE_URL=postgres://$1:${v}@`);
    }
  }
}
writeFileSync(envPath, text);
console.log(
  filled.length
    ? `${mark.ok} Filled ${filled.join(', ')} in .env`
    : `${mark.ok} Every key was already set. Nothing changed.`,
);
