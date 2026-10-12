/**
 * ------------------------------------------------------------------
 *  Title    |  Python sandbox testbed
 *  Ref      |  tests/e2e/interpreter.spec.ts · docs/interpreter.md
 *  ID       |  cockpit (dev server only, never built)
 * ------------------------------------------------------------------
 *  Purpose  |  Drive the real PythonSandbox without Core: runtime files
 *           |  come straight from the pinned CDN folder and are checked
 *           |  here against the same pinned hashes Core uses (the lock
 *           |  for packages), as Core would. The test calls
 *           |  window.runPython(code, opts) and reads the outcome.
 * ------------------------------------------------------------------
 */

import { INTERPRETER_LIMITS, PYODIDE_CDN, PYODIDE_FILES, PYODIDE_PACKAGES } from '@nvx/contracts';
import { PythonSandbox, type Stage } from '../src/interpreter/sandbox';

const hex = async (b: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');

type Pkg = { file_name: string; sha256: string; depends: string[] };
let lock: Record<string, Pkg> | null = null;

/** As Core does: only the allowed packages and their dependencies. */
function allowed(all: Record<string, Pkg>): Record<string, Pkg> {
  const keep = new Set<string>();
  const walk = (n: string) => {
    if (keep.has(n) || !all[n]) return;
    keep.add(n);
    for (const d of all[n].depends) walk(d);
  };
  for (const r of PYODIDE_PACKAGES) walk(r);
  return Object.fromEntries(Object.entries(all).filter(([n]) => keep.has(n)));
}

async function runtimeFile(name: string): Promise<ArrayBuffer> {
  const res = await fetch(`${PYODIDE_CDN}${name}`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  const want =
    PYODIDE_FILES[name] ?? Object.values(lock ?? {}).find((p) => p.file_name === name)?.sha256 ?? null;
  if (!want || (await hex(bytes)) !== want) throw new Error(`${name} failed its hash check`);
  if (name === 'pyodide-lock.json') {
    const full = JSON.parse(new TextDecoder().decode(bytes));
    lock = allowed(full.packages);
    return new TextEncoder().encode(JSON.stringify({ ...full, packages: lock })).buffer as ArrayBuffer;
  }
  return bytes;
}

const box = new PythonSandbox({ runtimeFile });
const stages: Stage[] = [];

Object.assign(window, {
  stages,
  runPython: (
    code: string,
    opts: { timeoutS?: number; memoryMb?: number; files?: Record<string, string> } = {},
  ) =>
    box.run(
      {
        code,
        timeoutS: opts.timeoutS ?? INTERPRETER_LIMITS.timeoutS,
        memoryMb: opts.memoryMb ?? INTERPRETER_LIMITS.memoryMb,
        files: Object.entries(opts.files ?? {}).map(([name, text]) => ({
          name,
          bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
        })),
      },
      (s) => stages.push(s),
    ),
});
document.title = 'Python sandbox testbed (ready)';
