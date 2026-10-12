/**
 * ------------------------------------------------------------------
 *  Title    |  A python_run step
 *  Ref      |  docs/interpreter.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Show a Python run the way a notebook cell reads: the
 *           |  code, what it printed, the error if any, and its
 *           |  figures inline, with what is happening while it runs
 *           |  ("Downloading Python", "Running · 3 s").
 *  How      |  The result is PythonRunResult (contracts). Figures load
 *           |  from Core by id (/interpreter/figures/:id), served as
 *           |  inert PNG data. Live progress comes from host.ts.
 * ------------------------------------------------------------------
 */

import { type Part, PythonRunResult } from '@nvx/contracts';
import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/api';
import { CodeBlock } from '../thread/Code';
import { Icon } from '../ui/Icon';
import { type Live, useInterpreterLive } from './host';

type ToolCall = Extract<Part, { type: 'tool_call' }>;
type ToolResult = Extract<Part, { type: 'tool_result' }>;

const STAGE: Record<Live['stage'], string> = {
  starting: 'Starting Python',
  loading: 'Loading Python (downloaded once, about 14 MB)',
  packages: 'Loading the packages it imports',
  running: 'Running',
};

export function parseRun(result: ToolResult | undefined): PythonRunResult | null {
  if (!result) return null;
  const raw = typeof result.result === 'string' ? safeJson(result.result) : result.result;
  const r = PythonRunResult.safeParse(raw);
  return r.success ? r.data : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** One short line for the step's summary: "1.2 s · 2 figures". */
export function runMeta(result: ToolResult | undefined): string | null {
  const r = parseRun(result);
  if (!r) return null;
  const secs = r.duration_ms >= 1000 ? `${(r.duration_ms / 1000).toFixed(1)} s` : `${r.duration_ms} ms`;
  const figs = r.figures.length ? ` · ${r.figures.length} figure${r.figures.length === 1 ? '' : 's'}` : '';
  return `${secs}${figs}`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  return <span data-num> · {s} s</span>;
}

export function PythonBody({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const args = (call.args ?? {}) as { code?: unknown; files?: unknown };
  const code = typeof args.code === 'string' ? args.code : '';
  const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : [];
  const live = useInterpreterLive((s) => s.calls[call.call_id]);
  const run = parseRun(result);
  const failedText = result && !result.ok && typeof result.result === 'string' && !run ? result.result : null;
  return (
    <div className="pyrun">
      <CodeBlock code={code} lang="python" title={files.length ? `Python · ${files.join(', ')}` : 'Python'} />
      {!result ? (
        <p className="pyrun__live" aria-live="polite">
          <span className="pyrun__dot" aria-hidden="true" />
          {live ? STAGE[live.stage] : 'Waiting for an NVX Ancile window to run it'}
          {live?.stage === 'running' ? <Elapsed since={live.since} /> : null}
        </p>
      ) : null}
      {run ? (
        <>
          {run.stdout ? (
            <div className="pyrun__out">
              <span className="pyrun__label">Output</span>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable output must take focus */}
              <pre data-num tabIndex={0}>
                {run.stdout}
              </pre>
            </div>
          ) : null}
          {run.figures.length ? (
            <div className="pyrun__figures">
              {run.figures.map((f) => (
                <figure key={f.id} className="pyrun__figure">
                  <img
                    src={`${API_BASE}/interpreter/figures/${encodeURIComponent(f.id)}`}
                    alt={f.alt}
                    width={f.width}
                    height={f.height}
                    loading="lazy"
                    decoding="async"
                  />
                  <figcaption>
                    {f.alt}
                    <a
                      className="icon-btn icon-btn--sm"
                      href={`${API_BASE}/interpreter/figures/${encodeURIComponent(f.id)}`}
                      download={`${f.alt.toLowerCase().replace(/\s+/g, '-')}.png`}
                      aria-label={`Download ${f.alt}`}
                    >
                      <Icon name="download" size={13} />
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          {run.stderr ? (
            <div className="pyrun__out" data-tone="warn">
              <span className="pyrun__label">Messages</span>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable output must take focus */}
              <pre tabIndex={0}>{run.stderr}</pre>
            </div>
          ) : null}
          {run.error ? (
            <div className="pyrun__out" data-tone="fail">
              <span className="pyrun__label">
                {run.error.kind === 'timeout'
                  ? 'Stopped: too slow'
                  : run.error.kind === 'memory'
                    ? 'Stopped: out of memory'
                    : run.error.kind === 'python'
                      ? 'Error'
                      : 'Could not run'}
              </span>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable output must take focus */}
              <pre tabIndex={0}>{run.error.message}</pre>
            </div>
          ) : null}
          {!run.stdout && !run.stderr && !run.error && !run.figures.length ? (
            <p className="pyrun__note">It ran and printed nothing.</p>
          ) : null}
          {run.truncated ? <p className="pyrun__note">Long output was shortened.</p> : null}
        </>
      ) : failedText ? (
        <div className="pyrun__out" data-tone="fail">
          <span className="pyrun__label">Could not run</span>
          <pre>{failedText}</pre>
        </div>
      ) : null}
    </div>
  );
}
