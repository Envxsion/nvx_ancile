/**
 * ------------------------------------------------------------------
 *  Title    |  Record real web-search replies (dev only)
 *  Ref      |  docs/testing.md (Recorded provider replies)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep one real, redacted reply per fact-check web route so
 *           |  the parsers can be tested against what providers send.
 *  How      |  POST /diagnostics/web-record arms the next lookup of each
 *           |  route (in memory, 10 minutes, one capture per route). The
 *           |  route wraps its fetch, keeps the response body, redacts it
 *           |  and writes <data dir>/diagnostics/web/<route>.json.
 *  Note     |  Off by default. Headers are never read or stored. Review
 *           |  a file before copying it into test/fixtures/web/.
 * ------------------------------------------------------------------
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppEnv } from '../app';

export const ARM_MS = 10 * 60_000;
const ROUTE_IDS = ['google', 'openrouter', 'anthropic'] as const;
export type RecordRoute = (typeof ROUTE_IDS)[number];

const MASKED_FIELD = /^(encrypted_content|encrypted_index|signature|id)$/;
const ID_PATTERN = /\b(sk|msg|srvtoolu|toolu|gen|req|resp)[-_][A-Za-z0-9_-]{8,}/g;

/** Mask the key, call ids and encrypted blobs; page text and links stay. */
export function redact(v: unknown, secrets: string[] = []): unknown {
  if (typeof v === 'string') {
    let s = v;
    for (const k of secrets) if (k) s = s.split(k).join('[redacted]');
    return s.replace(ID_PATTERN, '$1-[redacted]');
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, secrets));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = MASKED_FIELD.test(k) ? '[redacted]' : redact(x, secrets);
    return out;
  }
  return v;
}

export class WebRecorder {
  private armedAt: number | null = null;
  private pending = new Set<RecordRoute>();
  private written: string[] = [];
  private saving: Promise<unknown>[] = [];

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  arm() {
    this.armedAt = this.now();
    this.pending = new Set(ROUTE_IDS);
    this.written = [];
  }

  /** The routes still waiting for a lookup; empty when not armed or expired. */
  private waiting(): RecordRoute[] {
    if (this.armedAt === null) return [];
    if (this.now() - this.armedAt > ARM_MS) {
      this.armedAt = null;
      this.pending.clear();
      return [];
    }
    return [...this.pending];
  }

  state() {
    const waiting = this.waiting();
    return {
      armed: waiting.length > 0,
      waiting,
      expires_at:
        waiting.length && this.armedAt !== null ? new Date(this.armedAt + ARM_MS).toISOString() : null,
      written: [...this.written],
    };
  }

  /** The fetch a route should use: the real one, or one that keeps this lookup's reply body. */
  wrap(route: string, model: string, query: string, key: string, real: typeof fetch): typeof fetch {
    if (!this.waiting().includes(route as RecordRoute)) return real;
    this.pending.delete(route as RecordRoute);
    return async (input, init) => {
      const res = await real(input, init);
      if (res.ok) {
        const text = await res.clone().text();
        this.saving.push(this.save(route, model, query, key, text).catch(() => undefined));
      }
      return res;
    };
  }

  /** Resolves when every capture so far is on disk (for tests). */
  async settled(): Promise<void> {
    await Promise.all(this.saving);
  }

  private async save(route: string, model: string, query: string, key: string, text: string) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    const folder = join(this.dir, 'diagnostics', 'web');
    await mkdir(folder, { recursive: true });
    const saved = {
      route,
      query,
      model,
      recorded: new Date(this.now()).toISOString().slice(0, 10),
      response: redact(body, [key]),
    };
    await writeFile(join(folder, `${route}.json`), `${JSON.stringify(saved, null, 2)}\n`);
    this.written.push(`${route}.json`);
  }

  async files(): Promise<string[]> {
    return readdir(join(this.dir, 'diagnostics', 'web')).catch(() => []);
  }
}

export function webRecordRoutes(deps: { recorder: WebRecorder }) {
  const r = new Hono<AppEnv>();
  r.post('/diagnostics/web-record', async (c) => {
    deps.recorder.arm();
    return c.json({ ...deps.recorder.state(), files: await deps.recorder.files() }, 202);
  });
  r.get('/diagnostics/web-record', async (c) =>
    c.json({ ...deps.recorder.state(), files: await deps.recorder.files() }),
  );
  return r;
}
