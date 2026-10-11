/** Builds dist/index.js once before the tests spawn it. */
import { build } from 'tsup';
import config from '../tsup.config';

export default async function setup() {
  const options = Array.isArray(config) ? config[0] : config;
  if (typeof options === 'function') throw new Error('tsup.config.ts should export an object');
  await build({ ...options, silent: true });
}
