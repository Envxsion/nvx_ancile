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
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const core = process.env.ANCILE_CORE_URL ?? 'http://localhost:7700';

export default defineConfig({
  plugins: [react()],
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
    sourcemap: true,
  },
});
