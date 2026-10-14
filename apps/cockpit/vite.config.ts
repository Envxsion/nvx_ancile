/**
 * ------------------------------------------------------------------
 *  Title    |  Cockpit build
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Dev server on :7701 proxying the Core API on :7700 (each
 *           |  +100 for the test profile), so
 *           |  the browser only ever talks to one origin.
 *  Note     |  In production Core serves the built files itself.
 *           |  Every HTML page gets the Cockpit's Content Security
 *           |  Policy (packages/contracts/src/csp.ts) as its first
 *           |  <meta>, with a hash for each inline script on it, and
 *           |  the dev server adds the same header Core does.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
// Relative, so the config bundles it (a workspace package's .ts is not loadable by Node here).
import { cockpitCsp, cockpitHeaderCsp } from '../../packages/contracts/src/csp';

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const CSP_META = /<meta http-equiv="Content-Security-Policy" content="[^"]*"\s*\/?>/;

/** The policy into every page, hashing what runs inline on it (ours and the dev server's). */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'ancile-csp',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(INLINE_SCRIPT)]
          .map((m) => m[1] ?? '')
          .filter((body) => body.trim() !== '')
          .map((body) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
        const meta = `<meta http-equiv="Content-Security-Policy" content="${cockpitCsp([...new Set(hashes)])}" />`;
        if (!CSP_META.test(html))
          throw new Error('A Cockpit page is missing its Content-Security-Policy <meta>.');
        return html.replace(CSP_META, meta);
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        const dest = req.headers['sec-fetch-dest'];
        if (dest === 'document' || dest === 'iframe') {
          const csp = cockpitHeaderCsp(path, req.headers.host);
          if (csp) res.setHeader('Content-Security-Policy', csp);
        }
        next();
      });
    },
  };
}

// Pro's screens (pro/cockpit, a private submodule) import React and nothing
// else; they live outside this package, so React must resolve to this copy.

const core = process.env.ANCILE_CORE_URL ?? 'http://localhost:7700';

// A free build (NVX_TIER=free) leaves Pro's screens out entirely, even when
// pro/ is on disk. A build that includes them ships no source maps, which
// would carry Pro's private source.
const proUi =
  process.env.NVX_TIER !== 'free' && existsSync(new URL('../../pro/cockpit/index.tsx', import.meta.url));

// The version the Cockpit says it is (debug info, About): package.json's, fixed at build time.
const version = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  resolve: { dedupe: ['react', 'react-dom'] },
  define: { __ANCILE_PRO_UI__: JSON.stringify(proUi), __ANCILE_VERSION__: JSON.stringify(version) },
  server: {
    // 7701, or 7801 for the test profile (pnpm start:e2e) so both can run.
    port: Number(process.env.COCKPIT_PORT ?? 7701),
    strictPort: true,
    proxy: {
      '/api': { target: core, changeOrigin: true },
      '/internal': { target: core, changeOrigin: true },
      // The Python testbed (dev only) stands in for Core, which fetches Pyodide itself; the
      // page's own policy allows only this origin, so the CDN comes through here.
      '/testbed-cdn': {
        target: 'https://cdn.jsdelivr.net',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/testbed-cdn/, ''),
      },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: !proUi,
  },
});
