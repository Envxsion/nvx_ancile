import { defineConfig } from 'tsup';

// One file with its few MIT dependencies; the Agent SDK is never bundled
// (it is fetched on the person's machine at run time, see src/sdk.ts).
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  sourcemap: true,
});
