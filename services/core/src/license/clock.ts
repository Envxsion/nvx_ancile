/**
 * ------------------------------------------------------------------
 *  Title    |  Licence clock
 *  Ref      |  DESIGN.md §9 · the NVX family's time floor
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Expiry is checked against a time that only moves
 *           |  forward, so winding the computer's clock back does not
 *           |  keep an expired licence alive.
 *  How      |  A floor kept in settings, raised by this computer's own
 *           |  clock as time passes, by each token's issue time, and
 *           |  by the licence server's Date header. "Now" is the later
 *           |  of the clock and the floor. Saved at most once a minute
 *           |  unless it jumps.
 * ------------------------------------------------------------------
 */

import type { SettingsStore } from '../settings';

const KEY = 'license.time_floor';
const SAVE_EVERY_MS = 60_000;

export class LicenceClock {
  private floor = 0;
  private saved = 0;

  constructor(
    private readonly settings: SettingsStore,
    private readonly clock: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const v = await this.settings.get<number>(KEY);
    if (typeof v === 'number' && Number.isFinite(v)) {
      this.floor = Math.max(this.floor, v);
      this.saved = v;
    }
    this.observe(this.clock());
  }

  /** The time to check expiry against: never earlier than anything seen before. */
  now(): number {
    const t = this.clock();
    if (t > this.floor) this.observe(t);
    return Math.max(t, this.floor);
  }

  /** True when this computer's clock is well behind the floor (it was wound back). */
  behind(toleranceMs = 5 * 60_000): boolean {
    return this.clock() + toleranceMs < this.floor;
  }

  /** A trusted moment: a token's issue time, the server's Date header, or the clock. */
  observe(ms: number): void {
    // Every source is trusted: this computer's clock, a token's issue time
    // (signed by nvx.sh) and the licence server's Date header (over HTTPS).
    if (!Number.isFinite(ms) || ms <= this.floor) return;
    this.floor = ms;
    if (ms - this.saved >= SAVE_EVERY_MS) {
      this.saved = ms;
      void this.settings.set(KEY, ms).catch(() => undefined);
    }
  }

  /** Read a Date header from a licence server reply. */
  observeHeader(date: string | null | undefined): void {
    if (!date) return;
    const ms = Date.parse(date);
    if (Number.isFinite(ms)) this.observe(ms);
  }
}
