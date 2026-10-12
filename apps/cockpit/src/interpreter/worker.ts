/**
 * ------------------------------------------------------------------
 *  Title    |  The Python worker
 *  Ref      |  docs/interpreter.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Load Pyodide and run one piece of code at a time, with
 *           |  nothing but the bytes it is handed: no network, no
 *           |  files but /data, a ceiling on memory.
 *  How      |  pythonWorker is serialised (toString) into a Blob and
 *           |  started as a module Worker inside the sandbox frame,
 *           |  so it must not use anything outside itself. fetch is
 *           |  replaced by a function that asks the frame for a named
 *           |  runtime file (Core checked its hash) and refuses
 *           |  anything else; XMLHttpRequest, WebSocket, EventSource
 *           |  and importScripts are removed. The frame's CSP blocks
 *           |  the network as well (connect-src 'none'), so either
 *           |  layer alone holds.
 *  Note     |  Memory: Pyodide's heap ceiling (getHeapMax) is lowered
 *           |  to the request's limit by patching that one line of the
 *           |  verified runtime; past it Python raises MemoryError.
 *           |  The patch point not being found stops the run.
 * ------------------------------------------------------------------
 */

export function pythonWorker() {
  const BASE = 'https://pyodide.invalid/';
  const HEAP_MARK = 'var getHeapMax=()=>4294901760;';
  const waiting = new Map<string, { ok: (b: ArrayBuffer) => void; fail: (e: Error) => void }>();
  const post = (m: Record<string, unknown>, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage(m, transfer);
  const need = (file: string) =>
    new Promise<ArrayBuffer>((ok, fail) => {
      waiting.set(file, { ok, fail });
      post({ type: 'need', file });
    });

  const g = self as unknown as Record<string, unknown>;
  g.fetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    if (!url.startsWith(BASE)) throw new TypeError('There is no network in this sandbox.');
    const name = decodeURIComponent(url.slice(BASE.length).split('?')[0] ?? '');
    const bytes = await need(name);
    const type = name.endsWith('.wasm')
      ? 'application/wasm'
      : name.endsWith('.json')
        ? 'application/json'
        : 'application/octet-stream';
    return new Response(bytes, { status: 200, headers: { 'content-type': type } });
  };
  for (const k of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts']) {
    try {
      Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false });
    } catch {
      g[k] = undefined;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: Pyodide's API, untyped here on purpose
  let py: any = null;
  let booting: Promise<void> | null = null;

  const boot = async (memoryMb: number) => {
    post({ type: 'progress', stage: 'loading' });
    const [loader, asm] = await Promise.all([need('pyodide.mjs'), need('pyodide.asm.mjs')]);
    let asmText = new TextDecoder().decode(asm);
    if (!asmText.includes(HEAP_MARK)) throw new Error('This Python runtime cannot be given a memory limit.');
    asmText = asmText.replace(HEAP_MARK, 'var getHeapMax=()=>globalThis.__ancileHeapMax||4294901760;');
    g.__ancileHeapMax = memoryMb * 1024 * 1024;
    // An opaque origin cannot load module workers or import() a blob, so both
    // modules are turned into classic scripts: their exports become globals.
    const asmExport = 'export default _createPyodideModule;';
    if (!asmText.includes(asmExport)) throw new Error('This Python runtime has an unexpected shape.');
    asmText = asmText
      .replace(asmExport, 'self.__ancileCreatePyodide=_createPyodideModule;')
      .split('import.meta.url')
      .join(JSON.stringify(`${BASE}pyodide.asm.mjs`));
    let loaderText = new TextDecoder().decode(loader);
    const exp = /;export\{([^}]*)\};?/.exec(loaderText);
    if (!exp) throw new Error('This Python runtime has an unexpected shape.');
    const names = (exp[1] ?? '').split(',').map((x) => {
      const [local, as] = x.trim().split(/\s+as\s+/);
      return `${as ?? local}:${local}`;
    });
    loaderText = loaderText.replace(exp[0], `;self.__ancilePyodide={${names.join(',')}};`);
    // biome-ignore lint/security/noGlobalEval: the hash-checked runtime, run as a classic script inside the sandboxed worker
    const run = globalThis.eval as (src: string) => unknown;
    run(loaderText);
    run(asmText);
    const { loadPyodide } = g.__ancilePyodide as { loadPyodide: (o: unknown) => Promise<unknown> };
    const createPyodideModule = g.__ancileCreatePyodide;
    py = await loadPyodide({
      indexURL: BASE,
      createPyodideModule,
      fullStdLib: false,
      env: { HOME: '/home/pyodide', MPLBACKEND: 'Agg' },
    });
    py.runPython(
      [
        'import warnings',
        "warnings.filterwarnings('ignore', message='.*non-interactive.*')",
        "warnings.filterwarnings('ignore', message='.*FigureCanvasAgg.*')",
      ].join('\n'),
    );
  };

  const trimTrace = (msg: string) => {
    const lines = msg.split('\n');
    const at = lines.findIndex((l) => l.includes('File "<exec>"') || l.includes('File "<python_run>"'));
    if (at === -1) return msg.trim();
    return ['Traceback (most recent call last):', ...lines.slice(at)].join('\n').trim();
  };

  const run = async (m: {
    code: string;
    files: { name: string; bytes: ArrayBuffer }[];
    memoryMb: number;
    outputChars: number;
    maxFigures: number;
  }) => {
    booting ??= boot(m.memoryMb);
    await booting;
    // The ceiling is read on every heap growth, so each run gets its own.
    g.__ancileHeapMax = m.memoryMb * 1024 * 1024;
    const out: string[] = [];
    const err: string[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    const keep = (buf: string[], s: string, len: number) => {
      if (len >= m.outputChars) {
        truncated = true;
        return len;
      }
      const piece = s.slice(0, m.outputChars - len);
      if (piece.length < s.length) truncated = true;
      buf.push(piece);
      return len + piece.length;
    };
    py.setStdout({
      write: (b: Uint8Array) => {
        outLen = keep(out, new TextDecoder().decode(b), outLen);
        return b.length;
      },
    });
    py.setStderr({
      write: (b: Uint8Array) => {
        errLen = keep(err, new TextDecoder().decode(b), errLen);
        return b.length;
      },
    });

    // A clean /data with only this run's files.
    const FS = py.FS;
    try {
      FS.mkdirTree('/data');
      for (const n of FS.readdir('/data')) if (n !== '.' && n !== '..') FS.unlink(`/data/${n}`);
    } catch {
      // A sub-folder left by an earlier run: start a fresh one.
      FS.rename('/data', `/data-old-${Date.now()}`);
      FS.mkdirTree('/data');
    }
    for (const f of m.files) {
      const safe = f.name.replace(/[\\/]/g, '_').replace(/^\.+/, '_');
      FS.writeFile(`/data/${safe}`, new Uint8Array(f.bytes));
    }
    py.runPython("import os; os.chdir('/data')");

    post({ type: 'progress', stage: 'packages' });
    const missing: string[] = [];
    await py.loadPackagesFromImports(m.code, {
      messageCallback: () => undefined,
      errorCallback: (s: string) => missing.push(s),
    });

    post({ type: 'progress', stage: 'running' });
    const started = performance.now();
    let error: { kind: string; message: string } | null = null;
    const ns = py.globals.get('dict')();
    try {
      await py.runPythonAsync(m.code, { globals: ns, filename: '<python_run>' });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      error = {
        kind: /\bMemoryError\b/.test(msg) ? 'memory' : 'python',
        message: trimTrace(msg).slice(0, 8000),
      };
    } finally {
      ns.destroy?.();
    }
    const duration = Math.round(performance.now() - started);

    let figures: { png_base64: string; width: number; height: number }[] = [];
    try {
      const raw = py.runPython(
        [
          'def _ancile_figures(limit):',
          '    import sys',
          "    if 'matplotlib.pyplot' not in sys.modules:",
          '        return []',
          '    import io, base64, struct',
          '    import matplotlib.pyplot as plt',
          '    out = []',
          '    for n in plt.get_fignums()[:limit]:',
          '        b = io.BytesIO()',
          "        plt.figure(n).savefig(b, format='png', dpi=110, bbox_inches='tight')",
          '        v = b.getvalue()',
          "        w, h = struct.unpack('>II', v[16:24])",
          "        out.append([base64.b64encode(v).decode('ascii'), w, h])",
          "    plt.close('all')",
          '    return out',
          `_ancile_figures(${Math.max(0, Math.min(12, m.maxFigures))})`,
        ].join('\n'),
      );
      const list = raw?.toJs ? raw.toJs() : [];
      raw?.destroy?.();
      figures = (list as [string, number, number][]).map(([png_base64, width, height]) => ({
        png_base64,
        width,
        height,
      }));
    } catch (e) {
      err.push(`\nFigures could not be saved: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
    if (missing.length && !error) err.push(missing.join('\n'));
    post({
      type: 'done',
      outcome: {
        ok: error === null,
        stdout: out.join(''),
        stderr: err.join(''),
        figures,
        error,
        duration_ms: duration,
        truncated,
      },
    });
  };

  self.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; file?: string; bytes?: ArrayBuffer; message?: string };
    if (d?.type === 'file' && d.file) {
      const w = waiting.get(d.file);
      waiting.delete(d.file);
      if (w && d.bytes) w.ok(d.bytes);
      else w?.fail(new Error(d.message ?? `${d.file} could not be loaded.`));
    } else if (d?.type === 'run') {
      run(d as unknown as Parameters<typeof run>[0]).catch((err: unknown) =>
        post({ type: 'crash', message: String((err as Error)?.message ?? err).slice(0, 2000) }),
      );
    }
  });
  post({ type: 'ready' });
}
