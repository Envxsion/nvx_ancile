/**
 * Boot suite for the Cockpit (DESIGN.md §14). Fast, no network: the brand
 * tokens are intact in both themes, the keymap has no conflicts, every
 * route and admin section resolves, and the inlined theme script matches
 * the one in @nvx/aperture.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOOT_SCRIPT } from '@nvx/aperture';
import { describe, expect, it } from 'vitest';
import { BINDINGS, findConflicts } from '../../src/keys/registry';
import { PRO_SURFACES } from '../../src/pro/slot';
import { ADMIN_SECTIONS } from '../../src/routes/admin/sections';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('boot: brand tokens', () => {
  const tokens = read('../../../../packages/aperture/src/tokens.css');
  const identity = read('../../../../packages/aperture/src/ancile.css');
  const [dark = '', light = ''] = tokens.split("[data-theme='light'] {");

  it.each(['--void', '--lift', '--lift-2', '--fg', '--mute', '--hair', '--ok', '--warn', '--fail'])(
    'defines %s in dark and light',
    (name) => {
      expect(dark).toContain(`${name}:`);
      expect(light).toContain(`${name}:`);
    },
  );

  it.each(['--signal', '--signal-rgb', '--signal-ink', '--on-signal'])(
    'identity defines %s for both themes',
    (name) => {
      expect(identity.match(new RegExp(`${name}:`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
    },
  );
});

describe('boot: keymap', () => {
  it('has no conflicting bindings', () => {
    expect(findConflicts()).toEqual([]);
  });
  it('has unique ids', () => {
    const ids = BINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('boot: routes', () => {
  it('resolves every route', async () => {
    const { router } = await import('../../src/router');
    const ids = Object.keys(router.routesById);
    for (const id of ['/', '/t/$threadId', '/n/$notebookId', '/setup', '/admin', '/admin/$section']) {
      expect(ids).toContain(id);
    }
  });
  it('has a screen for every admin section the design lists', () => {
    const required = [
      'health',
      'compute',
      'grants',
      'decisions',
      'memory',
      'logs',
      'traces',
      'models',
      'routing',
      'plugins',
      'automations',
      'diagnostics',
      'license',
      // Pro features: their screen with Pro, a card explaining them without.
      ...PRO_SURFACES.filter((s) => s.place === 'admin').map((s) => s.id),
    ];
    expect(ADMIN_SECTIONS.map((s) => s.id).sort()).toEqual([...required].sort());
  });
});

describe('boot: theme before first paint', () => {
  it('index.html inlines the exact BOOT_SCRIPT', () => {
    expect(read('../../index.html')).toContain(BOOT_SCRIPT);
  });
});
