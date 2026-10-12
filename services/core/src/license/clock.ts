/**
 * ------------------------------------------------------------------
 *  Title    |  Licence clock
 *  Ref      |  DESIGN.md §9 · the NVX family's time floor · ROADMAP.md track G
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Expiry is checked against a time that only moves
 *           |  forward, so winding the computer's clock back does not
 *           |  keep an expired licence alive; and a clock set ahead
 *           |  does not end a licence early.
 *  How      |  Kept in settings:
 *           |  - the trusted floor, raised only by nvx.sh's time (its
 *           |    Date header) and a token's issue time;
 *           |  - the last check: nvx.sh's time and this computer's
 *           |    clock at that moment;
 *           |  - the local floor, raised by this computer's clock.
 *           |  The last check says roughly what time it is now: its
 *           |  server time plus the time since (measured on the
 *           |  monotonic clock while Core runs, on this computer's
 *           |  clock across a restart). This computer's clock is
 *           |  believed while it is within 10 minutes of that; outside
 *           |  it (set ahead, or clearly behind) the estimate is used.
 *           |  "Now" is never earlier than either floor.
 *           |  When nvx.sh's time arrives well before the local floor,
 *           |  the floor was raised by a clock set ahead: it comes back.
 *  Note     |  Saved at most once a minute unless it jumps.
 * ------------------------------------------------------------------
 */

import type { SettingsStore } from '../settings';

const KEY = 'license.time_floor';
const TRUSTED_KEY = 'license.trusted_floor';
const SERVER_KEY = 'license.server_time';
const SAVE_EVERY_MS = 60_000;
/** How far from nvx.sh's time this computer's clock is still believed. */
export const CLOCK_SKEW_MS = 10 * 60_000;

/** nvx.sh's time at the last check, and this computer's clock at that moment. */
interface ServerTime {
  server: number;
  local: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class LicenceClock {
  /** Raised by this computer's clock (never past the last check's estimate). */
  private floor = 0;
  /** Raised only by nvx.sh's time and token issue times. */
  private trusted = 0;
  private last: ServerTime | null = null;
  /** The monotonic clock when `last` was seen in this process (null after a restart). */
  private lastMono: number | null = null;
  private saved = 0;
  private savedTrusted = 0;

  constructor(
    private readonly settings: SettingsStore,
    private readonly clock: () => number = Date.now,
    /** Elapsed time that the computer's clock setting cannot move. */
    private readonly mono: () => number = () => performance.now(),
  ) {}

  async load(): Promise<void> {
    const [v, t, s] = await Promise.all([
      this.settings.get<number>(KEY),
      this.settings.get<number>(TRUSTED_KEY),
      this.settings.get<ServerTime>(SERVER_KEY),
    ]);
    if (finite(v)) {
      this.floor = Math.max(this.floor, v);
      this.saved = v;
    }
    if (finite(t)) {
      this.trusted = Math.max(this.trusted, t);
      this.savedTrusted = t;
    }
    if (s && finite(s.server) && finite(s.local) && !this.last) this.last = s;
    this.tick();
  }

  /** What the last check says the time is now (null before any check). */
  estimate(): number | null {
    if (!this.last) return null;
    const elapsed = this.lastMono !== null ? this.mono() - this.lastMono : this.clock() - this.last.local;
    return this.last.server + Math.max(0, elapsed);
  }

  /** The time to check expiry against: never earlier than anything seen before. */
  now(): number {
    return Math.max(this.tick(), this.floor, this.trusted);
  }

  /** How far this computer's clock was from nvx.sh's at the last check (ms; positive: behind). */
  offset(): number | null {
    return this.last ? this.last.server - this.last.local : null;
  }

  /** True when this computer's clock is well behind the time already seen (it was wound back). */
  behind(toleranceMs = 5 * 60_000): boolean {
    return this.clock() + toleranceMs < Math.max(this.floor, this.trusted);
  }

  /** A moment that has certainly passed: a token's issue time (signed by nvx.sh). */
  observe(ms: number): void {
    if (!finite(ms) || ms <= this.trusted) return;
    this.trusted = ms;
    if (ms - this.savedTrusted >= SAVE_EVERY_MS) {
      this.savedTrusted = ms;
      void this.settings.set(TRUSTED_KEY, ms).catch(() => undefined);
    }
  }

  /** nvx.sh's own time (its Date header, over HTTPS): trusted, and the reference for this computer's clock. */
  observeServer(ms: number): void {
    if (!finite(ms)) return;
    this.last = { server: ms, local: this.clock() };
    this.lastMono = this.mono();
    void this.settings.set(SERVER_KEY, this.last).catch(() => undefined);
    // A local floor well ahead of nvx.sh came from a clock set ahead: bring it back.
    if (this.floor > ms + CLOCK_SKEW_MS) {
      this.floor = Math.max(ms, this.trusted);
      this.saved = this.floor;
      void this.settings.set(KEY, this.floor).catch(() => undefined);
    }
    this.observe(ms);
  }

  /** Read a Date header from a licence server reply. */
  observeHeader(date: string | null | undefined): void {
    if (!date) return;
    const ms = Date.parse(date);
    if (Number.isFinite(ms)) this.observeServer(ms);
  }

  /**
   * This computer's clock while it is within the skew of the last check's
   * estimate, the estimate when it is not; raises the local floor.
   */
  private tick(): number {
    const est = this.estimate();
    const local = this.clock();
    const t = est === null || Math.abs(local - est) <= CLOCK_SKEW_MS ? local : est;
    if (t > this.floor) {
      this.floor = t;
      if (t - this.saved >= SAVE_EVERY_MS) {
        this.saved = t;
        void this.settings.set(KEY, t).catch(() => undefined);
      }
    }
    return t;
  }
}
