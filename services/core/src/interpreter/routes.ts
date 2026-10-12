/**
 * ------------------------------------------------------------------
 *  Title    |  Code interpreter routes
 *  Ref      |  docs/interpreter.md · docs/api.md (Interpreter)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What a Cockpit window needs to run python_run: the
 *           |  verified runtime files, the request it claimed, a place
 *           |  to send the outcome, and the figures to show.
 *  How      |  GET  /interpreter/status
 *           |  GET  /interpreter/runtime/:version/:file   (verified bytes)
 *           |  POST /interpreter/requests/:id/claim       { client_id }
 *           |  POST /interpreter/requests/:id/result      InterpreterOutcome
 *           |  GET  /interpreter/figures/:id              image/png
 *  Note     |  Every response that carries file bytes says nosniff and
 *           |  a sandboxing CSP: they are data, never a page.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  InterpreterClaim,
  InterpreterOutcome,
  type InterpreterStatus,
  PYODIDE_VERSION,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { PyodideRuntime } from './runtime';
import type { FigureStore, InterpreterService } from './service';

const TYPES: [RegExp, string][] = [
  [/\.wasm$/, 'application/wasm'],
  [/\.m?js$/, 'text/javascript'],
  [/\.json$/, 'application/json'],
  [/\.(zip|whl)$/, 'application/zip'],
  [/\.tar$/, 'application/x-tar'],
];

const FILE = /^[A-Za-z0-9._+-]{1,200}$/;

const dataHeaders = (type: string, bytes: number) => ({
  'content-type': type,
  'content-length': String(bytes),
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'private, max-age=31536000, immutable',
});

export function interpreterRoutes(deps: {
  runtime: PyodideRuntime;
  service: InterpreterService;
  figures: FigureStore;
}) {
  const r = new Hono<AppEnv>();

  r.get('/interpreter/status', async (c) => {
    const out: InterpreterStatus = {
      version: PYODIDE_VERSION,
      cached_bytes: await deps.runtime.cachedBytes(),
      ready: await deps.runtime.ready(),
      downloading: deps.runtime.downloading > 0,
    };
    return c.json(out);
  });

  r.get('/interpreter/runtime/:version/:file', async (c) => {
    const version = c.req.param('version');
    const file = c.req.param('file');
    if (version !== PYODIDE_VERSION || !FILE.test(file) || file.includes('..'))
      throw new AncileError({
        code: 'interpreter.file_not_allowed',
        title: `${file.slice(0, 80)} is not part of the Python runtime.`,
        hint: 'Reload NVX Ancile: this window asked for a runtime version Core does not serve.',
        status: 404,
        errorClass: 'permanent',
      });
    const bytes = await deps.runtime.file(file);
    const type = TYPES.find(([re]) => re.test(file))?.[1] ?? 'application/octet-stream';
    return new Response(bytes, { status: 200, headers: dataHeaders(type, bytes.length) });
  });

  r.post('/interpreter/requests/:id/claim', async (c) => {
    const req = await body(c, InterpreterClaim);
    return c.json(deps.service.claim(c.req.param('id'), req.client_id));
  });

  r.post('/interpreter/requests/:id/result', async (c) => {
    const outcome = await body(c, InterpreterOutcome);
    deps.service.finish(c.req.param('id'), outcome);
    return c.body(null, 204);
  });

  r.get('/interpreter/figures/:id', async (c) => {
    const id = c.req.param('id');
    const f = /^fig_[A-Za-z0-9]{1,40}$/.test(id) ? await deps.figures.get(id) : null;
    if (!f)
      throw new AncileError({
        code: 'request.not_found',
        title: "That figure doesn't exist.",
        hint: 'It may have been deleted with its thread. Run the code again to draw it.',
        status: 404,
        errorClass: 'permanent',
      });
    return new Response(new Uint8Array(f.png), {
      status: 200,
      headers: dataHeaders('image/png', f.png.length),
    });
  });

  return r;
}
