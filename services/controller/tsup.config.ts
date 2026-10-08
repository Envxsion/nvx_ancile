import { defineConfig } from 'tsup';

// Bundle the workspace contracts (they ship as TypeScript source); keep real
// npm dependencies external so the image installs them normally.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@nvx\//],
});
