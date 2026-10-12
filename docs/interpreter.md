# Code interpreter

Models in plain chat (cloud and local alike) can run Python with the `python_run` tool: to calculate, analyse a file attached to the thread, or draw a chart. The step shows the code, what it printed, any error, and its figures inline.

## Where the code runs, and why

**Decision: in a Cockpit window, in Pyodide (Python in WebAssembly), inside a Web Worker, inside a sandboxed iframe.** Core decides; the window only executes.

The alternative, running Pyodide in Core (Node), was rejected: Node has no network jail a worker cannot step around (Pyodide's `js` module reaches every Node global), so "network off" would rest on removing globals. A browser gives a real one: an opaque-origin frame whose CSP allows no connections at all.

1. A model calls `python_run {code, files?, timeout_s?}`. It is a built-in tool in Core's registry (action `code.run`, resource `python:thread/<id>`), so the conductor runs it only after `permissions/decide` (with scopes and Auto mode) allowed the call on its real arguments. Its default tier is auto (no side effects, no network, no access to this machine); `config/tools.yaml` (`tools.code.run`) can raise it. The Research and Coding tool presets include it; Read only does not.
2. Core parks a request and publishes `interpreter.requested`. Every open window offers; the first to claim it (`POST /interpreter/requests/:id/claim`) runs it. No window within 15 seconds: the call fails with "No NVX Ancile window is open to run Python", which the model relays.
3. The window starts (or reuses) a hidden `<iframe sandbox="allow-scripts" srcdoc>` whose CSP is `default-src 'none'; connect-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:`. The frame starts a classic worker from a Blob.
4. The worker's `fetch` is replaced: it asks for named runtime files only, which the window fetches from Core and transfers in. `XMLHttpRequest`, `WebSocket`, `EventSource` and `importScripts` are removed. Either layer alone keeps the network off.
5. The outcome (stdout, stderr, PNG figures, error, duration) goes back to Core (`POST …/result`). Figures are kept in `core.interpreter_figures` and the model reads only their ids and sizes.

## Limits

| Limit | Value | How |
|---|---|---|
| Time | 30 s, up to 120 s on request | The window removes the frame (ending the worker); the next run starts fresh. Core has its own backstop. |
| Memory | 512 MB | Pyodide's heap ceiling (`getHeapMax`, one line of the verified runtime) is lowered; past it Python raises MemoryError. |
| Output | 64,000 characters each of stdout and stderr; the model sees 8,000 | Cut with a note. |
| Figures | 6, 2 MB each | PNG signature checked by Core. |
| Files | 20 MB each, 50 MB in all | See below. |

Each run gets fresh globals; imported modules stay loaded while the window is open.

## Files

Only the thread's attachments: files added to the thread's notebook (the composer's paperclip adds them there), narrowed by the thread's scope. Core puts their source ids in the request; the window fetches exactly those and writes them into `/data`, the working folder, which is emptied before every run.

## The runtime

Pyodide 314.0.7 (MPL-2.0, on the licence script's allow list), downloaded by Core on first use from `cdn.jsdelivr.net/pyodide/v314.0.7/full/` through `@nvx/resilience`, checked against SHA-256 values pinned in `packages/contracts/src/interpreter.ts`, and kept under `data/runtime/pyodide/`. Packages are checked against the pinned lock, and only an allow list (numpy, pandas, matplotlib, scipy, sympy, networkx, scikit-learn, statsmodels, pyyaml, regex, beautifulsoup4, pillow, python-dateutil, pytz, with their dependencies) is served at all; anything else fails with "No module named". Nothing is installed from PyPI.

Size: about 13.5 MB the first time (runtime and standard library), about 13 MB more the first time a chart is drawn (numpy, matplotlib and their dependencies). Nothing is added to the installer.

## Proof

`tests/e2e/interpreter.spec.ts` runs the real sandbox: it prints and draws; `js.fetch`, `pyfetch`, `urllib`, sockets, `micropip` and `fetch` from `js.eval` all fail with no request reaching a local server standing in for Core; only the given files are visible; a busy loop is stopped at its limit and the next run works; a 900 MB allocation under a 256 MB ceiling raises MemoryError. `services/core/test/interpreter` covers hash checks, the allow list, claims and results.
