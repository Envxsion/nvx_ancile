/**
 * Against a real Core, finish onboarding once before the suite so specs
 * start in the app rather than on the first-run screen. The onboarding
 * spec opens /setup directly, which works either way.
 *
 * Core answers /api/v1 only to its owner (docs/api.md, Calling the API), so
 * this also connects the suite's browsers: it reads the test profile's install
 * key (data/e2e/local-api.key; E2E_KEY_FILE names another), asks Core for a
 * one-time code, spends it at the pairing address and saves the session
 * cookie it gets, with the UI preferences below, as the storage state every
 * browser starts from. The key is sent as a Bearer token and never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Where the paired browsers' storage state is saved (git-ignored). */
export const E2E_AUTH_STATE = fileURLToPath(new URL('./.auth/state.json', import.meta.url));

/** The test profile's install key file: data/e2e/local-api.key, unless E2E_KEY_FILE says otherwise. */
export const E2E_KEY_FILE =
  process.env.E2E_KEY_FILE ?? fileURLToPath(new URL('../../data/e2e/local-api.key', import.meta.url));

/** The install key, or null when Core has not made it yet. Never log it. */
function readKey(): string | null {
  try {
    const key = readFileSync(E2E_KEY_FILE, 'utf8').trim();
    return /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

export default async function globalSetup(config: FullConfig) {
  if (!process.env.E2E_BACKEND) {
    // Fixtures only: refuse to start if a real Core answers behind this Cockpit (your workspace).
    if (process.env.E2E_BASE_URL) return;
    const base = config.projects[0]?.use.baseURL ?? '';
    const health = await fetch(`${base}/api/v1/system/health`).catch(() => null);
    // A real Core answers a stranger with 401 (it wants the install key), so any answer from it counts.
    if (health && (health.ok || health.status === 401 || health.status === 403))
      throw new Error(
        `A real Core answers behind ${base}. The fixtures-only specs must not touch a workspace: stop whatever serves that port, or run the suite against the test profile with E2E_BACKEND=1 and pnpm start:e2e.`,
      );
    return;
  }
  // Backend specs create threads, sources and approvals. Run them against
  // `pnpm start:e2e` (its own database) so they never land in your workspace.
  const base = config.projects[0]?.use.baseURL ?? 'http://localhost:7801';
  if (!E2E_PORTS.has(new URL(base).port) && !process.env.E2E_ALLOW_DEV_DB)
    throw new Error(
      `${base} is not the test profile. Start it with pnpm start:e2e (it runs beside your everyday stack), or set E2E_ALLOW_DEV_DB=1 to write to your own workspace on purpose.`,
    );
  // Core may be mid-restart (hot reload); give it a minute to answer, and to make its key on a first start.
  const until = Date.now() + 60_000;
  let key: string | null = null;
  for (;;) {
    key = readKey();
    const health = key
      ? await fetch(`${base}/api/v1/system/health`, { headers: asOwner(key) }).catch(() => null)
      : null;
    if (health?.ok) break;
    if (Date.now() > until)
      throw new Error(
        key
          ? `Nothing answers at ${base}, or Core did not accept the install key in ${E2E_KEY_FILE}. Start the test profile with pnpm start:e2e.`
          : `There is no install key at ${E2E_KEY_FILE}. Core makes it the first time it starts: start the test profile with pnpm start:e2e.`,
      );
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!key) throw new Error(`There is no install key at ${E2E_KEY_FILE}.`);
  const auth = asOwner(key);
  await assertTestProfileIsSafe(base, auth);
  // Earlier runs (and the crawl) may have left preferences in this profile's Core: start from none.
  await fetch(`${base}/api/v1/ui-state/prefs`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ value: null }),
  }).catch(() => undefined);
  // Connect the suite's browsers first: finishing setup sets the permission preset, which is the paired
  // browser's alone (a script with the key is refused), so it goes through the session like the Cockpit does.
  const session = await saveBrowserState(base, auth);
  const res = await fetch(`${base}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session, origin: new URL(base).origin },
    body: JSON.stringify({ preset: 'balanced' }),
  });
  if (!res.ok) throw new Error(`Could not finish setup on ${base}: ${res.status} ${await res.text()}`);
}

const asOwner = (key: string) => ({ authorization: `Bearer ${key}` });

/**
 * Connect a browser the way `pnpm pair` does, and write what every suite browser starts from: the session
 * cookie, and the preferences the suite seeds in localStorage. Returns the cookie as a request header value.
 */
async function saveBrowserState(base: string, auth: Record<string, string>): Promise<string> {
  const minted = await fetch(`${base}/api/v1/session/pair-codes`, { method: 'POST', headers: auth });
  if (!minted.ok) throw new Error(`Core did not give a pairing code on ${base}: ${minted.status}`);
  const { code } = (await minted.json()) as { code: string };
  const paired = await fetch(`${base}/api/v1/session/pair?code=${encodeURIComponent(code)}`, {
    redirect: 'manual',
  });
  const setCookie = paired.headers.getSetCookie().find((c) => c.startsWith('ancile_session_'));
  if (paired.status !== 303 || !setCookie)
    throw new Error(`Core did not pair the suite's browsers on ${base} (answered ${paired.status}).`);
  const [pair = ''] = setCookie.split(';');
  const eq = pair.indexOf('=');
  const origin = new URL(base).origin;
  const state = {
    cookies: [
      {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        domain: new URL(base).hostname,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        httpOnly: true,
        secure: false,
        sameSite: 'Strict' as const,
      },
    ],
    origins: [
      {
        origin,
        localStorage: [
          { name: UI_STORE_KEY, value: uiStateWithDefaultModel() },
          { name: PREFS_STORE_KEY, value: prefsStateNeverAdoptingCore() },
        ],
      },
    ],
  };
  mkdirSync(dirname(E2E_AUTH_STATE), { recursive: true });
  writeFileSync(E2E_AUTH_STATE, JSON.stringify(state), { mode: 0o600 });
  return pair;
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
async function assertTestProfileIsSafe(base: string, auth: Record<string, string>): Promise<void> {
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${base}/api/v1${path}`, { headers: auth });
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
