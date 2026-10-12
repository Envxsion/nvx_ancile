/**
 * The code interpreter's Core half: the runtime is served only after its
 * pinned hash checks (packages through the pinned lock, only allow-listed
 * ones), a request is claimed by one window and answered by that window
 * only, nobody claiming fails plainly, figures become ids, and python_run
 * hands over only files attached to the thread.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalEvent, InterpreterFile, InterpreterOutcome } from '@nvx/contracts';
import { AncileError } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { interpreterRoutes } from '../../src/interpreter/routes';
import { PyodideRuntime, sha256 } from '../../src/interpreter/runtime';
import { InterpreterService, MemoryFigureStore } from '../../src/interpreter/service';
import { pickFiles, pythonTool } from '../../src/interpreter/tool';
import { errorHandler } from '../../src/obs/errors';

const enc = (s: string) => new TextEncoder().encode(s);

const LOCK = JSON.stringify({
  info: { python: '3.14' },
  packages: {
    numpy: { name: 'numpy', file_name: 'numpy.whl', sha256: sha256(enc('numpy wheel')), depends: [] },
    matplotlib: {
      name: 'matplotlib',
      file_name: 'mpl.whl',
      sha256: sha256(enc('mpl wheel')),
      depends: ['numpy', 'cycler'],
    },
    cycler: { name: 'cycler', file_name: 'cycler.whl', sha256: sha256(enc('cycler wheel')), depends: [] },
    'evil-pkg': { name: 'evil-pkg', file_name: 'evil.whl', sha256: sha256(enc('evil')), depends: [] },
  },
});

const FILES: Record<string, string> = {
  'pyodide-lock.json': LOCK,
  'pyodide.mjs': 'export const loadPyodide = 1;',
  'numpy.whl': 'numpy wheel',
  'mpl.whl': 'mpl wheel',
  'cycler.whl': 'cycler wheel',
  'evil.whl': 'evil',
};

describe('PyodideRuntime', () => {
  let dir: string;
  let fetched: string[];
  let served: Record<string, string>;
  const make = () =>
    new PyodideRuntime({
      dataDir: dir,
      fetch: async (file) => {
        fetched.push(file);
        const body = served[file];
        return body === undefined ? new Response('no', { status: 404 }) : new Response(body);
      },
      pins: {
        'pyodide-lock.json': sha256(enc(LOCK)),
        'pyodide.mjs': sha256(enc(FILES['pyodide.mjs'] as string)),
      },
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-pyodide-'));
    fetched = [];
    served = { ...FILES };
  });

  it('downloads once, checks the hash, and serves from disk afterwards', async () => {
    const rt = make();
    expect(new TextDecoder().decode(await rt.file('pyodide.mjs'))).toBe(FILES['pyodide.mjs']);
    await rt.file('pyodide.mjs');
    expect(fetched.filter((f) => f === 'pyodide.mjs')).toHaveLength(1);
    expect(await rt.ready()).toBe(false);
    await rt.file('pyodide-lock.json');
    expect(await rt.ready()).toBe(true);
  });

  it('refuses a file whose hash does not match, and keeps nothing', async () => {
    served['pyodide.mjs'] = 'export const loadPyodide = "tampered";';
    const rt = make();
    await expect(rt.file('pyodide.mjs')).rejects.toMatchObject({ code: 'interpreter.runtime_mismatch' });
    expect(await rt.ready()).toBe(false);
  });

  it('re-downloads a damaged copy on disk instead of serving it', async () => {
    const rt = make();
    await rt.file('pyodide.mjs');
    await writeFile(join(rt.dir, 'pyodide.mjs'), 'damaged');
    const again = await make().file('pyodide.mjs');
    expect(new TextDecoder().decode(again)).toBe(FILES['pyodide.mjs']);
    expect(await readFile(join(rt.dir, 'pyodide.mjs'), 'utf8')).toBe(FILES['pyodide.mjs']);
  });

  it('serves allow-listed packages and their dependencies only, checked against the lock', async () => {
    const rt = make();
    expect(new TextDecoder().decode(await rt.file('mpl.whl'))).toBe('mpl wheel');
    expect(new TextDecoder().decode(await rt.file('cycler.whl'))).toBe('cycler wheel');
    await expect(rt.file('evil.whl')).rejects.toMatchObject({ code: 'interpreter.file_not_allowed' });
    await expect(rt.file('../../secrets.json')).rejects.toMatchObject({
      code: 'interpreter.file_not_allowed',
    });
    const lock = JSON.parse(new TextDecoder().decode(await rt.file('pyodide-lock.json')));
    expect(Object.keys(lock.packages).sort()).toEqual(['cycler', 'matplotlib', 'numpy']);
    served['numpy.whl'] = 'swapped';
    await expect(rt.file('numpy.whl')).rejects.toMatchObject({ code: 'interpreter.runtime_mismatch' });
  });
});

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]).toString('base64');

function outcome(clientId: string, extra: Partial<InterpreterOutcome> = {}): InterpreterOutcome {
  return {
    client_id: clientId,
    ok: true,
    stdout: '42\n',
    stderr: '',
    figures: [],
    error: null,
    duration_ms: 12,
    truncated: false,
    ...extra,
  };
}

describe('InterpreterService', () => {
  let events: GlobalEvent[];
  let figures: MemoryFigureStore;
  let svc: InterpreterService;

  beforeEach(() => {
    events = [];
    figures = new MemoryFigureStore();
    svc = new InterpreterService({
      figures,
      publish: (e) => void events.push(e),
      limits: { claimS: 0.05, startS: 1 },
    });
  });

  const announced = async () => {
    for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 2));
    return events[0] as Extract<GlobalEvent, { type: 'interpreter.requested' }>;
  };

  it('is claimed by one window, answered only by it, and figures become ids', async () => {
    const running = svc.run(
      { threadId: 'thr_1', callId: 'call_1', code: 'print(42)', files: [] },
      new AbortController().signal,
    );
    const e = await announced();
    expect(e).toMatchObject({ type: 'interpreter.requested', thread_id: 'thr_1', call_id: 'call_1' });
    const req = svc.claim(e.request_id, 'window-a-123');
    expect(req.code).toBe('print(42)');
    expect(() => svc.claim(e.request_id, 'window-b-456')).toThrow(AncileError);
    expect(() => svc.finish(e.request_id, outcome('window-b-456'))).toThrow(/Another window/);
    svc.finish(
      e.request_id,
      outcome('window-a-123', {
        figures: [
          { png_base64: PNG, width: 640, height: 480 },
          { png_base64: Buffer.from('<svg/>').toString('base64'), width: 1, height: 1 },
        ],
      }),
    );
    const result = await running;
    expect(result.stdout).toBe('42\n');
    // The second "figure" is not a PNG and is dropped.
    expect(result.figures).toEqual([{ id: 'fig_1', width: 640, height: 480, alt: 'Figure 1' }]);
    expect(figures.figures.size).toBe(1);
    expect(svc.open).toBe(0);
  });

  it('fails plainly when no window claims it', async () => {
    await expect(
      svc.run({ threadId: null, callId: null, code: '1', files: [] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'interpreter.no_window' });
    expect(svc.open).toBe(0);
  });

  it('stops when the run is stopped', async () => {
    const ac = new AbortController();
    const running = svc.run({ threadId: null, callId: null, code: '1', files: [] }, ac.signal);
    await announced();
    ac.abort();
    await expect(running).rejects.toMatchObject({ code: 'interpreter.cancelled' });
  });

  it('keeps what the model reads short', async () => {
    const running = svc.run(
      { threadId: null, callId: null, code: '1', files: [] },
      new AbortController().signal,
    );
    const e = await announced();
    svc.claim(e.request_id, 'window-a-123');
    svc.finish(e.request_id, outcome('window-a-123', { stdout: 'x'.repeat(20_000) }));
    const r = await running;
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThan(8_100);
    expect(r.stdout).toMatch(/more characters$/);
  });
});

describe('python_run', () => {
  const attached: InterpreterFile[] = [
    { source_id: 'src_1', name: 'sales.csv', bytes: 1000 },
    { source_id: 'src_2', name: 'huge.parquet', bytes: 30 * 1024 * 1024 },
  ];

  it('picks only attached files, by name', () => {
    expect(pickFiles(attached, ['Sales.csv'])).toEqual([attached[0]]);
    expect(() => pickFiles(attached, ['/etc/passwd'])).toThrow(/No file called/);
    expect(() => pickFiles(attached, ['huge.parquet'])).toThrow(/too large/);
    expect(pickFiles(attached, undefined)).toEqual([]);
  });

  it('is a gated-by-decide built-in: code.run on the thread, no network', () => {
    const tool = pythonTool({} as InterpreterService, { list: async () => [] });
    expect(tool.action).toBe('code.run');
    expect(tool.resource({ code: 'x' }, { threadId: 'thr_9' })).toBe('python:thread/thr_9');
    expect(tool.timeoutMs).toBeGreaterThan(60_000);
  });

  it('rejects bad arguments before anything runs', async () => {
    const tool = pythonTool({} as InterpreterService, { list: async () => [] });
    await expect(
      tool.execute({ code: '' }, { idempotencyKey: 'k', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'interpreter.bad_args' });
  });
});

describe('interpreter routes', () => {
  it('serves figures as inert PNG data and refuses odd runtime paths', async () => {
    const figures = new MemoryFigureStore();
    const id = await figures.put({
      threadId: null,
      callId: null,
      png: Buffer.from('89504e470d0a1a0a', 'hex'),
      width: 1,
      height: 1,
    });
    const app = new Hono();
    app.onError(errorHandler);
    const runtime = new PyodideRuntime({
      dataDir: await mkdtemp(join(tmpdir(), 'ancile-rt-')),
      fetch: async () => new Response('', { status: 404 }),
    });
    app.route(
      '/',
      interpreterRoutes({
        runtime,
        service: new InterpreterService({ figures, publish: () => undefined }),
        figures,
      }) as unknown as Hono,
    );
    const res = await app.request(`/interpreter/figures/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect((await app.request('/interpreter/runtime/0.0.1/pyodide.mjs')).status).toBe(404);
    expect((await app.request('/interpreter/figures/..%2Fx')).status).toBe(404);
  });
});
