import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Pro (a private submodule at pro/) brings its own tests; a public clone has none.
const proTests = fileURLToPath(new URL('../../pro/core/test', import.meta.url));

// Two projects: `unit` runs in CI; `boot` is the fast suite scripts/boot.mjs
// runs before Core accepts traffic (DESIGN.md §14).
export default defineConfig({
  test: {
    // Product code only: the composition root (main.ts) and the declarative
    // schema are exercised by the boot suite and the e2e stack, and scripts/
    // holds development tools such as the sample-data seeder.
    // The floor CI holds `--coverage` to (with CORE_TEST_DATABASE_URL set, so
    // the Postgres stores count): 80% lines, the target. Measured 12 Oct 2026:
    // lines 80.57%, branches 78.2%, functions 87.67%. Raise these as coverage
    // rises; never lower one.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/db/schema.ts'],
      thresholds: { lines: 80, statements: 80, branches: 78, functions: 87 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/boot/**'],
          // Store contract tests also run against Postgres when CORE_TEST_DATABASE_URL is set.
          globalSetup: ['test/support/pg-setup.ts'],
          // The memory tests make real git commits; under a full parallel run on Windows
          // several pass the 5 s default and fail as flakes, hiding real failures.
          testTimeout: 15_000,
        },
      },
      { test: { name: 'boot', include: ['test/boot/**/*.boot.test.ts'], testTimeout: 8000 } },
      ...(existsSync(proTests)
        ? [
            {
              test: {
                name: 'unit-pro',
                root: fileURLToPath(new URL('../../pro/core', import.meta.url)),
                include: ['test/**/*.test.ts'],
                globals: true,
              },
            },
          ]
        : []),
    ],
  },
});
