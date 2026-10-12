/**
 * ------------------------------------------------------------------
 *  Title    |  Database commands
 *  Ref      |  docs/runbooks/restore-backup.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The database from a terminal, the same way Core does it
 *           |  at start: `pnpm db:migrate` (back up, then update),
 *           |  `pnpm db:backups`, `pnpm db:backup`, `pnpm db:restore
 *           |  <name>`. Run through `pnpm` at the repository root so
 *           |  DATABASE_URL and ANCILE_DATA_DIR come from the same place
 *           |  `pnpm start` takes them.
 *  How      |  Errors print their title and hint, and exit 1. A
 *           |  database newer than this checkout exits 3 (as the desktop
 *           |  preflight does).
 * ------------------------------------------------------------------
 */

import { resolve } from 'node:path';
import { AncileError } from '@nvx/contracts';
import postgres from 'postgres';
import { formatBytes } from '../system/disk';
import { backupsDir, listBackups, restoreBackup, takeBackup } from './backup';
import { prepareDatabase } from './prepare';
import { controllerMigrationsDir, knowledgeVersionsDir, schemaState } from './version';

const [command = 'migrate', arg] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
const dataDir = resolve(process.env.ANCILE_DATA_DIR ?? './data');
const version = process.env.ANCILE_APP_VERSION ?? process.env.npm_package_version ?? '0.1.0';

if (!url) {
  console.error(
    'DATABASE_URL is not set. Run this through `pnpm` at the repository root, or set it in .env.',
  );
  process.exit(1);
}

const sql = postgres(url, { max: 2, onnotice: () => {} });
const knowledgeDir = knowledgeVersionsDir(process.env.ANCILE_KNOWLEDGE_MIGRATIONS_DIR);

async function run(): Promise<void> {
  switch (command) {
    case 'migrate': {
      const r = await prepareDatabase({
        sql,
        url: url as string,
        dataDir,
        appVersion: version,
        knowledgeDir,
        controllerDir: controllerMigrationsDir(process.env.ANCILE_CONTROLLER_MIGRATIONS_DIR),
        allowNewer: process.env.ANCILE_ALLOW_NEWER_DATABASE === '1',
      });
      if (r.backup && r.skipped !== 'recent') console.log(`Backed up to ${r.backup.path}`);
      console.log(r.applied.length ? `Applied ${r.applied.join(', ')}` : 'Database is up to date.');
      return;
    }
    case 'backups': {
      const all = await listBackups(dataDir);
      if (!all.length) console.log(`No backups yet in ${backupsDir(dataDir)}.`);
      for (const b of all)
        console.log(
          `${b.name}  ${formatBytes(b.bytes).padStart(8)}  ${b.reason}${b.app_version ? `  by ${b.app_version}` : ''}${b.core_schema ? `  at ${b.core_schema}` : ''}`,
        );
      return;
    }
    case 'backup': {
      const s = await schemaState(sql, { knowledgeDir });
      const b = await takeBackup({
        url: url as string,
        sql,
        dataDir,
        reason: 'manual',
        appVersion: version,
        coreSchema: s.current,
        knowledgeRevision: s.knowledge?.current ?? null,
      });
      console.log(`Backed up to ${b.path}`);
      return;
    }
    case 'restore': {
      if (!arg) {
        console.error('Name the backup to restore: `pnpm db:restore <name>` (see `pnpm db:backups`).');
        process.exitCode = 1;
        return;
      }
      const s = await schemaState(sql, { knowledgeDir });
      const { restored, safety } = await restoreBackup({
        url: url as string,
        sql,
        dataDir,
        name: arg,
        appVersion: version,
        coreSchema: s.current,
        knowledgeRevision: s.knowledge?.current ?? null,
      });
      console.log(`Restored ${restored.name}. What was there before is in ${safety.path}.`);
      return;
    }
    default:
      console.error(`Unknown command "${command}": use migrate, backups, backup or restore <name>.`);
      process.exitCode = 1;
  }
}

try {
  await run();
} catch (err) {
  if (err instanceof AncileError) {
    console.error(`${err.title}\n${err.detail ? `${err.detail}\n` : ''}What to do: ${err.hint}`);
    process.exitCode = err.code === 'system.database_newer' ? 3 : 1;
  } else throw err;
} finally {
  await sql.end({ timeout: 5 });
}
