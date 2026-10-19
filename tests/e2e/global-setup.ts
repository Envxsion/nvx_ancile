/**
 * Against a real Core, finish onboarding once before the suite so specs
 * start in the app rather than on the first-run screen. The onboarding
 * spec opens /setup directly, which works either way.
 */
import type { FullConfig } from '@playwright/test';

/**
 * The model every new thread starts on in the suite: the offline test model, the one that obeys /say,
 * /slow, /fail and /tool. Core keeps no default model: the default is a Cockpit preference (Zustand,
 * `nvx.ancile.ui` in localStorage), and without one the Cockpit takes the first real model that can
 * answer, which was Claude Code whenever it was found. playwright.config.ts seeds this as the
 * preference in every browser context.
 */
export const E2E_DEFAULT_MODEL = 'offline/test';
export const UI_STORE_KEY = 'nvx.ancile.ui';
/** The Cockpit's persisted UI state with the default model set (state/ui.ts partialize). */
export const uiStateWithDefaultModel = (modelId: string = E2E_DEFAULT_MODEL) =>
  JSON.stringify({ state: { live: { modelId } }, version: 0 });

/**
 * Preferences live in Core too (ui-state "prefs") and a browser adopts Core's copy when it is newer than its
 * own. A journey that changes one (the status bar, the theme, a settings switch) would then leak into every
 * browser that starts after it. Seeding a changedAt that nothing can beat keeps each browser on its own
 * preferences (state/prefs.ts adoptRemotePrefs); the stored prefs are left out so the defaults, and the
 * legacy theme key, still apply.
 */
export const PREFS_STORE_KEY = 'nvx.ancile.prefs';
export const prefsStateNeverAdoptingCore = () =>
  JSON.stringify({ state: { changedAt: Number.MAX_SAFE_INTEGER }, version: 2 });

/** The test profile's ports (scripts/runtime.mjs E2E_PORTS): Cockpit and Core. */
const E2E_PORTS = new Set(['7801', '7800']);

export default async function globalSetup(config: FullConfig) {
  if (!process.env.E2E_BACKEND) return;
  // Backend specs create threads, sources and approvals. Run them against
  // `pnpm start:e2e` (its own database) so they never land in your workspace.
  const base = config.projects[0]?.use.baseURL ?? 'http://localhost:7801';
  if (!E2E_PORTS.has(new URL(base).port) && !process.env.E2E_ALLOW_DEV_DB)
    throw new Error(
      `${base} is not the test profile. Start it with pnpm start:e2e (it runs beside your everyday stack), or set E2E_ALLOW_DEV_DB=1 to write to your own workspace on purpose.`,
    );
  // Core may be mid-restart (hot reload); give it a minute to answer.
  const until = Date.now() + 60_000;
  for (;;) {
    const health = await fetch(`${base}/api/v1/system/health`).catch(() => null);
    if (health?.ok) break;
    if (Date.now() > until)
      throw new Error(`Nothing answers at ${base}. Start the test profile with pnpm start:e2e.`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  await assertTestProfileIsSafe(base);
  // Earlier runs (and the crawl) may have left preferences in this profile's Core: start from none.
  await fetch(`${base}/api/v1/ui-state/prefs`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: null }),
  }).catch(() => undefined);
  const res = await fetch(`${base}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'balanced' }),
  });
  if (!res.ok) throw new Error(`Could not finish setup on ${base}: ${res.status} ${await res.text()}`);
}

interface ModelRow {
  id: string;
  provider: string;
  via: string;
  status?: string;
}

/**
 * Fail fast, before any spec runs, if this Core could reach a paid model: Claude Code must read as
 * off, no Claude Code model may be listed, and the default must be an offline model that can answer.
 * (Once, the suite imported the owner's real sessions and started live Claude Code turns.)
 */
async function assertTestProfileIsSafe(base: string): Promise<void> {
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${base}/api/v1${path}`);
    if (!r.ok) throw new Error(`GET ${path} on ${base} answered ${r.status}. Is this the test profile?`);
    return (await r.json()) as T;
  };
  const cc = await get<{ installed: boolean; off_reason?: string | null }>('/claude-code/status');
  if (!cc.off_reason || cc.installed)
    throw new Error(
      `Core at ${base} reports Claude Code as on. The suite would drive your real sessions and plan. Restart it with pnpm start:e2e (ANCILE_PROFILE=e2e switches Claude Code off).`,
    );
  const { items } = await get<{ items: ModelRow[] }>('/models');
  const claude = items.filter((m) => m.provider === 'claude_code' || m.id.startsWith('claude_code/'));
  if (claude.length)
    throw new Error(
      `Core lists Claude Code models in the test profile: ${claude.map((m) => m.id).join(', ')}`,
    );
  const def = items.find((m) => m.id === E2E_DEFAULT_MODEL);
  if (def?.provider !== 'fake' || (def.status && def.status !== 'ready'))
    throw new Error(
      `The default model ${E2E_DEFAULT_MODEL} is not an offline model that can answer on ${base} (found: ${def ? `${def.provider}, ${def.status}` : 'nothing'}). Is ANCILE_OFFLINE_MODELS on?`,
    );
}
