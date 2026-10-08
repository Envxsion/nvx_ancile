/**
 * ------------------------------------------------------------------
 *  Title    |  Diagnostic checks
 *  Ref      |  DESIGN.md §14 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Everything worth checking, each with the fix to show.
 *  How      |  Built from Core's own parts (database, supervisor
 *           |  probes, model registry, memory, secrets), so the check
 *           |  is the same code path the app uses. The boot suite runs
 *           |  as one more check when Core runs from source.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { MIGRATIONS_DIR } from '../db/migrate';
import { canChat, type ModelRegistry } from '../gateway/registry';
import type { Probe } from '../health/supervisor';
import type { SecretBox } from '../secrets';
import type { CheckOutcome, CheckSpec } from './runner';

const run = promisify(execFile);

export interface CheckDeps {
  sql?: Sql;
  probes?: Probe[];
  registry?: ModelRegistry;
  memoryCheck?: () => Promise<{ ok: boolean; problems: string[] }>;
  box?: SecretBox;
  dataDir: string;
  serviceToken?: string;
  /** Core's package directory, when running from a source checkout (enables the boot suite). */
  sourceDir?: string | null;
  bindHost?: string;
  passphraseSet?: boolean;
}

const ok = (detail?: string): CheckOutcome => ({ status: 'passed', ...(detail && { detail }) });
const warn = (detail: string, fix?: string): CheckOutcome => ({
  status: 'warned',
  detail,
  ...(fix && { fix }),
});
const fail = (detail: string, fix?: string): CheckOutcome => ({
  status: 'failed',
  detail,
  ...(fix && { fix }),
});

const gb = (bytes: number) =>
  bytes < 1e9 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : `${(bytes / 1e9).toFixed(1)} GB`;

export function buildChecks(d: CheckDeps): CheckSpec[] {
  const checks: CheckSpec[] = [];
  const sql = d.sql;

  if (sql) {
    checks.push(
      {
        id: 'db.reachable',
        group: 'data',
        title: 'Database answers',
        fix: 'Restart NVX Ancile (`pnpm start`), which starts the embedded database.',
        run: async () => {
          const [r] = await sql<{ v: string }[]>`select current_setting('server_version') as v`;
          return ok(`PostgreSQL ${r?.v ?? ''}`.trim());
        },
      },
      {
        id: 'db.pgvector',
        group: 'data',
        title: 'Vector search is installed',
        fix: 'The pgvector extension is missing. Run `pnpm start` again; it installs it.',
        run: async () => {
          const rows = await sql<
            { v: string }[]
          >`select extversion as v from pg_extension where extname = 'vector'`;
          return rows[0] ? ok(`pgvector ${rows[0].v}`) : fail('pgvector is not installed in this database.');
        },
      },
      {
        id: 'db.migrations',
        group: 'data',
        title: 'Database is up to date',
        fix: 'Restart Core: it applies missing migrations when it starts.',
        run: async () => {
          const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
          const applied = new Set(
            (await sql<{ name: string }[]>`select name from core._migrations`).map((r) => r.name),
          );
          const missing = files.filter((f) => !applied.has(f));
          return missing.length
            ? fail(`Not applied: ${missing.join(', ')}.`)
            : ok(`${files.length} migrations applied`);
        },
      },
      {
        id: 'db.size',
        group: 'data',
        title: 'Database size',
        run: async () => {
          const [r] = await sql<{ n: string }[]>`select pg_database_size(current_database())::text as n`;
          const n = Number(r?.n ?? 0);
          return n > 20e9
            ? warn(`${gb(n)} on disk.`, 'Lower log and span retention, or archive old notebooks.')
            : ok(gb(n));
        },
      },
      {
        id: 'system.clock',
        group: 'system',
        title: 'Clocks agree',
        fix: 'Turn on automatic time on this computer. Traces and expiry times depend on it.',
        run: async () => {
          const [r] = await sql<{ now: Date }[]>`select now() as now`;
          const skew = Math.abs((r?.now.getTime() ?? Date.now()) - Date.now());
          return skew > 2_000 ? warn(`The database clock is ${Math.round(skew / 1000)} s off.`) : ok();
        },
      },
    );
  }

  for (const p of d.probes ?? []) {
    if (p.service === 'postgres' || p.service === 'disk') continue;
    checks.push({
      id: `service.${p.service}`,
      group: 'services',
      title: `${p.service[0]?.toUpperCase()}${p.service.slice(1)} answers`,
      fix: p.remediation,
      run: async (signal) => {
        await p.check(signal);
        return ok();
      },
    });
  }

  if (d.registry) {
    const registry = d.registry;
    checks.push({
      id: 'models.chat',
      group: 'models',
      title: 'A chat model is ready',
      fix: 'Add a provider key in Settings → Models, or start Ollama.',
      run: async () => {
        const ready = registry.all().filter((m) => canChat(m) && registry.status(m) === 'ready');
        return ready.length
          ? ok(
              ready
                .map((m) => m.display_name)
                .slice(0, 6)
                .join(', ') + (ready.length > 6 ? ` and ${ready.length - 6} more` : ''),
            )
          : fail('No chat model can answer right now.');
      },
    });
    checks.push({
      id: 'models.configured',
      group: 'models',
      title: 'Every enabled model is usable',
      run: async () => {
        const broken = registry
          .all()
          .filter((m) => registry.enabled(m) && registry.status(m) !== 'ready')
          .map((m) => `${m.display_name} (${registry.status(m).replace(/_/g, ' ')})`);
        return broken.length
          ? warn(
              `Not usable: ${broken.join(', ')}.`,
              'Add the missing keys in Settings → Models, or turn those models off.',
            )
          : ok();
      },
    });
  }

  if (d.memoryCheck) {
    const check = d.memoryCheck;
    checks.push({
      id: 'memory.integrity',
      group: 'memory',
      title: 'Memory files are intact',
      fix: 'Open Admin → Memory → History and revert the last change, or run `git fsck` in data/memory.',
      run: async () => {
        const r = await check();
        return r.ok ? ok(r.problems.length ? r.problems.join(' ') : undefined) : fail(r.problems.join(' '));
      },
    });
  }
  checks.push({
    id: 'memory.git',
    group: 'memory',
    title: 'Git is installed',
    fix: 'Install Git (https://git-scm.com): memory keeps its history with it.',
    run: async () => {
      const { stdout } = await run('git', ['--version'], { timeout: 10_000 });
      return ok(stdout.trim());
    },
  });

  if (d.box) {
    const box = d.box;
    checks.push({
      id: 'security.secrets',
      group: 'security',
      title: 'Stored keys can be read',
      fix: 'ANCILE_SECRET_KEY changed since the keys were saved. Put the old value back, or enter the keys again.',
      run: async () => {
        const probe = `diag-${Date.now()}`;
        return box.open('diagnostic', box.seal('diagnostic', probe)) === probe
          ? ok()
          : fail('Round trip failed.');
      },
    });
  }
  checks.push({
    id: 'security.exposure',
    group: 'security',
    title: 'Not open to the network without a passphrase',
    run: async () => {
      const host = d.bindHost ?? '127.0.0.1';
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
      if (loopback) return ok('Only this computer can reach Core.');
      return d.passphraseSet
        ? ok(`Listening on ${host}, behind a passphrase.`)
        : fail(
            `Core listens on ${host} without a passphrase.`,
            'Set a passphrase in Settings, or bind to 127.0.0.1.',
          );
    },
  });
  if (d.serviceToken !== undefined) {
    const token = d.serviceToken;
    checks.push({
      id: 'security.service_token',
      group: 'security',
      title: 'Service token is strong',
      run: async () =>
        token.length >= 32
          ? ok()
          : fail(
              'ANCILE_SERVICE_TOKEN is shorter than 32 characters.',
              'Leave it blank in .env to have one generated.',
            ),
    });
  }

  checks.push(
    {
      id: 'system.disk',
      group: 'system',
      title: 'Disk space',
      fix: 'Free space on the drive that holds the data folder.',
      run: async () => {
        const s = await statfs(resolve(d.dataDir));
        const free = s.bavail * s.bsize;
        if (free < 2e9) return fail(`${gb(free)} free.`);
        if (free < 10e9)
          return warn(`${gb(free)} free.`, 'Free some space soon: sources and models need room.');
        return ok(`${gb(free)} free`);
      },
    },
    {
      id: 'system.node',
      group: 'system',
      title: 'Node.js version',
      run: async () => {
        const major = Number(process.versions.node.split('.')[0]);
        return major >= 22
          ? ok(`Node ${process.versions.node}`)
          : fail(`Node ${process.versions.node}.`, 'Install Node 22 or newer.');
      },
    },
  );

  if (d.sourceDir) {
    const dir = d.sourceDir;
    checks.push({
      id: 'system.boot_suite',
      group: 'system',
      title: 'Boot tests',
      timeoutMs: 120_000,
      fix: 'Run `pnpm start` in a terminal: it prints each failing boot test with its fix.',
      run: async () => {
        try {
          const shell = process.platform === 'win32';
          await run(shell ? 'npx.cmd' : 'npx', ['vitest', 'run', '--project', 'boot', '--reporter', 'dot'], {
            cwd: dir,
            timeout: 120_000,
            env: { ...process.env, ANCILE_BOOT: '1' },
            shell,
          });
          return ok('All boot tests pass.');
        } catch (err) {
          const out = `${(err as { stdout?: string }).stdout ?? ''}`
            // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
            .replace(/\x1b\[[0-9;]*m/g, '');
          const fixes = [...out.matchAll(/\|\s*fix:\s*(.+)$/gim)].map((m) => m[1]?.trim()).filter(Boolean);
          return fail(
            fixes.length
              ? `${fixes.length} boot ${fixes.length === 1 ? 'test fails' : 'tests fail'}.`
              : 'The boot suite failed.',
            fixes.length ? fixes.join(' ') : undefined,
          );
        }
      },
    });
  }

  return checks;
}
