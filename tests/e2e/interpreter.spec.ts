/**
 * The code interpreter's sandbox (docs/interpreter.md): Python runs, prints
 * and draws; it cannot reach the network (127.0.0.1 standing in for Core, or
 * anywhere) by any route Python or JavaScript offers; files are only the
 * ones handed in; a run past its time limit is stopped; memory has a ceiling.
 *
 * Downloads the pinned Pyodide runtime from the CDN on first run (about
 * 26 MB with matplotlib), so it is slow the first time. Set E2E_OFFLINE=1 to
 * skip it on a machine with no internet.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

type Outcome = {
  ok: boolean;
  stdout: string;
  stderr: string;
  figures: { png_base64: string; width: number; height: number }[];
  error: { kind: string; message: string } | null;
};

let server: Server;
let port = 0;
const hits: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '?');
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end('hit');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(async () => new Promise<void>((r) => server.close(() => r())));

const run = (page: Page, code: string, opts: Record<string, unknown> = {}) =>
  page.evaluate(
    ([c, o]) =>
      (window as unknown as { runPython: (c: string, o: unknown) => Promise<Outcome> }).runPython(c, o),
    [code, opts] as const,
  );

test.describe('python sandbox', () => {
  test.skip(BACKEND || Boolean(process.env.E2E_OFFLINE), 'needs the dev server and the CDN');
  test.skip(({ browserName }) => browserName !== 'chromium', 'checked in Chromium');
  test.setTimeout(300_000);

  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('/testbed/python.html');
    await expect(page).toHaveTitle(/ready/);
  });

  test('runs code, prints, and returns matplotlib figures as PNG', async () => {
    const out = await run(
      page,
      [
        'import matplotlib.pyplot as plt',
        'import numpy as np',
        'x = np.linspace(0, 6.28, 50)',
        'plt.plot(x, np.sin(x))',
        'plt.title("Sine")',
        'plt.show()',
        'print("mean", round(float(np.sin(x).mean()), 3))',
      ].join('\n'),
    );
    expect(out.error).toBeNull();
    expect(out.stdout).toContain('mean');
    expect(out.figures).toHaveLength(1);
    expect(out.figures[0]?.png_base64.startsWith('iVBORw0KGgo')).toBe(true);
    expect(out.figures[0]?.width).toBeGreaterThan(100);
  });

  test('cannot reach the network from Python or JavaScript', async () => {
    hits.length = 0;
    const T = `http://127.0.0.1:${port}`;
    const out = await run(
      page,
      [
        'import js, asyncio',
        'results = {}',
        'async def attempt(name, coro):',
        '    try:',
        '        await coro',
        '        results[name] = "reached"',
        '    except BaseException as e:',
        '        results[name] = "blocked"',
        `await attempt("js_fetch", js.fetch("${T}/py-fetch"))`,
        'from pyodide.http import pyfetch',
        `await attempt("pyfetch", pyfetch("${T}/pyfetch"))`,
        'try:',
        '    import urllib.request',
        `    urllib.request.urlopen("${T}/urllib", timeout=2)`,
        '    results["urllib"] = "reached"',
        'except BaseException:',
        '    results["urllib"] = "blocked"',
        'try:',
        '    import socket',
        `    socket.create_connection(("127.0.0.1", ${port}), timeout=2)`,
        '    results["socket"] = "reached"',
        'except BaseException:',
        '    results["socket"] = "blocked"',
        'for name in ["XMLHttpRequest", "WebSocket", "EventSource", "importScripts"]:',
        '    results[name] = "absent" if getattr(js, name, None) is None else "present"',
        'try:',
        `    js.eval("fetch('${T}/eval-fetch')")`,
        '    results["js_eval"] = "ran"',
        'except BaseException:',
        '    results["js_eval"] = "blocked"',
        'try:',
        '    import micropip',
        '    await micropip.install("requests")',
        '    results["micropip"] = "installed"',
        'except BaseException:',
        '    results["micropip"] = "blocked"',
        'print(results)',
      ].join('\n'),
    );
    await page.waitForTimeout(1_000);
    expect(hits, `hits: ${hits.join(', ')}`).toEqual([]);
    expect(out.stdout).not.toContain("'reached'");
    expect(out.stdout).not.toContain("'installed'");
    expect(out.stdout).toContain("'XMLHttpRequest': 'absent'");
  });

  test('sees only the files it was given', async () => {
    const out = await run(page, 'import os\nprint(sorted(os.listdir(".")))\nprint(open("data.csv").read())', {
      files: { 'data.csv': 'a,b\n1,2' },
    });
    expect(out.stdout).toContain("['data.csv']");
    expect(out.stdout).toContain('a,b');
    const next = await run(page, 'import os\nprint(sorted(os.listdir(".")))');
    expect(next.stdout).toContain('[]');
  });

  test('a run past its time limit is stopped, and the next run starts fresh', async () => {
    const out = await run(page, 'while True:\n    pass', { timeoutS: 3 });
    expect(out.error?.kind).toBe('timeout');
    const again = await run(page, 'print(6 * 7)');
    expect(again.stdout.trim()).toBe('42');
  });

  test('memory has a ceiling', async () => {
    const out = await run(page, 'x = bytearray(900 * 1024 * 1024)\nprint(len(x))', { memoryMb: 256 });
    expect(out.error?.kind).toBe('memory');
  });
});
