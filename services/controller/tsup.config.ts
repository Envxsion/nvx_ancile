import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

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
  // The version /health reports (src/app.ts).
  define: { __ANCILE_VERSION__: JSON.stringify(version) },
});
