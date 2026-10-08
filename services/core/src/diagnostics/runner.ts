/**
 * ------------------------------------------------------------------
 *  Title    |  Self-diagnostic
 *  Ref      |  DESIGN.md §14 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One button that checks everything NVX Ancile depends on
 *           |  and says, for anything wrong, what to do about it.
 *  How      |  Checks are plain functions grouped by area. A run starts
 *           |  them four at a time and streams each result as it lands
 *           |  (SSE), then keeps the whole run in core.diagnostics. A
 *           |  check that throws has failed; one that is slow is cut
 *           |  off after 30 s and says so. When Core runs from a source
 *           |  checkout, the boot test suite runs too, as one check.
 * ------------------------------------------------------------------
 */

import type { DiagnosticCheck, DiagnosticRun } from '@nvx/contracts';
import { ulid } from 'ulid';
import { logFor } from '../obs/logger';

const log = logFor('diagnostics');

export type CheckOutcome = {
  status: 'passed' | 'warned' | 'failed' | 'skipped';
  detail?: string;
  fix?: string;
};

export interface CheckSpec {
  id: string;
  group: DiagnosticCheck['group'];
  title: string;
  run: (signal: AbortSignal) => Promise<CheckOutcome>;
  /** Shown when the check fails without saying how to fix it. */
  fix?: string;
  timeoutMs?: number;
}

export interface DiagnosticStore {
  save(run: DiagnosticRun): Promise<void>;
  recent(limit: number): Promise<DiagnosticRun[]>;
}

export type DiagnosticEvent =
  | { seq: number; type: 'check'; check: DiagnosticCheck }
  | { seq: number; type: 'done'; run: DiagnosticRun };

type Listener = (e: DiagnosticEvent) => void;

interface Live {
  run: DiagnosticRun;
  events: DiagnosticEvent[];
  listeners: Set<Listener>;
}

const CONCURRENCY = 4;

export class DiagnosticRunner {
  private live = new Map<string, Live>();

  constructor(
    private readonly checks: () => CheckSpec[],
    private readonly store: DiagnosticStore | null,
  ) {}

  start(): DiagnosticRun {
    const specs = this.checks();
    const run: DiagnosticRun = {
      id: `dgn_${ulid()}`,
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      checks: specs.map((s) => ({
        id: s.id,
        group: s.group,
        title: s.title,
        status: 'pending',
        detail: null,
        fix: null,
        ms: null,
      })),
    };
    const entry: Live = { run, events: [], listeners: new Set() };
    this.live.set(run.id, entry);
    // Forget finished runs after an hour; the database keeps them.
    for (const [id, l] of this.live)
      if (l.run.finished_at && Date.now() - Date.parse(l.run.finished_at) > 3_600_000) this.live.delete(id);
    void this.execute(entry, specs);
    return run;
  }

  get(id: string): DiagnosticRun | undefined {
    return this.live.get(id)?.run;
  }

  async recent(limit = 10): Promise<DiagnosticRun[]> {
    const mem = [...this.live.values()].map((l) => l.run);
    const stored = (await this.store?.recent(limit).catch(() => [])) ?? [];
    const seen = new Set(mem.map((r) => r.id));
    return [...mem, ...stored.filter((r) => !seen.has(r.id))]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit);
  }

  /** Replay what happened so far, then follow. */
  subscribe(id: string, after: number, fn: Listener): (() => void) | null {
    const l = this.live.get(id);
    if (!l) return null;
    for (const e of l.events) if (e.seq > after) fn(e);
    if (l.run.status !== 'running') return () => undefined;
    l.listeners.add(fn);
    return () => l.listeners.delete(fn);
  }

  /** Wait for a run to finish (tests, and the CLI). */
  async settle(id: string): Promise<DiagnosticRun | undefined> {
    for (let i = 0; i < 600; i++) {
      const r = this.get(id);
      if (r?.status !== 'running') return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    return this.get(id);
  }

  private emit(l: Live, e: { type: 'check'; check: DiagnosticCheck } | { type: 'done'; run: DiagnosticRun }) {
    const event = { ...e, seq: l.events.length + 1 } as DiagnosticEvent;
    l.events.push(event);
    for (const fn of l.listeners) fn(event);
  }

  private async execute(l: Live, specs: CheckSpec[]) {
    const queue = specs.map((s, i) => ({ s, i }));
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { s, i } = next;
        const slot = l.run.checks[i] as DiagnosticCheck;
        slot.status = 'running';
        this.emit(l, { type: 'check', check: { ...slot } });
        const started = performance.now();
        let out: CheckOutcome;
        const timeout = AbortSignal.timeout(s.timeoutMs ?? 30_000);
        try {
          out = await Promise.race([
            s.run(timeout),
            new Promise<CheckOutcome>((_, reject) =>
              timeout.addEventListener('abort', () =>
                reject(new Error(`did not finish within ${Math.round((s.timeoutMs ?? 30_000) / 1000)} s`)),
              ),
            ),
          ]);
        } catch (err) {
          out = { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
        }
        Object.assign(slot, {
          status: out.status,
          detail: out.detail ?? null,
          fix: out.status === 'failed' || out.status === 'warned' ? (out.fix ?? s.fix ?? null) : null,
          ms: Math.round(performance.now() - started),
        });
        this.emit(l, { type: 'check', check: { ...slot } });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    l.run.status = l.run.checks.some((c) => c.status === 'failed') ? 'failed' : 'passed';
    l.run.finished_at = new Date().toISOString();
    this.emit(l, { type: 'done', run: l.run });
    l.listeners.clear();
    const failed = l.run.checks.filter((c) => c.status === 'failed').map((c) => c.id);
    if (failed.length) log.warn({ run: l.run.id, failed }, 'self-diagnostic found problems');
    else log.info({ run: l.run.id }, 'self-diagnostic passed');
    await this.store
      ?.save(l.run)
      .catch((err: unknown) => log.error({ err }, 'could not keep the diagnostic run'));
  }
}
