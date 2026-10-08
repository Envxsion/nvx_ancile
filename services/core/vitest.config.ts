import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Pro (a private submodule at pro/) brings its own tests; a public clone has none.
const proTests = fileURLToPath(new URL('../../pro/core/test', import.meta.url));

// Two projects: `unit` runs in CI; `boot` is the fast suite scripts/boot.mjs
// runs before Core accepts traffic (DESIGN.md §14).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/boot/**'] } },
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
