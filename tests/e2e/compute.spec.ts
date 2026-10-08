/**
 * Phase 5: remote compute against the sample (fake) provider that a
 * development stack uses without a RunPod key. Starting a node lights the
 * four links of its confirmation chain; asking a model on a stopped node
 * shows "Waking …" and then answers from the node; "Use a cloud model
 * instead" answers at once with the next model.
 */
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

const lastAnswer = (page: Page) => page.locator('article.msg[data-role="assistant"]').last();

async function sampleMode(page: Page): Promise<boolean> {
  const r = await page.request.get('/api/v1/compute/status');
  if (!r.ok()) return false;
  const s = (await r.json()) as { sample: boolean };
  return s.sample;
}

/** Stop a node through the API and wait until it is stopped. */
async function ensureStopped(page: Page, name: string) {
  const nodes = (await (await page.request.get('/api/v1/compute/nodes')).json()) as {
    items: { id: string; name: string; observed_state: string }[];
  };
  const n = nodes.items.find((x) => x.name === name);
  if (!n || n.observed_state === 'stopped') return n;
  // A start still being confirmed (the test before) refuses a stop: ask
  // again until it is accepted, then wait for the node to stop.
  await expect
    .poll(
      async () => {
        const now = (
          (await (await page.request.get('/api/v1/compute/nodes')).json()) as { items: typeof nodes.items }
        ).items.find((x) => x.id === n.id)?.observed_state;
        if (now !== 'stopped' && now !== 'stopping')
          await page.request.post(`/api/v1/compute/nodes/${n.id}/actions`, { data: { action: 'stop' } });
        return now;
      },
      { timeout: 60_000, intervals: [1000, 2000] },
    )
    .toBe('stopped');
  return n;
}

test.describe('compute', () => {
  // One sample node is woken and stopped by each test: never at the same time.
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ page }) => {
    test.skip(!BACKEND, 'needs Core and the Controller (E2E_BACKEND=1)');
    test.skip(!(await sampleMode(page)), 'needs the sample provider (no RUNPOD_API_KEY)');
    await page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('costs, nodes and rules are shown, and starting a node walks the chain', async ({ page }) => {
    await ensureStopped(page, 'Lab 4090');
    await page.goto('/admin/compute');
    await expect(page.getByRole('region', { name: 'Costs this month' })).toContainText('Monthly cap');
    const card = page.getByRole('article', { name: 'Lab 4090' });
    await expect(card).toContainText('Sample');
    await card.getByRole('button', { name: 'Start' }).click();
    const chain = card.getByRole('region', { name: 'Start Lab 4090' });
    await expect(chain).toContainText('Acknowledged');
    await expect(chain).toContainText('Confirmed', { timeout: 30_000 });
    await expect(card).toContainText('Running', { timeout: 30_000 });
    await expect(page.getByRole('switch', { name: /Stop idle nodes/ })).toBeVisible();
  });

  test('a model on a stopped node wakes it, and the answer comes from the node', async ({ page }) => {
    await ensureStopped(page, 'Studio A100');
    const thread = (await (await page.request.post('/api/v1/threads', { data: {} })).json()) as {
      id: string;
    };
    await page.request.post(`/api/v1/threads/${thread.id}/messages`, {
      data: {
        parent_id: null,
        parts: [{ type: 'text', text: 'Hello node' }],
        model: 'node/llama-3.3-70b-instruct',
      },
    });
    await page.goto(`/t/${thread.id}`);
    await expect(lastAnswer(page).getByRole('status')).toContainText('Waking Studio A100', {
      timeout: 15_000,
    });
    await expect(lastAnswer(page)).toContainText('This answer came from Studio A100', { timeout: 60_000 });
  });

  test('"Use a cloud model instead" answers without waiting', async ({ page }) => {
    await ensureStopped(page, 'Studio A100');
    const thread = (await (await page.request.post('/api/v1/threads', { data: {} })).json()) as {
      id: string;
    };
    await page.request.post(`/api/v1/threads/${thread.id}/messages`, {
      data: {
        parent_id: null,
        parts: [{ type: 'text', text: '/say from the cloud' }],
        model: 'node/llama-3.3-70b-instruct',
      },
    });
    await page.goto(`/t/${thread.id}`);
    await lastAnswer(page)
      .getByRole('button', { name: 'Use a cloud model instead' })
      .click({ timeout: 15_000 });
    await expect(lastAnswer(page)).toContainText('from the cloud', { timeout: 20_000 });
  });
});
