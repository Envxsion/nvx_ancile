import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Pro (a private submodule at pro/) brings tests for its own screens; a public
// clone has none. They run here, in the Cockpit's jsdom, against the kit the
// Cockpit lends them. Pro imports only React, which lives in this package.
const proTests = fileURLToPath(new URL('../../pro/cockpit/test', import.meta.url));
const hasPro = existsSync(proTests);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Tests run as the free build: no Pro screens (see vite.config.ts).
  define: { __ANCILE_PRO_UI__: 'false', __ANCILE_VERSION__: JSON.stringify('0.0.0-test') },
  resolve: hasPro
    ? {
        alias: [
          { find: /^react$/, replacement: here('node_modules/react/index.js') },
          { find: /^react\/jsx-runtime$/, replacement: here('node_modules/react/jsx-runtime.js') },
          { find: /^react\/jsx-dev-runtime$/, replacement: here('node_modules/react/jsx-dev-runtime.js') },
        ],
      }
    : {},
  test: {
    // Several suites scan every source file; on Windows under load that can pass 5 s.
    testTimeout: 15_000,
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}', ...(hasPro ? ['../../pro/cockpit/test/**/*.test.{ts,tsx}'] : [])],
    setupFiles: ['test/setup.ts'],
    css: false,
    // `vitest run --coverage` (CI). Every source file counts, tested or not;
    // only the composition root is left out, as in Core. The target is 80%
    // lines; until the screens have tests, the floor is the measured value
    // (12 Oct 2026: lines 40.98%, branches 73.58%, functions 52.05%), rounded
    // down: a ratchet. Raise it as coverage rises, never lower it.
    // TODO(phase-6): screen tests (flows editor, settings, repos, rail) to reach 80%.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/main.tsx'],
      thresholds: { lines: 40, statements: 40, branches: 73, functions: 52 },
    },
  },
});
