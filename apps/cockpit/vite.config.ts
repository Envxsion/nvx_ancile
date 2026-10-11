/**
 * ------------------------------------------------------------------
 *  Title    |  Cockpit build
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Dev server on :7701 proxying the Core API on :7700 (each
 *           |  +100 for the test profile), so
 *           |  the browser only ever talks to one origin.
 *  Note     |  In production Core serves the built files itself.
 * ------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Pro's screens (pro/cockpit, a private submodule) import React and nothing
// else; they live outside this package, so React must resolve to this copy.

const core = process.env.ANCILE_CORE_URL ?? 'http://localhost:7700';

// A free build (NVX_TIER=free) leaves Pro's screens out entirely, even when
// pro/ is on disk. A build that includes them ships no source maps, which
// would carry Pro's private source.
const proUi =
  process.env.NVX_TIER !== 'free' && existsSync(new URL('../../pro/cockpit/index.tsx', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  define: { __ANCILE_PRO_UI__: JSON.stringify(proUi) },
  server: {
    // 7701, or 7801 for the test profile (pnpm start:e2e) so both can run.
    port: Number(process.env.COCKPIT_PORT ?? 7701),
    strictPort: true,
    proxy: {
      '/api': { target: core, changeOrigin: true },
      '/internal': { target: core, changeOrigin: true },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: !proUi,
  },
});
