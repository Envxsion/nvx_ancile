/**
 * ------------------------------------------------------------------
 *  Title    |  Pro screenshots
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Photograph the free and the Pro edition side by side,
 *           |  dark and light, desktop and phone: the licence screen,
 *           |  a locked Pro feature, a Pro screen and the shell with
 *           |  its status bar. For reviewing the Pro visual pass.
 *  How      |  Start the Cockpit in demo mode (Core unreachable):
 *           |    COCKPIT_PORT=7791 ANCILE_CORE_URL=http://127.0.0.1:9 \
 *           |      pnpm --filter @nvx/ancile-cockpit dev
 *           |  then: node scripts/shoot-pro.mjs <out-dir> [prefix]
 *           |  The licence and the few Pro answers are served from
 *           |  here (page.route); everything else is the demo data.
 *           |  AWAKEN=1 also records the moment Pro turns on.
 *  Note     |  A dev aid, not a test: nothing here asserts pixels.
 * ------------------------------------------------------------------
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from '@playwright/test';

const out = process.argv[2] ?? 'pro-shots';
const prefix = process.argv[3] ?? '';
const base = process.env.COCKPIT_URL ?? 'http://localhost:7791';
mkdirSync(out, { recursive: true });

const FEATURES = [
  [
    'beam',
    'Ask several models at once',
    'Fan one question out to several models and fuse their answers into one.',
  ],
  ['team', 'Teams', 'Invite people into a workspace, with sign-in through your identity provider.'],
  [
    'sync',
    'Encrypted sync',
    'Your notebooks, threads, notes, flows and preferences on every computer, encrypted before they leave this one. What you keep on this computer stays here.',
  ],
  [
    'fleet',
    'GPU fleet',
    'More than one GPU node, new RunPod pods from the app, and schedules that start and stop them.',
  ],
  [
    'flow_lab',
    'Flow lab',
    'Test a flow against your past threads, run a new flow in the shadow of the live one.',
  ],
  ['context_packs', 'Context packs', 'Save what a notebook knows as a pack, and attach it anywhere.'],
  ['insights', 'Insights', 'Where your time, money and models go, from your own history, on this computer.'],
];

function licence(pro) {
  return {
    status: {
      tier: pro ? 'pro' : 'free',
      features: pro ? FEATURES.map((f) => f[0]) : [],
      verified: pro,
      offline_grace: false,
      expires_at: pro ? '2026-11-02T00:00:00Z' : null,
      lapse: null,
    },
    build: pro ? 'pro' : 'free',
    device_id: 'dev_7f3c91a2e4b8',
    key_held: pro,
    checked_at: pro ? new Date(Date.now() - 4 * 60_000).toISOString() : null,
    problem: null,
    features: FEATURES.map(([id, title, body]) => ({ id, title, body, unlocked: pro })),
  };
}

const day = (i) => new Date(Date.UTC(2026, 8, 13 + i)).toISOString();
const ENGINES = {
  range: { from: day(0), to: day(29), days: 30 },
  uses: [
    {
      engine: 'claude_code',
      model_id: 'claude-opus',
      name: 'Claude Code · Opus',
      local: false,
      answers: 412,
      tokens: 9_800_000,
      cost_usd: 0,
      purposes: { coding: 360, research: 30, writing: 12, other: 10 },
      top_notebooks: [{ notebook_id: 'nbk_1', title: 'Depo prep', answers: 210 }],
    },
    {
      engine: 'gateway',
      model_id: 'gpt-5.5',
      name: 'GPT-5.5',
      local: false,
      answers: 188,
      tokens: 2_100_000,
      cost_usd: 31.4,
      purposes: { coding: 20, research: 120, writing: 40, other: 8 },
      top_notebooks: [{ notebook_id: 'nbk_2', title: 'Market notes', answers: 96 }],
    },
    {
      engine: 'gateway',
      model_id: 'qwen3-32b',
      name: 'Qwen3 32B (local)',
      local: true,
      answers: 140,
      tokens: 1_400_000,
      cost_usd: 0,
      purposes: { coding: 10, research: 60, writing: 60, other: 10 },
      top_notebooks: [{ notebook_id: 'nbk_3', title: 'Drafts', answers: 80 }],
    },
  ],
  cost: {
    series: Array.from({ length: 30 }, (_, i) => ({
      t: day(i),
      cost_usd: 0.4 + ((i * 7) % 5) * 0.3,
      by_notebook: { nbk_1: 0.2 + (i % 3) * 0.1, nbk_2: 0.2 + ((i * 7) % 5) * 0.2 },
    })),
    notebooks: [
      { key: 'nbk_1', notebook_id: 'nbk_1', title: 'Depo prep', cost_usd: 12.1 },
      { key: 'nbk_2', notebook_id: 'nbk_2', title: 'Market notes', cost_usd: 19.3 },
    ],
    threads: [
      {
        thread_id: 'thr_1',
        title: 'Rebuttal outline',
        notebook_id: 'nbk_2',
        answers: 40,
        tokens: 300_000,
        cost_usd: 6.2,
      },
    ],
  },
  headroom: {
    since: day(0),
    windows: [
      {
        id: 'session',
        kind: 'session',
        label: null,
        points: Array.from({ length: 30 }, (_, i) => ({ t: day(i), peak: 30 + ((i * 13) % 50) })),
        latest: 62,
        mean_peak: 51,
        trend: 'rising',
      },
    ],
  },
  context: {
    answers: 640,
    since: day(0),
    sent_tokens: 6_200_000,
    full_tokens: 14_900_000,
    saved_tokens: 8_700_000,
    saved_share: 0.58,
    saved_usd: 22.8,
    by_engine: [{ engine: 'gateway', answers: 320, saved_tokens: 4_100_000 }],
  },
  suggestions: [
    {
      kind: 'one_notebook_most_cost',
      title: 'Market notes is most of the spend',
      body: 'It took 61% of this month’s model cost. A local model answers most of its questions as well.',
      notebook_id: 'nbk_2',
      evidence: { share: 61 },
    },
  ],
  generated_at: day(29),
};

const FLEET = {
  month: '2026-10',
  total_to_date: 84.2,
  projected_total: 191.5,
  cap: 250,
  nodes: [
    {
      id: 'node_a',
      name: 'A100 · research',
      gpu_type: 'NVIDIA A100 80GB',
      region: 'EU-RO-1',
      observed_state: 'running',
      hourly_rate: 1.64,
      served_models: ['qwen3-32b'],
      cost: { compute_cost: 61.1, storage_cost: 2.3, projected_month_cost: 140.2 },
    },
    {
      id: 'node_b',
      name: 'L40S · drafts',
      gpu_type: 'NVIDIA L40S',
      region: 'US-TX-3',
      observed_state: 'stopped',
      hourly_rate: 0.86,
      served_models: ['llama-4-scout'],
      cost: { compute_cost: 20.8, storage_cost: 1.1, projected_month_cost: 51.3 },
    },
  ],
  groups: [],
  schedules: [],
  placement: [{ model: 'qwen3-32b', node_ids: ['node_a'] }],
};

async function serve(page, pro) {
  await page.route('**/api/v1/license/details', (r) => r.fulfill({ json: licence(pro) }));
  await page.route('**/api/v1/system/update-offer', (r) => r.fulfill({ json: { offer: null } }));
  await page.route('**/api/v1/system/pro-data', (r) => r.fulfill({ json: { tables: [], total_rows: 0 } }));
  await page.route('**/api/v1/pro/insights/engines*', (r) => r.fulfill({ json: ENGINES }));
  await page.route('**/api/v1/pro/context-packs*', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/pro/fleet/overview', (r) => r.fulfill({ json: FLEET }));
  await page.route('**/api/v1/pro/fleet/catalogue', (r) =>
    r.fulfill({ json: { gpu_types: [], regions: [], templates: [], prices_as_of: day(29) } }),
  );
}

const PAGES = {
  desktop: [
    ['licence', '/admin/license'],
    ['engine-insights', '/admin/engine-insights'],
    ['fleet', '/admin/fleet'],
    ['context-packs', '/admin/context-packs'],
    ['home', '/'],
  ],
  phone: [
    ['licence', '/admin/license'],
    ['engine-insights', '/admin/engine-insights'],
  ],
};

const browser = await chromium.launch();
for (const edition of ['free', 'pro'])
  for (const theme of ['dark', 'light'])
    for (const form of ['desktop', 'phone']) {
      const ctx = await browser.newContext({
        ...(form === 'phone' ? devices['Pixel 7'] : { viewport: { width: 1440, height: 900 } }),
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        sessionStorage.setItem('nvx.ancile.setup-offered', '1');
        localStorage.setItem('nvx.ancile.pro-awakened', '1');
      });
      await serve(page, edition === 'pro');
      for (const [name, route] of PAGES[form]) {
        await page.goto(base + route);
        await page.getByRole('main').waitFor();
        // Demo mode says Core is not answering; that banner is not what is under review.
        await page.addStyleTag({ content: '.conn-banner{display:none!important}' });
        await page.waitForTimeout(900);
        const file = join(out, `${prefix}${edition}-${theme}-${form}-${name}.png`);
        await page.screenshot({ path: file });
        console.log(file);
      }
      await ctx.close();
    }

if (process.env.AWAKEN) {
  // The moment Pro turns on: frames through the orchestrated animation.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  await serve(page, true);
  await page.goto(`${base}/admin/license`);
  await page.getByRole('main').waitFor();
  let at = 0;
  for (const ms of [200, 600, 1000, 1500]) {
    await page.waitForTimeout(ms - at);
    at = ms;
    const file = join(out, `${prefix}awaken-${ms}ms.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
  await ctx.close();
}
await browser.close();
