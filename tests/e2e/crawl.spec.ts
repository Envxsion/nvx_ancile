/**
 * Every route, every control (ROADMAP Phase 6: "all the UI needs verifying").
 *
 * For each route this visits the page, screenshots it for review, runs axe,
 * then presses every visible button, link, tab, switch and menu item one at
 * a time and checks that:
 *   - nothing throws (page errors) and nothing logs a console error,
 *   - no request fails with a 5xx,
 *   - something observable happened (navigation, a dialog, a toast, an
 *     expanded/pressed/checked state, or the page changed).
 * A control with no visible effect is reported, not failed: some are
 * legitimately quiet (copy to clipboard). The report is written to
 * crawl-report/<project>/<route>.json (and a screenshot) for review.
 *
 * Controls that destroy or reset things are never pressed (DANGER), so the
 * crawl can run against a seeded test profile (`pnpm seed --e2e`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { expectAccessible } from './fixtures';
import { BACKEND } from './playwright.config';

const DANGER =
  /delete|remove|reset|revoke|clear|discard|put every key back|terminate|restart|forget|archive|stop|sign out|log out|deactivate|uninstall|wipe|purge|undo|revert|restore|cancel run|merge|publish|export|download|csv|json|import|upload|choose a file|send|regenerate|route again|run in the lab|use this flow|turn (on|off)|activate|approve|deny|allow|always|start node|wake|accept|reject|compact|branch|fact-check|try a message|run only this|run diagnostics|run the boot|test and save|add model|add a model|save|apply/i;

/** Links that leave the app or open a new window: never followed. */
const EXTERNAL = /^(https?:)?\/\/(?!localhost|127\.0\.0\.1)/;

const CONTROLS =
  'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="checkbox"], [role="radio"], summary';

interface Finding {
  route: string;
  control: string;
  issue: string;
}

async function ids(page: Page) {
  const get = async <T>(path: string): Promise<T | null> => {
    const r = await page.request.get(`/api/v1${path}`).catch(() => null);
    return r?.ok() ? ((await r.json()) as T) : null;
  };
  const threads = await get<{ items: { id: string }[] }>('/threads');
  const notebooks = await get<{ items: { id: string }[] } | { id: string }[]>('/notebooks');
  const flows = await get<{ items: { id: string }[] } | { id: string }[]>('/flows');
  const first = (x: { items: { id: string }[] } | { id: string }[] | null) =>
    (Array.isArray(x) ? x[0] : x?.items[0])?.id;
  return { thread: threads?.items[0]?.id, notebook: first(notebooks), flow: first(flows) };
}

const ADMIN = [
  'health',
  'compute',
  'diagnostics',
  'logs',
  'traces',
  'grants',
  'decisions',
  'memory',
  'models',
  'routing',
  'plugins',
  'automations',
  'license',
];
const SETTINGS = [
  'appearance',
  'layout',
  'reading',
  'composer',
  'keyboard',
  'notifications',
  'accessibility',
  'advanced',
];

async function signature(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    const states = [
      ...document.querySelectorAll(
        '[aria-expanded],[aria-pressed],[aria-checked],[aria-selected],[data-state]',
      ),
    ]
      .map((e) =>
        ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'data-state']
          .map((a) => e.getAttribute(a) ?? '')
          .join(''),
      )
      .join('|');
    return [
      location.pathname + location.search + location.hash,
      document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]').length,
      document.querySelectorAll('[role="status"],[role="alert"],.toast').length,
      main.innerHTML.length,
      states,
      document.activeElement?.tagName ?? '',
      document.documentElement.dataset.theme ?? '',
      document.querySelector('.shell')?.getAttribute('data-rail') ?? '',
      document.querySelector('.shell')?.getAttribute('data-drawer') ?? '',
    ].join('§');
  });
}

async function describeControl(el: Locator): Promise<string> {
  return el
    .evaluate((e) => {
      const name =
        e.getAttribute('aria-label') ??
        e.getAttribute('title') ??
        (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[${e.getAttribute('role')}]` : ''} "${name}"`;
    })
    .catch(() => '');
}

test.use({ video: 'off', trace: 'off' });

const ROUTES = [
  '/',
  '/t/:thread',
  '/n/:notebook',
  '/n/:notebook/flow',
  '/flows',
  '/flows/:flow',
  ...SETTINGS.map((g) => `/settings/${g}`),
  ...ADMIN.map((s) => `/admin/${s}`),
];

test.describe('crawl', () => {
  test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
  test.setTimeout(4 * 60_000);

  test.beforeEach(({ page }) =>
    page.addInitScript(() => {
      sessionStorage.setItem('nvx.ancile.setup-offered', '1');
      // The crawl presses clipboard buttons; give them something to call.
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async () => {}, readText: async () => '' },
        configurable: true,
      });
    }),
  );

  // Pressing every switch changes preferences and memory settings, which
  // live on the server: put them back after each route so other specs (and
  // the next route) start from the same place.
  let saved: { prefs: unknown; memory: unknown } | null = null;
  test.beforeEach(async ({ request }) => {
    const prefs = await request.get('/api/v1/ui-state/prefs').then((r) => r.json());
    const memory = await request.get('/api/v1/memory/settings').then((r) => (r.ok() ? r.json() : null));
    saved = { prefs: (prefs as { value: unknown }).value, memory };
  });
  test.afterEach(async ({ page, request }) => {
    await page.close();
    if (!saved) return;
    await request.put('/api/v1/ui-state/prefs', { data: { value: saved.prefs } });
    if (saved.memory) await request.put('/api/v1/memory/settings', { data: saved.memory });
  });

  for (const pattern of ROUTES) {
    test(`${pattern} renders, is accessible, and its controls work`, async ({ page }, info) => {
      const known = await ids(page);
      const missing = [...pattern.matchAll(/:(\w+)/g)]
        .map((m) => m[1] as keyof typeof known)
        .filter((k) => !known[k]);
      test.skip(missing.length > 0, `no ${missing.join(', ')} in this workspace (pnpm seed --e2e)`);
      const route = pattern.replace(/:(\w+)/g, (_, k: keyof typeof known) => known[k] as string);
      const findings: Finding[] = [];
      const quiet: Finding[] = [];
      // The shell (titlebar, rail, status bar) is the same everywhere: press it on Home only.
      const scope = pattern === '/' ? 'body' : 'main';
      const press = !/light/.test(info.project.name); // light: render, screenshot and axe only
      const out = join('crawl-report', info.project.name);
      mkdirSync(out, { recursive: true });
      const slug = route.replace(/[/$]/g, '_') || '_root';

      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        // A stream closed by navigation is not an error the user sees.
        // Resource failures are judged from the response itself (below).
        if (/ERR_ABORTED|EventSource|Failed to load resource/.test(t)) return;
        errors.push(`console: ${t.slice(0, 200)}`);
      });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
      page.on('response', async (r) => {
        if (r.status() < 500) return;
        // Only Core's own failures count. The dev proxy answers 500 with an
        // empty body while Core restarts (hot reload), which is not a bug.
        const body = await r.text().catch(() => '');
        if (/"code"\s*:/.test(body))
          errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}: ${body.slice(0, 160)}`);
      });

      await page.goto(route);
      await page.waitForLoadState('load');
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(out, `${slug}.png`), fullPage: true });
      // The flow canvas opens at actual size on a phone, with 24px ports, so it
      // is checked like everything else.
      await expectAccessible(page).catch((e: Error) =>
        findings.push({ route, control: '(axe)', issue: e.message.split('\n').slice(0, 8).join(' / ') }),
      );
      if (errors.length) findings.push({ route, control: '(load)', issue: errors.join(' / ') });

      if (press) {
        const controls = page.locator(scope).first().locator(CONTROLS);
        const count = Math.min(await controls.count(), 60);
        for (let i = 0; i < count; i++) {
          if (page.url().replace(/^https?:\/\/[^/]+/, '') !== route) {
            await page.goto(route);
            await page.waitForTimeout(500);
          }
          const el = controls.nth(i);
          if (!(await el.isVisible().catch(() => false))) continue;
          if (await el.isDisabled().catch(() => true)) continue;
          const name = await describeControl(el);
          if (!name || DANGER.test(name)) continue;
          const href = await el.getAttribute('href').catch(() => null);
          if (href && (EXTERNAL.test(href) || href.startsWith('mailto:'))) continue;
          if ((await el.getAttribute('target').catch(() => null)) === '_blank') continue;
          const before = await signature(page);
          const errs = errors.length;
          const clicked = await el
            .click({ timeout: 1500 })
            .then(() => true)
            .catch(() => false);
          if (!clicked) continue;
          await page.waitForTimeout(250);
          const after = await signature(page).catch(() => before);
          if (after === before) quiet.push({ route, control: name, issue: 'no visible effect' });
          if (errors.length > errs)
            findings.push({ route, control: name, issue: errors.slice(errs).join(' / ') });
          // Back to a known state for the next control.
          await page.keyboard.press('Escape').catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
        }
      }

      writeFileSync(join(out, `${slug}.json`), JSON.stringify({ findings, quiet }, null, 2));
      expect(findings, findings.map((f) => `${f.control}: ${f.issue}`).join('\n')).toEqual([]);
    });
  }
});
