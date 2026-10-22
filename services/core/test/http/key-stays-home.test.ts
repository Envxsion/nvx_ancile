/**
 * The install key stays where it was made. It is never put in the process environment (every
 * child process Core starts copies that: the Claude bridge, MCP servers, git, the lab's tools, the
 * interpreter), never logged, and only a few files may even name it. A new file that reads the key
 * file, or an environment that holds the key, has to be added here on purpose, where a reviewer sees it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalKey, LocalAuth } from '../../src/http/localAuth';
import { redactText, registerSecret } from '../../src/obs/redact';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ROOT = join(import.meta.dirname, '../../../..');

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

describe('the install key', () => {
  it('is not put in the process environment by making it or by building the app around it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ancile-keyenv-'));
    dirs.push(dir);
    const before = { ...process.env };
    const { key } = await ensureLocalKey(dir);
    registerSecret(key);
    new LocalAuth({ key, port: 7700 });
    expect(Object.values(process.env)).not.toContain(key);
    expect(Object.values(process.env).some((v) => v?.includes(key))).toBe(false);
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
    // And a line that would print it into a log is cleaned.
    expect(redactText(`child env: KEY=${key}`)).not.toContain(key);
  });

  it('is named in a handful of files only: Core makes and checks it, the desktop shell reads it to pair', () => {
    // Every file that reads the key file or holds the key. A spawn site is never one of them.
    const allowed = new Set([
      'services/core/src/http/localAuth.ts',
      'services/core/src/http/guard.ts',
      'services/core/src/http/pairing.ts',
      'services/core/src/main.ts',
      'services/core/src/permissions/selfguard.ts',
      'services/core/src/system/startup.ts',
      'services/core/src/app.ts',
      'apps/desktop/src-tauri/src/core_api.rs',
    ]);
    const files = [
      ...walk(join(ROOT, 'services/core/src'), /\.ts$/),
      ...walk(join(ROOT, 'services/knowledge/ancile_knowledge'), /\.py$/),
      ...walk(join(ROOT, 'services/controller/src'), /\.ts$/),
      ...walk(join(ROOT, 'services/claude-bridge/src'), /\.ts$/),
      ...walk(join(ROOT, 'apps/desktop/src-tauri/src'), /\.rs$/),
    ];
    const naming = files
      .filter((f) =>
        /local-api\.key|LOCAL_KEY_FILE|ensureLocalKey|localKeyPath|localKey\b/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .sort();
    expect(
      naming.filter((f) => !allowed.has(f)),
      'a file reads or holds the install key that is not on the list',
    ).toEqual([]);
  });

  it('is in no spawn site’s environment: the places that start a process build theirs without it', () => {
    // Every file in Core that starts a process, and what it hands the child. None of them names the key.
    const spawns = walk(join(ROOT, 'services/core/src'), /\.ts$/).filter((f) =>
      /from 'node:child_process'|StdioClientTransport|new Worker\(/.test(readFileSync(f, 'utf8')),
    );
    expect(spawns.length).toBeGreaterThan(5);
    for (const f of spawns) {
      const text = readFileSync(f, 'utf8');
      expect(text, relative(ROOT, f)).not.toMatch(/localKey|local-api|LOCAL_KEY|ensureLocalKey|readKey/);
      // None builds its environment from a file in the data folder.
      expect(text, relative(ROOT, f)).not.toMatch(/env[^\n]*readFile/);
    }
  });
});
