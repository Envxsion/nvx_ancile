/**
 * ------------------------------------------------------------------
 *  Title    |  Example tool build
 *  Ref      |  docs/plugins.md, packages/plugin-sdk/README.md
 *  ID       |  plugin:example-tool
 * ------------------------------------------------------------------
 *  Purpose  |  `pnpm --filter @nvx/plugin-example-tool build`: one file,
 *           |  dist/index.js, that `node` runs as an MCP server.
 *  How      |  The plugin SDK is a workspace package that ships
 *           |  TypeScript source, so it is bundled in; the MCP SDK and
 *           |  zod stay external and load from node_modules.
 * ------------------------------------------------------------------
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@nvx\//],
});
