/**
 * ------------------------------------------------------------------
 *  Title    |  Code interpreter
 *  Ref      |  docs/interpreter.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The python_run tool: its arguments, its limits, the
 *           |  request Core hands a Cockpit window to run, what the
 *           |  window sends back, and what the model is told.
 *  How      |  Core registers python_run like any tool, so every call
 *           |  passes permissions/decide. Executing it publishes
 *           |  `interpreter.requested`; one open Cockpit window claims
 *           |  the request and runs the code in Pyodide, inside a Web
 *           |  Worker, inside a sandboxed iframe with no network.
 *           |  Pyodide is downloaded by Core on first use from the
 *           |  pinned CDN folder below, each file checked against the
 *           |  hash pinned here (or, for packages, in the pinned lock).
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** The runtime's own files, and the SHA-256 of each (checked 2026-10-12). */
export const PYODIDE_FILES: Readonly<Record<string, string>> = {
  'pyodide.mjs': '6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109',
  'pyodide.asm.mjs': 'f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635',
  'pyodide.asm.wasm': 'cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6',
  'python_stdlib.zip': 'fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a',
  'pyodide-lock.json': '5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010',
};

/**
 * Packages code may import (each with its dependencies, from the pinned
 * lock, checked against the lock's SHA-256). Anything else fails with
 * "No module named …"; nothing is ever fetched from PyPI.
 */
export const PYODIDE_PACKAGES = [
  'numpy',
  'pandas',
  'matplotlib',
  'scipy',
  'sympy',
  'networkx',
  'scikit-learn',
  'statsmodels',
  'pyyaml',
  'regex',
  'beautifulsoup4',
  'pillow',
  'python-dateutil',
  'pytz',
] as const;

export const INTERPRETER_LIMITS = {
  /** Seconds a run may take once Python is ready (the model may ask for less, or up to max). */
  timeoutS: 30,
  maxTimeoutS: 120,
  /** Python's heap, enforced by the WebAssembly memory ceiling. */
  memoryMb: 512,
  /** Characters of stdout and of stderr kept. */
  outputChars: 64_000,
  /** What the model is shown of them. */
  modelOutputChars: 8_000,
  figures: 6,
  figureBytes: 2 * 1024 * 1024,
  /** One input file, and all of them together. */
  fileBytes: 20 * 1024 * 1024,
  filesBytes: 50 * 1024 * 1024,
  /** How long Core waits for a window to take the request. */
  claimS: 15,
  /** Extra time allowed for the first download and start of the runtime. */
  startS: 150,
} as const;

export const PythonRunArgs = z.object({
  code: z.string().min(1).max(100_000),
  /** Names of files attached to this thread to copy into the working folder (/data). */
  files: z.array(z.string().min(1).max(255)).max(20).optional(),
  timeout_s: z.number().int().min(1).max(INTERPRETER_LIMITS.maxTimeoutS).optional(),
});
export type PythonRunArgs = z.infer<typeof PythonRunArgs>;

export const InterpreterFile = z.object({
  source_id: z.string(),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type InterpreterFile = z.infer<typeof InterpreterFile>;

/** What a Cockpit window fetches after claiming a request. */
export const InterpreterRequest = z.object({
  id: z.string(),
  thread_id: z.string().nullable(),
  call_id: z.string().nullable(),
  code: z.string(),
  files: z.array(InterpreterFile),
  timeout_s: z.number().int().positive(),
  memory_mb: z.number().int().positive(),
  runtime: z.object({ version: z.string(), files: z.array(z.string()) }),
  created_at: z.string(),
});
export type InterpreterRequest = z.infer<typeof InterpreterRequest>;

export const InterpreterClaim = z.object({ client_id: z.string().min(8).max(64) });
export type InterpreterClaim = z.infer<typeof InterpreterClaim>;

export const InterpreterErrorKind = z.enum(['python', 'timeout', 'memory', 'runtime', 'cancelled']);
export type InterpreterErrorKind = z.infer<typeof InterpreterErrorKind>;

/** What the window sends back. */
export const InterpreterOutcome = z.object({
  client_id: z.string().min(8).max(64),
  ok: z.boolean(),
  stdout: z.string().max(INTERPRETER_LIMITS.outputChars + 200),
  stderr: z.string().max(INTERPRETER_LIMITS.outputChars + 200),
  figures: z
    .array(
      z.object({
        png_base64: z.string().max(Math.ceil((INTERPRETER_LIMITS.figureBytes * 4) / 3) + 8),
        width: z.number().int().positive().max(10_000),
        height: z.number().int().positive().max(10_000),
      }),
    )
    .max(INTERPRETER_LIMITS.figures),
  error: z.object({ kind: InterpreterErrorKind, message: z.string().max(8_000) }).nullable(),
  duration_ms: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
});
export type InterpreterOutcome = z.infer<typeof InterpreterOutcome>;

/** The tool result, as stored and as the model reads it. Figures are served by Core. */
export const PythonRunResult = z.object({
  ok: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  figures: z.array(
    z.object({ id: z.string(), width: z.number().int(), height: z.number().int(), alt: z.string() }),
  ),
  error: z.object({ kind: InterpreterErrorKind, message: z.string() }).nullable(),
  duration_ms: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type PythonRunResult = z.infer<typeof PythonRunResult>;

export const InterpreterStatus = z.object({
  version: z.string(),
  /** Bytes of the runtime already on this machine, and of the whole core runtime. */
  cached_bytes: z.number().int().nonnegative(),
  ready: z.boolean(),
  downloading: z.boolean(),
});
export type InterpreterStatus = z.infer<typeof InterpreterStatus>;
