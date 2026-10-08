#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  pnpm stop
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Stop everything `pnpm start` and `pnpm start:e2e`
 *           |  started: the services, including ones a killed launcher
 *           |  left behind, then embedded Postgres. `--e2e` stops only
 *           |  the test stack. Your data in data/ is untouched.
 * ------------------------------------------------------------------
 */

import { c, mark, readEnv } from './lib.mjs';
import { composeEnv, reapPorts, reapStale, servicePorts, stopPostgres } from './runtime.mjs';

/** Stop one profile's services, including any a killed launcher left behind. */
function stopServices(profile) {
  process.env.ANCILE_PROFILE = profile;
  return reapStale() + reapPorts(servicePorts(composeEnv(readEnv())));
}

// `pnpm stop:e2e` stops only the test stack: Postgres is shared and stays up.
const onlyE2e = process.argv.includes('--e2e');
const services = (onlyE2e ? 0 : stopServices('dev')) + stopServices('e2e');
if (services) console.log(`${mark.ok} Stopped ${services} running service${services === 1 ? '' : 's'}`);
if (onlyE2e) process.exit(0);

const pg = await stopPostgres();
console.log(
  pg
    ? `${mark.ok} Postgres stopped ${c.dim('(data kept in data/pg)')}`
    : `${mark.warn} Postgres was not running`,
);
