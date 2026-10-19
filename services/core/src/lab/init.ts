/**
 * ------------------------------------------------------------------
 *  Title    |  /init: a starter AGENTS.md
 *  Ref      |  ROADMAP LB2 · docs/notebooks.md (The coding lab and your project)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Draft an AGENTS.md for a repository from what can be
 *           |  seen in it: the commands in its package files, how its
 *           |  folders are laid out, and the conventions its config
 *           |  files state. The draft is only text.
 *  How      |  draftAgentsMd() reads a few known files inside the
 *           |  repository (through files/confine.ts, so a link out is
 *           |  not followed) and writes nothing. The person sees the
 *           |  draft, and saving it is the editor's ordinary file
 *           |  write: the permission gate decides it, the path is
 *           |  confined, and a file that already exists is never
 *           |  replaced (the save is refused as "changed" and a diff
 *           |  is offered instead).
 *  Note     |  Nothing here is guessed: a line appears only when a
 *           |  file says it.
 * ------------------------------------------------------------------
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { confineRead } from '../files/confine';
import { detectFormatter, FORMATTER_NAMES } from './format';

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.venv',
  '__pycache__',
  '.next',
  'coverage',
]);
const SCRIPT_ORDER = ['dev', 'start', 'build', 'test', 'typecheck', 'lint', 'format'];

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    const at = await confineRead(join(root, rel), [root]);
    return (await readFile(at.path, 'utf8')).slice(0, 200_000);
  } catch {
    return null;
  }
}

async function packageManager(root: string, pkg: { packageManager?: string } | null): Promise<string> {
  if (pkg?.packageManager) return pkg.packageManager.split('@')[0] ?? 'npm';
  if ((await readText(root, 'pnpm-lock.yaml')) !== null) return 'pnpm';
  if ((await readText(root, 'yarn.lock')) !== null) return 'yarn';
  if ((await readText(root, 'bun.lockb')) !== null || (await readText(root, 'bun.lock')) !== null)
    return 'bun';
  return 'npm';
}

async function topFolders(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** The starter file for the repository at `root`. */
export async function draftAgentsMd(root: string, name: string): Promise<string> {
  const lines: string[] = [
    `# ${name}`,
    '',
    'Instructions for AI agents working in this repository. Edit them to suit.',
    '',
  ];

  const commands: string[] = [];
  const pkgText = await readText(root, 'package.json');
  let pkg: { scripts?: Record<string, string>; packageManager?: string; workspaces?: unknown } | null = null;
  try {
    pkg = pkgText ? JSON.parse(pkgText) : null;
  } catch {
    pkg = null;
  }
  if (pkg?.scripts) {
    const pm = await packageManager(root, pkg);
    const run = pm === 'npm' ? 'npm run' : pm;
    const names = Object.keys(pkg.scripts);
    const ordered = [
      ...SCRIPT_ORDER.filter((s) => names.includes(s)),
      ...names.filter((s) => /^test:|^lint:/.test(s)),
    ];
    for (const s of ordered.slice(0, 10)) commands.push(`- \`${run} ${s}\`: \`${pkg.scripts[s]}\``);
  }
  const pyproject = await readText(root, 'pyproject.toml');
  if (pyproject) {
    if (/\[tool\.pytest/.test(pyproject) || (await readText(root, 'pytest.ini')) !== null)
      commands.push('- `pytest`: runs the Python tests');
    if (/\[tool\.ruff/.test(pyproject))
      commands.push('- `ruff check .` and `ruff format .`: lint and format Python');
    if ((await readText(root, 'uv.lock')) !== null) commands.push('- `uv sync`: install Python dependencies');
  }
  if ((await readText(root, 'Cargo.toml')) !== null)
    commands.push('- `cargo build`, `cargo test` and `cargo fmt`: build, test and format Rust');
  if ((await readText(root, 'go.mod')) !== null)
    commands.push('- `go build ./...`, `go test ./...` and `gofmt -w .`: build, test and format Go');
  const makefile = await readText(root, 'Makefile');
  if (makefile) {
    const targets = [...makefile.matchAll(/^([a-zA-Z][\w-]*):/gm)].map((m) => m[1]).slice(0, 6);
    if (targets.length) commands.push(`- \`make ${targets.join('`, `make ')}\`: targets in the Makefile`);
  }
  if (commands.length) lines.push('## Commands', '', ...commands, '');

  const folders = await topFolders(root);
  if (folders.length) lines.push('## Layout', '', ...folders.map((f) => `- \`${f}/\``), '');

  const conventions: string[] = [];
  const formatter = await detectFormatter(root, root).catch(() => null);
  if (formatter)
    conventions.push(`- Format code with ${FORMATTER_NAMES[formatter]} (the project has its config).`);
  const tsconfig = await readText(root, 'tsconfig.json');
  if (tsconfig && /"strict"\s*:\s*true/.test(tsconfig)) conventions.push('- TypeScript is in strict mode.');
  const editorconfig = await readText(root, '.editorconfig');
  if (editorconfig) {
    const indent = /indent_style\s*=\s*(\w+)/.exec(editorconfig)?.[1];
    const size = /indent_size\s*=\s*(\d+)/.exec(editorconfig)?.[1];
    if (indent)
      conventions.push(
        `- Indent with ${indent === 'tab' ? 'tabs' : `${size ?? ''} spaces`.replace('  ', ' ')} (.editorconfig).`,
      );
  }
  if ((await readText(root, 'CONTRIBUTING.md')) !== null)
    conventions.push('- Read CONTRIBUTING.md before changing behaviour.');
  if (conventions.length) lines.push('## Conventions', '', ...conventions, '');

  if (lines.length <= 4)
    lines.push(
      '## Notes',
      '',
      'No build commands or configuration were found to describe. Add what an agent needs to know.',
      '',
    );
  return `${lines.join('\n').trimEnd()}\n`;
}

export interface InitDraft {
  path: string;
  content: string;
  /** An AGENTS.md is already there: the draft is never written over it. */
  exists: boolean;
  existing_sha256: string | null;
  /** Existing against the draft, when there is one. */
  diff: string | null;
}

export async function initDraft(root: string, name: string, sha: (s: string) => string): Promise<InitDraft> {
  const path = join(root, 'AGENTS.md');
  const content = await draftAgentsMd(root, name);
  const existing = await readText(root, 'AGENTS.md');
  return {
    path,
    content,
    exists: existing !== null,
    existing_sha256: existing !== null ? sha(existing) : null,
    diff:
      existing !== null
        ? createTwoFilesPatch('AGENTS.md', 'AGENTS.md (draft)', existing, content, '', '', { context: 3 })
        : null,
  };
}
