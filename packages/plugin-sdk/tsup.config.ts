/**
 * ------------------------------------------------------------------
 *  Title    |  Plugin SDK build
 *  Ref      |  packages/plugin-sdk/README.md, docs/plugins.md
 *  ID       |  plugin-sdk
 * ------------------------------------------------------------------
 *  Purpose  |  `pnpm --filter @nvx/plugin-sdk build`: the package as it
 *           |  would be published, in dist/ (ESM and type definitions).
 *  How      |  Inside this repository every package imports the SDK's
 *           |  TypeScript source (package.json "exports"); a published
 *           |  copy uses dist/ instead ("publishConfig"). The workspace
 *           |  contracts the SDK uses are bundled in, code and types
 *           |  alike, so the only dependency left is zod.
 * ------------------------------------------------------------------
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', panel: 'src/panel.ts' },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@nvx\//],
  external: ['zod'],
  dts: { resolve: true },
});
