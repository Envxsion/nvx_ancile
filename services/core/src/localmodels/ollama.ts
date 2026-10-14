/**
 * ------------------------------------------------------------------
 *  Title    |  Ollama, as a downloader
 *  Ref      |  docs/models.md (Download a local model)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Ask Ollama its version, what models it has, and to pull
 *           |  one, following its progress.
 *  How      |  Ollama's documented HTTP API: GET /api/version, GET
 *           |  /api/tags, POST /api/show (is it there, and what it can
 *           |  do), POST /api/pull (streamed
 *           |  JSON lines: status, digest, total, completed; a final
 *           |  {"status":"success"} or an {"error"}). Every call goes
 *           |  through packages/resilience: a short timeout and retries
 *           |  for the quick calls; for the pull, opening the stream is
 *           |  guarded and the stream itself has a stall watchdog.
 *  Note     |  A pull that stops part way leaves its finished layers in
 *           |  Ollama's store, so pulling again picks up from there.
 *           |  Whether Ollama is installed (but not running) is told
 *           |  from the program on disk; it is never started here.
 * ------------------------------------------------------------------
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClassifiedError, classifyStatus, guarded } from '@nvx/resilience';
import { tracedFetch } from '../context';
import type { OllamaModelFacts } from '../gateway/ollama-discovery';

/** One line of a pull's progress. */
export interface PullEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** An error Ollama passes on from its own connection to the registry. */
export const NETWORK_TROUBLE =
  /i\/o timeout|timed? ?out|dial tcp|connection (?:reset|refused)|no such host|TLS handshake|unexpected EOF|network is unreachable/i;

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'refused' | 'stalled' | 'stream',
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

export interface OllamaClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** No bytes for this long ends a pull (it resumes on the next try). */
  stallMs?: number;
}

/** http://host:11434 from whatever was configured (a trailing /v1, a slash). */
export function ollamaBase(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/;
export function isLocalUrl(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export class OllamaClient {
  readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly stallMs: number;

  constructor(opts: OllamaClientOptions) {
    this.base = ollamaBase(opts.baseUrl);
    this.doFetch = opts.fetch ?? (tracedFetch as typeof fetch);
    this.stallMs = opts.stallMs ?? 120_000;
  }

  private async json<T>(path: string, init: RequestInit = {}, timeoutMs = 4_000): Promise<T> {
    return guarded(
      { key: `ollama:${this.base}`, timeoutMs, retry: { maxAttempts: 2, baseMs: 200 } },
      async (signal) => {
        const res = await this.doFetch(`${this.base}${path}`, { ...init, signal });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ClassifiedError(
            classifyStatus(res.status, text),
            `Ollama answered ${res.status}: ${text.slice(0, 200)}`,
            {
              status: res.status,
            },
          );
        }
        return (await res.json()) as T;
      },
    );
  }

  /** Ollama's version, or null when it does not answer. */
  async version(): Promise<string | null> {
    try {
      return (await this.json<{ version?: string }>('/api/version', {}, 2_500)).version ?? 'unknown';
    } catch {
      return null;
    }
  }

  /** The models Ollama has, by tag ("qwen3:8b"). */
  async tags(): Promise<{ name: string; size: number; digest: string }[]> {
    const r = await this.json<{
      models?: { name: string; model?: string; size?: number; digest?: string }[];
    }>('/api/tags');
    return (r.models ?? []).map((m) => ({
      name: m.name ?? m.model ?? '',
      size: m.size ?? 0,
      digest: m.digest ?? '',
    }));
  }

  /**
   * What Ollama says one model can do (its capabilities, newer Ollama only)
   * and the context it was trained for; null when it cannot say.
   */
  async facts(model: string): Promise<OllamaModelFacts | null> {
    try {
      const r = await this.json<{ capabilities?: unknown; model_info?: Record<string, unknown> }>(
        '/api/show',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        },
      );
      const caps = Array.isArray(r.capabilities)
        ? r.capabilities.filter((c): c is string => typeof c === 'string')
        : [];
      const context = Object.entries(r.model_info ?? {}).find(
        ([k, v]) => k.endsWith('.context_length') && typeof v === 'number' && v > 0,
      )?.[1] as number | undefined;
      return { capabilities: caps.length ? caps : null, context: context ?? null };
    } catch {
      return null;
    }
  }

  /** Ollama knows this model and can load it: the check after a pull. */
  async has(model: string): Promise<boolean> {
    try {
      await this.json('/api/show', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      return true;
    } catch (err) {
      if (err instanceof ClassifiedError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Pull a model, yielding each progress line. Opening the stream is
   * retried; a stream that goes quiet for stallMs, or ends without
   * "success", throws OllamaError and can simply be pulled again.
   */
  async *pull(model: string, signal: AbortSignal): AsyncGenerator<PullEvent> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await guarded(
        { key: `ollama:${this.base}`, timeoutMs: 30_000, retry: { maxAttempts: 3, baseMs: 500 }, signal },
        async () => {
          const r = await this.doFetch(`${this.base}/api/pull`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, stream: true }),
            signal: ctrl.signal,
          });
          if (!r.ok || !r.body) {
            const text = await r.text().catch(() => '');
            throw new ClassifiedError(
              classifyStatus(r.status, text),
              `Ollama answered ${r.status}: ${text.slice(0, 300)}`,
              {
                status: r.status,
              },
            );
          }
          return r;
        },
      ).catch((err: unknown) => {
        if (signal.aborted) throw err;
        if (err instanceof ClassifiedError && err.status && err.status < 500)
          throw new OllamaError(err.message, 'refused');
        throw new OllamaError((err as Error).message, 'unreachable');
      });

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done = false;
      let stall: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(
          () => ctrl.abort(new OllamaError('Ollama stopped sending progress', 'stalled')),
          this.stallMs,
        );
      };
      try {
        arm();
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (err) {
            if (signal.aborted) throw err;
            const reason = ctrl.signal.reason;
            throw reason instanceof OllamaError ? reason : new OllamaError((err as Error).message, 'stream');
          }
          if (chunk.done) break;
          arm();
          buf += decoder.decode(chunk.value, { stream: true });
          let nl = buf.indexOf('\n');
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
            if (!line) continue;
            let ev: PullEvent;
            try {
              ev = JSON.parse(line) as PullEvent;
            } catch {
              continue;
            }
            // Ollama reports its own network trouble (registry timeouts, resets) the
            // same way as a refusal: that is a stalled download, and Resume fixes it.
            if (ev.error)
              throw new OllamaError(ev.error, NETWORK_TROUBLE.test(ev.error) ? 'stalled' : 'refused');
            yield ev;
            if (ev.status === 'success') done = true;
          }
        }
      } finally {
        clearTimeout(stall);
        reader.releaseLock();
      }
      if (!done && !signal.aborted)
        throw new OllamaError('The download ended before Ollama said it was complete', 'stream');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Ollama's program on this computer, if it is installed where its installers put it or on PATH. */
export async function ollamaInstalled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const exe = platform === 'win32' ? 'ollama.exe' : 'ollama';
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const places = [
    ...dirs.map((d) => join(d, exe)),
    ...(platform === 'win32' && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Ollama', exe)] : []),
    ...(platform === 'darwin'
      ? ['/Applications/Ollama.app', join(homedir(), 'Applications', 'Ollama.app')]
      : []),
  ];
  for (const p of places)
    if (
      await stat(p).then(
        () => true,
        () => false,
      )
    )
      return true;
  return false;
}

/** The official download page, and on Linux the official install command to copy. */
export function ollamaDownload(platform: NodeJS.Platform = process.platform): {
  url: string;
  command: string | null;
} {
  if (platform === 'win32') return { url: 'https://ollama.com/download/windows', command: null };
  if (platform === 'darwin') return { url: 'https://ollama.com/download/mac', command: null };
  return {
    url: 'https://ollama.com/download/linux',
    command: 'curl -fsSL https://ollama.com/install.sh | sh',
  };
}
