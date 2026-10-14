/**
 * ------------------------------------------------------------------
 *  Title    |  Core build
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  `pnpm build`: one ESM bundle Node can run as is.
 *  How      |  Workspace packages (@nvx/*) ship TypeScript source, so
 *           |  they are bundled in; npm dependencies stay external and
 *           |  load from node_modules. Pro (pro/) is never bundled: the
 *           |  seam loads it at run time when it is there.
 * ------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  noExternal: [/^@nvx\//],
  // A release: licence keys, edition and version are fixed here (src/build.ts).
  define: { __ANCILE_RELEASE__: 'true', __ANCILE_VERSION__: JSON.stringify(version) },
});
