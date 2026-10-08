/**
 * Against a real Core, finish onboarding once before the suite so specs
 * start in the app rather than on the first-run screen. The onboarding
 * spec opens /setup directly, which works either way.
 */
import type { FullConfig } from '@playwright/test';

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
  const res = await fetch(`${base}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'balanced' }),
  });
  if (!res.ok) throw new Error(`Could not finish setup on ${base}: ${res.status} ${await res.text()}`);
}
