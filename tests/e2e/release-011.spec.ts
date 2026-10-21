/**
 * QA1: journeys for what 0.1.1 built, on the offline test model (/say, /slow,
 * /fail directives), so nothing here needs a key or a network. Each journey is
 * independent: it makes its own threads, with unique titles, and asserts on
 * settled state (an answer finished, a notice shown), never on a stream.
 *
 * Bugs these guard against: a blank Usage tab, hidden models, a fact-check
 * error with no message, a screen that fell into its error boundary.
 *
 * Selectors are roles and accessible names only. Run against the test profile
 * (`pnpm start:e2e`, then E2E_BACKEND=1), seeded with `pnpm seed --e2e`.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, mod } from './fixtures';
import { BACKEND } from './playwright.config';

const lastAnswer = (page: Page) => page.locator('article.msg[data-role="assistant"]').last();
const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * A thread pinned to the offline test model, with its first answer settled. New threads on Home start
 * on the user's default model (Claude Code when it is signed in), so a journey never starts there.
 */
async function newAnswer(page: Page, text: string) {
  const id = await createThread(page, unique('Journey'), OFFLINE);
  await page.goto(`/t/${id}`);
  await send(page, text, 1);
  return id;
}

/** Send a message in the open thread and wait for answer number `n` to settle. */
async function send(page: Page, text: string, n: number) {
  const composer = page.getByRole('textbox', { name: 'Message' });
  // The composer knows which model it sends to once the app has hydrated: before that Enter does nothing.
  await expect(page.getByRole('button', { name: /Offline test model/ }).first()).toBeVisible({
    timeout: 15_000,
  });
  await composer.fill(text);
  await composer.press('Enter');
  // Count settled answers from Core: a long thread draws far rows as plain text, not as articles.
  const id = /\/t\/(thr_[A-Za-z0-9]+)/.exec(page.url())?.[1];
  await expect
    .poll(
      async () => {
        const body = (await (await page.request.get(`/api/v1/threads/${id}/path`)).json()) as {
          messages: { role: string; status: string }[];
        };
        const answers = body.messages.filter((m) => m.role === 'assistant');
        return answers.length === n && answers.at(-1)?.status === 'complete';
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  await expect(lastAnswer(page).locator('.msg__foot')).toBeVisible({ timeout: 15_000 });
}

const OFFLINE = 'offline/test';

async function createThread(page: Page, title: string, model?: string): Promise<string> {
  const r = await page.request.post('/api/v1/threads', { data: { title, ...(model && { model }) } });
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { id: string }).id;
}

const NO_BOUNDARY = page_noBoundary;
async function page_noBoundary(page: Page) {
  await expect(page.locator('[data-boundary]')).toHaveCount(0);
  await expect(page.getByText(/stopped working|did not load/)).toHaveCount(0);
}

test.describe('0.1.1 journeys', () => {
  test.beforeEach(({ page }, info) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    test.skip(!/^chromium-(dark|light)$/.test(info.project.name), 'desktop Chromium only');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('the receipt opens from the cost strip and closes with Escape', async ({ page }) => {
    await newAnswer(page, '/say A short answer for the receipt.');
    const strip = lastAnswer(page).getByRole('button', { name: /^Receipt: / });
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip).toHaveAttribute('aria-expanded', 'false');
    await strip.click();
    await expect(strip).toHaveAttribute('aria-expanded', 'true');
    const receipt = page.locator(`#${await strip.getAttribute('aria-controls')}`);
    await expect(receipt).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(strip).toHaveAttribute('aria-expanded', 'false');
    await expect(receipt).toBeHidden();
  });

  test('Admin → Models groups models, shows model updates and a follow latest switch', async ({ page }) => {
    await page.goto('/admin/models');
    await expect(page.getByRole('main')).toBeVisible();
    // The offline models sit under "On your computer…" or API keys; at least one group heading shows.
    await expect(
      page.getByRole('heading', { name: /Subscriptions|On your computer and GPU nodes|API key/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    const updates = page.getByRole('region', { name: /updates/i }).or(page.locator('section.mu'));
    await expect(updates.first()).toBeVisible();
    await NO_BOUNDARY(page);
  });

  test('Settings → API keys lists the new providers and a wrong region is explained', async ({ page }) => {
    await page.route('**/api/v1/credentials/moonshot', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'provider.wrong_region',
            title: 'Moonshot did not accept this key here',
            hint: 'Keys from the other Moonshot site only work there. Try the other region.',
            retryable: false,
            trace_id: 'a'.repeat(32),
            attempts: [],
            context: {},
          },
        }),
      });
    });
    await page.goto('/settings/keys');
    for (const name of [
      'Moonshot (Kimi)',
      'MiniMax',
      'Qwen (Alibaba Model Studio)',
      'Z.ai (GLM)',
      'xAI (Grok)',
    ])
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('#credential-moonshot');
    await row.getByRole('button', { name: /^Add / }).click();
    // The region select belongs to providers that have regions.
    const region = row.getByLabel('Region');
    await expect(region).toBeVisible();
    await expect(region.getByRole('option')).toHaveCount(2);
    await row.getByLabel(/key/i).first().fill('sk-not-a-real-key-offline');
    await row
      .getByRole('button', { name: /^(Save|Check|Add)/ })
      .last()
      .click();
    await expect(row.getByRole('alert')).toContainText('Moonshot did not accept this key here');
    await expect(row.getByRole('alert')).toContainText('Try the other region');
  });

  test('selecting threads archives them in bulk, and Undo brings them back', async ({ page }) => {
    const a = unique('Bulk archive A');
    const b = unique('Bulk archive B');
    await createThread(page, a);
    await createThread(page, b);
    await page.goto('/');
    const list = page.getByRole('navigation', { name: 'Notebooks and threads' });
    const rowA = list.getByRole('link', { name: new RegExp(a) });
    const rowB = list.getByRole('link', { name: new RegExp(b) });
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await rowA.click({ modifiers: [mod] });
    // The bar for one thread opens over the foot of the rail: wait for it before the second click.
    await expect(page.getByRole('toolbar', { name: /Actions for 1 selected/ })).toBeVisible();
    await rowB.click({ modifiers: [mod] });
    const bar = page.getByRole('toolbar', { name: /Actions for 2 selected/ });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Archive' }).click();
    await expect(rowA).toBeHidden();
    await expect(rowB).toBeHidden();
    await page
      .getByRole('status')
      .filter({ hasText: /archived/i })
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();
  });

  test('a deleted thread waits in the Trash and can be restored', async ({ page }) => {
    const title = unique('Trash me');
    await createThread(page, title);
    await page.goto('/');
    const list = page.getByRole('navigation', { name: 'Notebooks and threads' });
    const row = list.getByRole('link', { name: new RegExp(title) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click({ modifiers: [mod] });
    await page
      .getByRole('toolbar', { name: /Actions for 1 selected/ })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(row).toBeHidden();
    // The row leaves at once and Core answers a moment later: open the Trash once Core has it, so the
    // view does not load its list in between.
    await expect
      .poll(async () => {
        const trash = (await (await page.request.get('/api/v1/threads/trash')).json()) as {
          items: { title: string }[];
        };
        return trash.items.some((t) => t.title === title);
      })
      .toBe(true);
    await list.getByRole('button', { name: 'Archive', exact: true }).click();
    await list
      .getByRole('group', { name: 'Archive or Trash' })
      .getByRole('button', { name: 'Trash' })
      .click();
    const restore = list.getByRole('button', { name: `Restore ${title}` });
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(restore).toBeHidden();
    await list.getByRole('button', { name: 'Back to threads' }).click();
    await expect(row).toBeVisible();
  });

  test('highlighted text cannot be fact-checked without a model of another family (GR24)', async ({
    page,
  }) => {
    await newAnswer(page, '/say The Thames flows through London and is 346 kilometres long.');
    const answer = lastAnswer(page);
    await answer.getByText('The Thames flows through London', { exact: false }).first().dblclick();
    await page.evaluate(() => {
      const el = document.querySelector(
        'article.msg[data-role="assistant"]:last-of-type .msg__body, article.msg[data-role="assistant"] p',
      );
      if (!el) return;
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    });
    const toolbar = page.getByRole('toolbar', { name: 'Highlighted text' });
    await expect(toolbar).toBeVisible({ timeout: 5_000 });
    await toolbar.getByRole('button', { name: /Fact-check/ }).click();
    const card = page.getByRole('dialog', { name: 'Fact-check' });
    await expect(card).toBeVisible();
    // Either it refuses with words (no other family), or it checks: never a blank card.
    await expect(card.getByRole('alert').or(card.getByRole('status')).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(card).not.toHaveText(/^\s*$/);
  });

  test('the slash menu lists commands, and an unknown command is a message for the offline model', async ({
    page,
  }) => {
    // The test profile has no Claude Code and no real model, so this runs on the offline test model, which
    // reads its own directives. The "no command called /x" notice is for real models and is covered by
    // apps/cockpit/test (readTyped, unknownWords).
    await page.goto(`/t/${await createThread(page, unique('Slash'), OFFLINE)}`);
    const composer = page.getByRole('textbox', { name: 'Message' });
    await expect(page.getByRole('button', { name: /Offline test model/ }).first()).toBeVisible({
      timeout: 15_000,
    });
    await composer.fill('/');
    const menu = page.getByRole('listbox', { name: 'Commands' });
    await expect(menu.getByRole('option', { name: /\/model/ })).toBeVisible();
    await expect(menu.getByRole('option', { name: /\/keys/ })).toBeVisible();
    await composer.fill('/nosuchcommand');
    await page.keyboard.press('Enter');
    await expect(page.getByText('There is no command called /nosuchcommand')).toHaveCount(0);
    await expect(page.locator('article.msg[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });
  });

  test('Ctrl+F in a long thread jumps to a row that was not drawn', async ({ page }) => {
    test.setTimeout(180_000);
    const needle = `zebracrossing${Date.now().toString(36)}`;
    await newAnswer(page, `/say First answer holds ${needle}`);
    // Tall answers, so the first row ends up several screens away and is shown as plain text, not drawn.
    const tall = Array.from({ length: 45 }, (_, k) => `line ${k + 1}`).join('\n\n');
    for (let i = 0; i < 6; i++) await send(page, `/say ${tall}`, i + 2);
    await page.keyboard.press(`${mod}+f`);
    const find = page
      .getByRole('searchbox', { name: 'Find in this thread' })
      .or(page.getByRole('textbox', { name: 'Find in this thread' }));
    await expect(find.first()).toBeFocused();
    await find.first().fill(needle);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: /^\d+ of \d+/ })).toBeVisible();
    await expect(page.getByText(needle).first()).toBeInViewport({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close find' }).click();
  });

  test('exporting a thread produces Markdown', async ({ page }) => {
    await newAnswer(page, '/say Export this exact sentence please.');
    await page.getByRole('textbox', { name: 'Message' }).fill('/export');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Export this thread' });
    await expect(dialog).toBeVisible();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save Markdown' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.md$/);
    const stream = await file.createReadStream();
    let text = '';
    for await (const chunk of stream) text += chunk.toString();
    expect(text).toContain('Export this exact sentence please.');
  });

  test('a palette action changes a setting in place', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    const palette = await openPaletteFor(page);
    await page.keyboard.type('underline links');
    await expect(palette.getByRole('option', { name: /underline links/i }).first()).toBeVisible();
    await page.keyboard.press('Tab');
    // Whatever the setting is now, choose the other way, then put it back.
    const before = await page.locator('html').getAttribute('data-links');
    const [to, back, want, wasWant] =
      before === 'underline' ? ['Off', 'On', 'plain', 'underline'] : ['On', 'Off', 'underline', 'plain'];
    await palette.getByRole('option', { name: new RegExp(`^${to}$`) }).click();
    await expect(page.locator('html')).toHaveAttribute('data-links', want ?? '');
    // In place: the palette stays open on the choices.
    await expect(palette).toBeVisible();
    await palette.getByRole('option', { name: new RegExp(`^${back}$`) }).click();
    await expect(page.locator('html')).toHaveAttribute('data-links', wasWant ?? '');
  });

  test('the memory inbox offers where to keep a note', async ({ page }) => {
    // Waiting suggestions come from seeds and from earlier journeys (a correction in the branching
    // journey leaves a lesson); other journeys decide them, so look at what is there now.
    const proposals = (await (await page.request.get('/api/v1/memory/proposals?status=proposed')).json()) as {
      items?: { kind: string }[];
    };
    const waiting = proposals.items ?? [];
    test.skip(waiting.length === 0, 'needs a waiting suggestion (pnpm seed --e2e)');
    const lessonsOnly = waiting.every((p) => p.kind === 'failure_lesson' || p.kind === 'model_quirk');
    await page.goto('/admin/memory');
    await page.getByRole('tab', { name: /Inbox/ }).click();
    if (lessonsOnly) {
      // A lesson has one home (its FAILURES or MODELS file), so it offers the file, not a scope.
      await expect(page.getByRole('combobox', { name: 'Or choose a file' }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('radiogroup', { name: 'Keep it for' })).toHaveCount(0);
      return;
    }
    const group = page.getByRole('radiogroup', { name: 'Keep it for' }).first();
    await expect(group).toBeVisible({ timeout: 15_000 });
    await expect(group.getByRole('radio')).toHaveCount(3);
    await group.getByRole('radio', { name: 'Everywhere' }).click();
    await expect(group.getByRole('radio', { name: 'Everywhere' })).toBeChecked();
  });

  test('the Usage tab is not blank', async ({ page }) => {
    await page.goto('/settings/usage');
    await expect(page.getByRole('heading', { name: 'NVX Ancile usage' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Context now' })).toBeVisible();
    await expect(page.getByRole('main')).not.toHaveText(/^\s*$/);
    await NO_BOUNDARY(page);
  });

  for (const route of [
    ...[
      'appearance',
      'layout',
      'reading',
      'composer',
      'keyboard',
      'notifications',
      'accessibility',
      'advanced',
      'keys',
      'trash',
      'usage',
    ].map((g) => `/settings/${g}`),
    ...[
      'health',
      'compute',
      'diagnostics',
      'logs',
      'traces',
      'permissions',
      'decisions',
      'memory',
      'models',
      'routing',
      'plugins',
      'automations',
      'license',
    ].map((s) => `/admin/${s}`),
  ])
    test(`${route} renders without an error boundary`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('main')).not.toHaveText(/^\s*$/);
      await page.waitForLoadState('networkidle').catch(() => {});
      await NO_BOUNDARY(page);
    });

  for (const route of ['/admin/models', '/settings/usage', '/settings/keys', '/admin/memory'])
    test(`${route} has no serious axe violation on the real stack`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle').catch(() => {});
      await expectAccessible(page);
    });
});

/** The shortcut is bound once the app has hydrated, which can be after "load": press again until it opens. */
async function openPaletteFor(page: Page) {
  const palette = page.getByRole('dialog', { name: /command/i });
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press(`${mod}+k`);
    await expect(palette).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  return palette;
}
