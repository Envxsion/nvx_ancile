/**
 * Phase 4: memory. Suggestions wait in the inbox; "Not this" drops one,
 * "Remember" keeps one and writes a commit you can see and undo in
 * History. The files every answer is built around cannot be deleted.
 * Runs on the seeded test profile (`pnpm seed --e2e`).
 */
import { expect, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

test.describe('memory', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('the inbox: drop one suggestion, keep another, then undo it from History', async ({ page }) => {
    const proposals = await (await page.request.get('/api/v1/memory/proposals')).json();
    const waiting = (proposals.items ?? proposals) as { id: string; status?: string }[];
    test.skip(
      waiting.filter((p) => !p.status || p.status === 'proposed').length < 2,
      'needs two suggestions (pnpm seed --e2e)',
    );

    await page.goto('/admin/memory');
    await page.getByRole('tab', { name: /Inbox/ }).click();
    // Waiting suggestions are the cards that still offer Remember ("Lately" lists the decided ones).
    const cards = page
      .getByRole('tabpanel', { name: 'Inbox' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: /Remember/ }) });
    const before = await cards.count();
    expect(before).toBeGreaterThanOrEqual(2);

    await cards
      .first()
      .getByRole('button', { name: /Not this/ })
      .click();
    await expect(cards).toHaveCount(before - 1, { timeout: 10_000 });

    const kept = cards.first();
    const text = ((await kept.locator('.mem-card__text').textContent()) ?? '').trim().slice(0, 30);
    await kept.getByRole('button', { name: /Remember/ }).click();
    await expect(cards).toHaveCount(before - 2, { timeout: 10_000 });

    await page.getByRole('tab', { name: 'History' }).click();
    const latest = page.getByRole('tabpanel', { name: 'History' }).getByRole('listitem').first();
    await expect(latest).toBeVisible();
    await latest.getByRole('button', { expanded: false }).first().click();
    const undo = latest.getByRole('button', { name: /Undo this change/ });
    await undo.click();
    await latest.getByRole('button', { name: /Press again to undo/ }).click();
    await expect(page.getByRole('tabpanel', { name: 'History' }).getByRole('listitem').first()).toContainText(
      /Revert|undo/i,
      { timeout: 10_000 },
    );
    expect(text.length).toBeGreaterThan(0);
  });

  test('USER.md and AGENTS.md cannot be deleted, whatever their case', async ({ request }) => {
    for (const path of ['USER.md', 'user.md', 'AGENTS.md']) {
      const r = await request.delete(`/api/v1/memory/files/${path}`);
      expect(r.status(), path).toBeGreaterThanOrEqual(400);
    }
    expect((await request.get('/api/v1/memory/files/USER.md')).ok()).toBe(true);
  });

  test('the files tab lists the memory files', async ({ page }) => {
    await page.goto('/admin/memory');
    await page.getByRole('tab', { name: 'Files' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Files' })).toContainText('USER.md');
  });
});
