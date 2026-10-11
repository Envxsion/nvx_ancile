/**
 * ------------------------------------------------------------------
 *  Title    |  Bridge logging and calls out
 *  Ref      |  services/claude-bridge/LICENSE (MIT)
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  JSON log lines on stderr (Core collects them), and the
 *           |  one network call the bridge makes, with a timeout and a
 *           |  few retries.
 *  How      |  The bridge is MIT and a separate program, so it cannot
 *           |  use Ancile's GPL resilience package; this is the same
 *           |  policy (timeout per attempt, capped jittered backoff,
 *           |  retry only what can succeed later) in a few lines.
 *  Note     |  Never log message contents, account details or tokens.
 * ------------------------------------------------------------------
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = RANK[(process.env.ANCILE_LOG_LEVEL as Level) ?? 'info'] ?? RANK.info;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (RANK[level] < threshold) return;
  const line = { level, time: new Date().toISOString(), service: 'claude-bridge', msg, ...fields };
  try {
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    /* stderr closed: nothing to do */
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const retryable = (err: unknown) => !(err instanceof HttpError) || err.status === 429 || err.status >= 500;

/** Fetch a URL's body, with a timeout per attempt and up to `attempts` tries. */
export async function fetchBytes(
  url: string,
  opts: { timeoutMs?: number; attempts?: number; maxBytes?: number; fetch?: typeof fetch } = {},
): Promise<Buffer> {
  const attempts = opts.attempts ?? 3;
  const doFetch = opts.fetch ?? fetch;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
      if (!res.ok) throw new HttpError(res.status, `${new URL(url).host} answered ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (opts.maxBytes && buf.length > opts.maxBytes)
        throw new HttpError(413, 'The download is larger than expected');
      return buf;
    } catch (err) {
      last = err;
      if (!retryable(err) || i === attempts) break;
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * Math.min(8000, 500 * 2 ** i))));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
