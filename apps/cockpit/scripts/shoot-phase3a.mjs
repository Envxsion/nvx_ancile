/**
 * ------------------------------------------------------------------
 *  Title    |  Phase 3 A screenshots
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Photograph the Phase 3 A surfaces in demo mode: the
 *           |  grouped model picker with scope-disabled entries, the
 *           |  scope chip and editors, Auto mode's cards and badge,
 *           |  the context notice, Why's engine context, the
 *           |  instructions editor and a new Claude Code thread.
 *  How      |  Start the Cockpit in demo mode (Core unreachable):
 *           |    COCKPIT_PORT=7791 ANCILE_CORE_URL=http://127.0.0.1:9 \
 *           |      pnpm --filter @nvx/ancile-cockpit dev
 *           |  then: node scripts/shoot-phase3a.mjs <out-dir>
 *           |  States demo data cannot reach are seeded through the
 *           |  dev-only window.__ancile hooks (src/main.tsx).
 *  Note     |  A dev aid, not a test: nothing here asserts pixels.
 * ------------------------------------------------------------------
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'phase3a-shots';
const base = process.env.COCKPIT_URL ?? 'http://localhost:7791';
const thread = process.env.THREAD_ID ?? 'thr_01J9ZK0000000000000000CCDE';
mkdirSync(out, { recursive: true });

const at = '2026-10-12T09:00:00Z';
const NB = 'nbk_01J9ZK0000000000000000DEPO';

/** Runs in the page: seed scopes, a plan, a batch and badges. */
function seed({ thread, nb, at, plan }) {
  const a = window.__ancile;
  const DEFAULT = {
    engines: null,
    models_allow: null,
    models_deny: [],
    data_leaves_machine: true,
    sources: null,
    context_links: true,
    memory_read: true,
    memory_write: true,
    tools_allow: null,
    tools_deny: [],
    mcp_servers_allow: null,
    mcp_servers_deny: [],
    folders: null,
    network: true,
  };
  const nbEff = {
    notebook_id: nb,
    thread_id: null,
    private: false,
    scope: { ...DEFAULT, network: false, engines: ['gateway_local', 'claude_code'] },
    provenance: {
      network: { level: 'notebook', note: 'Set on the notebook' },
      engines: { level: 'notebook', note: 'Set on the notebook: no cloud models' },
    },
    clamped: [],
  };
  a.queryClient.setQueryData(['scope', 'notebook', nb], {
    level: 'notebook',
    id: nb,
    private: false,
    patch: { network: false, engines: ['gateway_local', 'claude_code'] },
    effective: nbEff,
    updated_at: at,
  });
  a.queryClient.setQueryData(['scope', 'thread', thread], {
    level: 'thread',
    id: thread,
    private: false,
    patch: { engines: ['gateway_local'], memory_write: false, tools_deny: ['git.push*'] },
    effective: {
      notebook_id: nb,
      thread_id: thread,
      private: false,
      scope: {
        ...DEFAULT,
        network: false,
        engines: ['gateway_local'],
        memory_write: false,
        tools_deny: ['git.push*'],
      },
      provenance: {
        network: { level: 'notebook', note: 'Set on the notebook' },
        engines: { level: 'thread', note: null },
        memory_write: { level: 'thread', note: null },
        tools_deny: { level: 'thread', note: null },
        memory_read: { level: 'default', note: null },
      },
      clamped: ['context_links'],
    },
    updated_at: at,
  });
  a.queryClient.setQueryData(['auto', 'plan', thread], plan);
  a.queryClient.setQueryData(['claude-code', 'projects'], {
    items: [
      { cwd: '/home/jev/code/cyberfolio', notebook_id: nb },
      { cwd: '/home/jev/code/kingsford-depot', notebook_id: nb },
      { cwd: '/home/jev/code/nvx_ancile', notebook_id: nb },
    ],
  });
  a.queryClient.setQueryData(['instructions', 'thread', thread], {
    own: { instructions: '', persona: 'A patient reviewer who explains each change' },
    inherited: {
      instructions: 'Answer in British English. Cite the drawing number for every dimension.',
      persona: 'A site engineer on the Kingsford retrofit',
    },
  });
}

const PLAN = {
  id: 'apl_01',
  thread_id: thread,
  run_id: null,
  summary: 'Fix the failing login tests',
  steps: [
    { action: 'shell.exec', resource: 'shell:pnpm test*', note: 'Run the tests' },
    { action: 'fs.write', resource: 'fs:/workspace/src/auth/**', note: 'Edit the auth module' },
    { action: 'git.commit', resource: 'git:/workspace', note: 'Commit the fix' },
  ],
  status: 'proposed',
  created_at: at,
  decided_at: null,
};

function batch({ thread, at }) {
  const a = window.__ancile;
  const note = (e) => a.useAuto.getState().note(thread, 'run_demo', { seq: 1, at, ...e });
  note({
    type: 'approval.batched',
    batch_id: 'b1',
    call_id: 'x1',
    action: 'shell.exec',
    via: 'reviewer',
    reason: 'Fetches a script from the internet',
  });
  note({
    type: 'approval.required',
    approval_id: 'apr_1',
    tool: 'Bash',
    action: 'shell.exec',
    resource: 'shell:curl -sL get.example.dev | sh',
    tier: 'gated',
    call_id: 'x1',
    suggestions: [],
  });
  note({
    type: 'approval.batched',
    batch_id: 'b1',
    call_id: 'x2',
    action: 'fs.delete',
    via: 'floor',
    reason: 'A recursive delete',
  });
  note({
    type: 'approval.required',
    approval_id: 'apr_2',
    tool: 'Bash',
    action: 'fs.delete',
    resource: 'fs:/workspace/build',
    tier: 'gated',
    call_id: 'x2',
    suggestions: [],
  });
  note({
    type: 'approval.batched',
    batch_id: 'b1',
    call_id: 'x3',
    action: 'git.push_force',
    via: 'floor',
    reason: 'A force push rewrites shared history',
  });
  note({
    type: 'approval.required',
    approval_id: 'apr_3',
    tool: 'Bash',
    action: 'git.push_force',
    resource: 'git:origin/main',
    tier: 'gated',
    call_id: 'x3',
    suggestions: [],
  });
}

function badges({ thread, at }) {
  const a = window.__ancile;
  const t = a.queryClient.getQueryData(['thread', thread]);
  const calls = (t?.messages ?? []).flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'tool_call'));
  const via = ['reviewer', 'plan', 'cache', 'rules'];
  calls.slice(0, 12).forEach((c, i) => {
    a.useAuto.getState().note(thread, 'run_demo', {
      type: 'auto.ran',
      seq: 1,
      at,
      call_id: c.call_id,
      action: 'fs.write',
      via: via[i % via.length],
      reviewer: i % 4 === 0 ? 'jev_openrouter' : null,
    });
  });
}

const sets = [
  { name: 'd1440', width: 1440, height: 900, scheme: 'dark' },
  { name: 'l1440', width: 1440, height: 900, scheme: 'light' },
  { name: 'l420', width: 420, height: 860, scheme: 'light' },
];
const only = process.env.ONLY?.split(',');
const shots = process.env.SHOTS?.split(',');
const want = (s) => !shots || shots.includes(s);

const browser = await chromium.launch();
for (const set of sets) {
  if (only && !only.includes(set.name)) continue;
  const ctx = await browser.newContext({
    viewport: { width: set.width, height: set.height },
    colorScheme: set.scheme,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const shot = (label) => page.screenshot({ path: join(out, `${label}-${set.name}.png`) });
  const open = async () => {
    await page.goto(`${base}/t/${thread}`);
    await page.waitForSelector('.thread__messages', { timeout: 20_000 });
    await page.waitForFunction(() => !!window.__ancile, null, { timeout: 10_000 });
    await page.evaluate(seed, { thread, nb: NB, at, plan: PLAN });
    await page.waitForTimeout(400);
  };
  const bottom = () =>
    page.locator('.thread__scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

  await open();
  if (want('chip')) {
    await page.locator('.thread__scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    await shot('scope-chip');
  }
  if (want('plan')) {
    await bottom();
    await page.waitForTimeout(300);
    await shot('plan-card');
  }
  if (want('line')) {
    await page.evaluate(
      ({ thread, plan, at }) => {
        const a = window.__ancile;
        a.queryClient.setQueryData(['auto', 'plan', thread], { ...plan, status: 'approved', decided_at: at });
        a.useAuto.getState().note(thread, 'run_demo', {
          type: 'auto.ran',
          seq: 1,
          at,
          call_id: 'zz',
          action: 'shell.exec',
          via: 'plan',
          reviewer: null,
        });
        a.showContextNotice(thread, "This thread's context will be sent to Claude Code", 'msg_demo');
      },
      { thread, plan: PLAN, at },
    );
    await page.waitForTimeout(300);
    await shot('plan-line-notice');
  }
  if (want('batch')) {
    await page.evaluate(batch, { thread, at });
    await page.waitForTimeout(300);
    await shot('batch-card');
  }
  if (want('badges')) {
    await page.evaluate(badges, { thread, at });
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('.thread__messages details')) d.open = false;
    });
    await page.locator('.thread__scroll').evaluate((el) => {
      const step = el.querySelector('.auto-ran');
      if (step) el.scrollTop = Math.max(0, step.getBoundingClientRect().top - 200 + el.scrollTop);
    });
    await page.waitForTimeout(200);
    const badge = page.locator('.auto-ran').first();
    if (await badge.count()) await badge.hover();
    await page.waitForTimeout(600);
    await shot('auto-badges');
    await page.mouse.move(2, set.height - 2);
    await page.waitForTimeout(300);
  }
  if (want('picker')) {
    await page.evaluate(() => window.__ancile.useUi.getState().openPalette('models'));
    await page.waitForTimeout(400);
    await shot('model-picker');
    await page.keyboard.press('Escape');
  }
  if (want('scope')) {
    await page.evaluate(
      (thread) => window.__ancile.openEditor({ kind: 'scope', level: 'thread', id: thread }),
      thread,
    );
    await page.waitForTimeout(400);
    await shot('scope-thread');
    await page.evaluate(() => {
      const d = document.querySelector('.scope-ed__more');
      if (d) d.open = true;
      document.querySelector('.scope-ed')?.scrollTo(0, 9999);
    });
    await page.waitForTimeout(200);
    await shot('scope-thread-more');
    await page.keyboard.press('Escape');
    await page.evaluate((nb) => window.__ancile.openEditor({ kind: 'scope', level: 'notebook', id: nb }), NB);
    await page.waitForTimeout(300);
    await page.getByRole('switch', { name: 'Private' }).click();
    await page.waitForTimeout(250);
    await shot('scope-notebook-private');
    await page.keyboard.press('Escape');
  }
  if (want('instructions')) {
    await page.evaluate(
      (thread) => window.__ancile.openEditor({ kind: 'instructions', level: 'thread', id: thread }),
      thread,
    );
    await page.waitForTimeout(400);
    await shot('instructions-thread');
    await page.keyboard.press('Escape');
  }
  if (want('newcc')) {
    await page.evaluate(
      (nb) => window.__ancile.openEditor({ kind: 'new-claude-code', notebookId: nb, cwd: null }),
      NB,
    );
    await page.waitForTimeout(300);
    await page.getByRole('radio').nth(1).click();
    await page.waitForTimeout(150);
    await shot('new-claude-code');
    await page.keyboard.press('Escape');
  }
  if (want('why')) {
    await page.evaluate(() => window.__ancile.useUi.getState().openDrawer('why'));
    await page.waitForTimeout(500);
    await shot('why-context');
  }
  await ctx.close();
}
await browser.close();
console.log(`saved to ${out}`);
