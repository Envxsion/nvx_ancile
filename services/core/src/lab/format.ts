/**
 * ------------------------------------------------------------------
 *  Title    |  Format on edit for the lab
 *  Ref      |  ROADMAP LB3 · docs/lab.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep the files a lab run edited in the project's own
 *           |  style: find the formatter the project uses, run it on
 *           |  the edited files only, and say which one did it
 *           |  ("formatted by Biome").
 *  How      |  detectFormatter() reads the project's config files
 *           |  (Biome, Prettier, Ruff, Black, gofmt, rustfmt, in that
 *           |  order of preference). formatEdited() runs one command
 *           |  with the file list as arguments, no shell, only on
 *           |  files that formatter handles, inside the folder, and
 *           |  not through a link. Each run is one child process
 *           |  with a timeout.
 *  Note     |  A formatter that is missing, fails or times out is
 *           |  reported and never blocks or undoes the edit. The run
 *           |  itself is asked of the permission gate by the caller
 *           |  (handler.ts), as a shell command, on the real command.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { confineRead } from '../files/confine';

const run = promisify(execFile);

export type FormatterId = 'biome' | 'prettier' | 'ruff' | 'black' | 'gofmt' | 'rustfmt';

export const FORMATTER_NAMES: Record<FormatterId, string> = {
  biome: 'Biome',
  prettier: 'Prettier',
  ruff: 'Ruff',
  black: 'Black',
  gofmt: 'gofmt',
  rustfmt: 'rustfmt',
};

const EXTENSIONS: Record<FormatterId, string[]> = {
  biome: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.jsonc', '.css'],
  prettier: [
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.json',
    '.css',
    '.scss',
    '.html',
    '.md',
    '.mdx',
    '.yaml',
    '.yml',
    '.vue',
  ],
  ruff: ['.py', '.pyi'],
  black: ['.py', '.pyi'],
  gofmt: ['.go'],
  rustfmt: ['.rs'],
};

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const any = async (dir: string, names: string[]) => {
  for (const n of names) if (await exists(join(dir, n))) return true;
  return false;
};

async function text(file: string): Promise<string> {
  return readFile(file, 'utf8').catch(() => '');
}

/**
 * The formatter a folder uses, from its own config files, or null. Looks in
 * `dir` and then each parent up to `stopAt` (the repository root, when known).
 */
export async function detectFormatter(dir: string, stopAt?: string): Promise<FormatterId | null> {
  let cur = resolve(dir);
  const top = stopAt ? resolve(stopAt) : cur;
  for (;;) {
    if (await any(cur, ['biome.json', 'biome.jsonc'])) return 'biome';
    const pkg = await text(join(cur, 'package.json'));
    if (
      (await any(cur, [
        '.prettierrc',
        '.prettierrc.json',
        '.prettierrc.yaml',
        '.prettierrc.yml',
        '.prettierrc.js',
        '.prettierrc.cjs',
        '.prettierrc.mjs',
        '.prettierrc.toml',
        'prettier.config.js',
        'prettier.config.cjs',
        'prettier.config.mjs',
        'prettier.config.ts',
      ])) ||
      /"prettier"\s*:/.test(pkg)
    )
      return 'prettier';
    const pyproject = await text(join(cur, 'pyproject.toml'));
    if ((await any(cur, ['ruff.toml', '.ruff.toml'])) || /^\[tool\.ruff[\].]/m.test(pyproject)) return 'ruff';
    if (/^\[tool\.black\]/m.test(pyproject)) return 'black';
    if (await exists(join(cur, 'go.mod'))) return 'gofmt';
    if ((await any(cur, ['rustfmt.toml', '.rustfmt.toml'])) || (await exists(join(cur, 'Cargo.toml'))))
      return 'rustfmt';
    if (cur === top) return null;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

export interface FormatCommand {
  formatter: FormatterId;
  file: string;
  args: string[];
  /** For the permission check and the step: the command as one line. */
  line: string;
}

/** A project-local JS tool: node_modules/.bin entry resolved to the script node runs. */
async function localBin(dir: string, stopAt: string, name: string, pkg: string): Promise<string | null> {
  let cur = resolve(dir);
  const top = resolve(stopAt);
  for (;;) {
    const manifest = join(cur, 'node_modules', pkg, 'package.json');
    if (await exists(manifest)) {
      try {
        const j = JSON.parse(await readFile(manifest, 'utf8')) as { bin?: string | Record<string, string> };
        const rel = typeof j.bin === 'string' ? j.bin : j.bin?.[name];
        if (rel) return join(cur, 'node_modules', pkg, rel);
      } catch {
        // an unreadable manifest: treat the tool as missing
      }
    }
    if (cur === top) return null;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** The command for a formatter over `files` (relative to `cwd`), or null when it cannot be found. */
export async function commandFor(
  formatter: FormatterId,
  files: string[],
  cwd: string,
  stopAt: string = cwd,
): Promise<{ file: string; args: string[]; line: string } | null> {
  switch (formatter) {
    case 'biome': {
      const bin = await localBin(cwd, stopAt, 'biome', '@biomejs/biome');
      return bin
        ? {
            file: process.execPath,
            args: [bin, 'format', '--write', ...files],
            line: `biome format --write ${files.join(' ')}`,
          }
        : null;
    }
    case 'prettier': {
      const bin = await localBin(cwd, stopAt, 'prettier', 'prettier');
      return bin
        ? {
            file: process.execPath,
            args: [bin, '--write', ...files],
            line: `prettier --write ${files.join(' ')}`,
          }
        : null;
    }
    case 'ruff':
      return { file: 'ruff', args: ['format', ...files], line: `ruff format ${files.join(' ')}` };
    case 'black':
      return { file: 'black', args: ['-q', ...files], line: `black -q ${files.join(' ')}` };
    case 'gofmt':
      return { file: 'gofmt', args: ['-w', ...files], line: `gofmt -w ${files.join(' ')}` };
    case 'rustfmt':
      return {
        file: 'rustfmt',
        args: ['--edition', '2021', ...files],
        line: `rustfmt --edition 2021 ${files.join(' ')}`,
      };
  }
}

export type FormatOutcome =
  | { status: 'formatted'; formatter: FormatterId; name: string; files: string[]; note: string }
  | { status: 'none'; note: string }
  | { status: 'skipped'; formatter: FormatterId; name: string; note: string }
  | { status: 'failed'; formatter: FormatterId; name: string; note: string };

export interface FormatDeps {
  /** Ask whether this command may run (permission gate, as shell.exec). */
  allow?: (line: string) => Promise<boolean>;
  /** Run a command; replaced in tests. */
  exec?: (file: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<unknown>;
  timeoutMs?: number;
}

/**
 * Format the files a run edited. `edited` are paths relative to `dir`. Only
 * files the detected formatter handles, that are regular files inside `dir`,
 * are passed to it. Never throws: a problem comes back as `failed` or `skipped`.
 */
export async function formatEdited(
  dir: string,
  edited: string[],
  opts: { repoRoot?: string } & FormatDeps = {},
): Promise<FormatOutcome> {
  const stopAt = opts.repoRoot ?? dir;
  let formatter: FormatterId | null;
  try {
    formatter = await detectFormatter(dir, stopAt);
  } catch {
    formatter = null;
  }
  if (!formatter) return { status: 'none', note: 'No formatter found for this project.' };
  const name = FORMATTER_NAMES[formatter];
  const handles = EXTENSIONS[formatter];
  const files: string[] = [];
  for (const f of edited) {
    if (!handles.includes(extname(f).toLowerCase())) continue;
    if (/^-|\0/.test(f)) continue; // never an option, never a NUL
    try {
      await confineRead(f, [dir]); // a regular path inside the folder, not through a link out
      if (await exists(join(dir, f))) files.push(f);
    } catch {
      // a link that leaves the folder, or a file the run deleted: not formatted
    }
  }
  if (!files.length)
    return { status: 'none', note: `${name} has nothing to format in the files that changed.` };
  const cmd = await commandFor(formatter, files, dir, stopAt);
  if (!cmd)
    return {
      status: 'failed',
      formatter,
      name,
      note: `${name} is not installed for this project, so the files were left as they were.`,
    };
  if (opts.allow && !(await opts.allow(cmd.line).catch(() => false)))
    return {
      status: 'skipped',
      formatter,
      name,
      note: `${name} was not run: running it needs your permission. Allow the command "${cmd.line.split(' ')[0]}" under Permissions to format on edit.`,
    };
  try {
    await (opts.exec ?? ((f, a, o) => run(f, a, { ...o, windowsHide: true })))(cmd.file, cmd.args, {
      cwd: dir,
      timeout: opts.timeoutMs ?? 30_000,
    });
    return { status: 'formatted', formatter, name, files, note: `Formatted by ${name}.` };
  } catch (err) {
    const e = err as { code?: string | number; killed?: boolean; stderr?: string };
    const why = e.killed
      ? 'it took too long'
      : e.code === 'ENOENT'
        ? 'it is not installed'
        : 'it reported an error';
    return {
      status: 'failed',
      formatter,
      name,
      note: `${name} could not format the files because ${why}. The edit is unchanged.`,
    };
  }
}
