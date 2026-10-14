/**
 * D5: the version comes from the build, never from a literal in the code.
 * Every place a release declares its version agrees, Core's build version
 * is its package.json's, and the desktop's word wins when it gives one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appVersion, BUILD_VERSION } from '../../src/build';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const pkg = (path: string) => (JSON.parse(read(path)) as { version: string }).version;

describe('the version', () => {
  it('is the same everywhere a release declares it', () => {
    const declared: Record<string, string> = {
      'package.json': pkg('package.json'),
      'apps/cockpit/package.json': pkg('apps/cockpit/package.json'),
      'apps/desktop/package.json': pkg('apps/desktop/package.json'),
      'services/core/package.json': pkg('services/core/package.json'),
      'services/controller/package.json': pkg('services/controller/package.json'),
      'packages/contracts/package.json': pkg('packages/contracts/package.json'),
      'services/knowledge/pyproject.toml': /^version = "([^"]+)"/m.exec(read('services/knowledge/pyproject.toml'))?.[1] ?? '',
      'apps/desktop/src-tauri/Cargo.toml': /^version = "([^"]+)"/m.exec(read('apps/desktop/src-tauri/Cargo.toml'))?.[1] ?? '',
      'apps/desktop/src-tauri/tauri.conf.json': pkg('apps/desktop/src-tauri/tauri.conf.json'),
    };
    const release = declared['package.json'];
    expect(release).toMatch(/^\d+\.\d+\.\d+/);
    for (const [where, v] of Object.entries(declared)) expect({ where, v }).toEqual({ where, v: release });
  });

  it("is Core's package.json version when running from source", () => {
    expect(BUILD_VERSION).toBe(pkg('services/core/package.json'));
  });

  it("takes the desktop app's version when it gives one, and ignores a blank one", () => {
    expect(appVersion('0.2.0')).toBe('0.2.0');
    expect(appVersion('  ')).toBe(BUILD_VERSION);
    expect(appVersion(undefined)).toBe(BUILD_VERSION);
  });

  it('is never written into the code by hand', () => {
    const sources = [
      'services/core/src/main.ts',
      'services/core/src/db/cli.ts',
      'services/core/src/mcp/manager.ts',
      'services/controller/src/app.ts',
      'services/knowledge/ancile_knowledge/__init__.py',
      'apps/cockpit/src/ui/ErrorState.tsx',
    ];
    for (const file of sources) expect({ file, literal: /['"]\d+\.\d+\.\d+['"]/.test(read(file)) }).toEqual({ file, literal: false });
  });
});
