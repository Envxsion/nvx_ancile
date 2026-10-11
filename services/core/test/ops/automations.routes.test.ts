/**
 * Automations you can change: your own (create, edit, delete, run), the
 * built-ins (schedule, settings, reset), schedules that can't be used,
 * jobs that are not set up, and an unattended run's tool calls asking
 * every time.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutomationView, RunEvent, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

type Err = { error: { code: string; title: string; hint: string } };

const of = <T extends RunEvent['type']>(evs: RunEvent[], type: T) =>
  evs.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

const BUILTINS = {
  cleanup: { enabled: true, cron: '0 3 * * *', config: { logs_days: 14 } },
  memory_backup: { enabled: true, cron: '0 * * * *', config: {} },
  auto_title: { enabled: true, config: {} },
};

async function opsHarness(extra: Parameters<typeof harness>[0] = {}) {
  const ran: string[] = [];
  h = await harness({
    ops: true,
    ...extra,
    automations: {
      jobs: BUILTINS,
      handlers: {
        cleanup: async (config) => {
          ran.push(`cleanup:${String(config.logs_days)}`);
          return { status: 'succeeded', detail: 'Removed 0 log lines.' };
        },
        memory_backup: async () => {
          ran.push('memory_backup');
          return { status: 'skipped', detail: 'No remote.' };
        },
      },
      extras: {
        setup: { memory_backup: () => ({ title: 'Not set up', hint: 'Set a git remote for memory.' }) },
        options: {
          cleanup: [
            {
              key: 'logs_days',
              label: 'Keep log lines for',
              hint: null,
              type: 'integer',
              min: 1,
              max: 3650,
              unit: 'days',
              default: 14,
            },
          ],
        },
      },
      ...extra.automations,
    },
  });
  await h.automations.start(60_000);
  h.automations.stop();
  return ran;
}

const ask = (extra: Record<string, unknown> = {}) => ({
  kind: 'ask_model',
  title: 'Morning brief',
  cron: '0 8 * * 1-5',
  config: { prompt: '/say Here is your brief.' },
  ...extra,
});

describe('your own automations', () => {
  it('creates, lists, edits and deletes one', async () => {
    await opsHarness();
    const made = await h.call<AutomationView>('POST', '/automations', ask());
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      origin: 'user',
      kind: 'ask_model',
      title: 'Morning brief',
      schedule_words: 'Every weekday at 08:00',
      enabled: true,
      config: { prompt: '/say Here is your brief.', notebook_id: null, model: null },
    });
    expect(made.body.id).toMatch(/^aut_/);
    expect(made.body.next_run_at).not.toBeNull();

    const list = (await h.call<{ items: AutomationView[] }>('GET', '/automations')).body.items;
    expect(list[0]?.id).toBe(made.body.id); // your own come first

    const edited = await h.call<AutomationView>('PATCH', `/automations/${made.body.id}`, {
      title: 'Evening brief',
      cron: '30 18 * * 1,3',
      config: { prompt: 'What changed today?', notebook_id: 'nbk_pumps' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      title: 'Evening brief',
      schedule_words: 'Every Monday and Wednesday at 18:30',
      config: { prompt: 'What changed today?', notebook_id: 'nbk_pumps', model: null },
    });

    const bad = await h.call<Err>('PATCH', `/automations/${made.body.id}`, { config: { prompt: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('request.invalid');

    const off = await h.call<AutomationView>('PATCH', `/automations/${made.body.id}`, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, next_run_at: null });

    const reset = await h.call<Err>('POST', `/automations/${made.body.id}/reset`);
    expect(reset.body.error.code).toBe('automation.no_default');

    expect((await h.call('DELETE', `/automations/${made.body.id}`)).status).toBe(204);
    expect((await h.call('DELETE', `/automations/${made.body.id}`)).status).toBe(404);
    const after = (await h.call<{ items: AutomationView[] }>('GET', '/automations')).body.items;
    expect(after.some((a) => a.origin === 'user')).toBe(false);
  });

  it('refuses what it points at when that does not exist', async () => {
    await opsHarness();
    const nb = await h.call<Err>(
      'POST',
      '/automations',
      ask({ config: { prompt: 'x', notebook_id: 'nbk_gone' } }),
    );
    expect(nb.status).toBe(404);
    const flow = await h.call<Err>('POST', '/automations', {
      kind: 'run_flow',
      title: 'Route it',
      cron: '0 9 * * *',
      config: { flow_id: 'flw_gone', prompt: 'x' },
    });
    expect(flow.status).toBe(404);
    const model = await h.call<Err>(
      'POST',
      '/automations',
      ask({ config: { prompt: 'x', model: 'nope/none' } }),
    );
    expect(model.status).toBe(404);
    const kind = await h.call<Err>('POST', '/automations', { ...ask(), kind: 'shell' });
    expect(kind.body.error.code).toBe('request.invalid');
  });

  it('checks the schedule', async () => {
    await opsHarness();
    const unreadable = await h.call<Err>('POST', '/automations', ask({ cron: '0 25 * * *' }));
    expect(unreadable.status).toBe(422);
    expect(unreadable.body.error.code).toBe('automation.bad_schedule');
    const fields = await h.call<Err>('POST', '/automations', ask({ cron: 'every day' }));
    expect(fields.body.error.code).toBe('automation.bad_schedule');
    const never = await h.call<Err>('POST', '/automations', ask({ cron: '0 9 31 2 *' }));
    expect(never.body.error.code).toBe('automation.bad_schedule');
    const often = await h.call<Err>('POST', '/automations', ask({ cron: '* * * * *' }));
    expect(often.body.error.code).toBe('automation.too_often');
    expect((await h.call('POST', '/automations', ask({ cron: '*/5 * * * *' }))).status).toBe(201);
  });

  it('asks a model in a new thread when it runs, and links the thread', async () => {
    await opsHarness();
    const made = (await h.call<AutomationView>('POST', '/automations', ask())).body;
    const ran = await h.call<AutomationView>('POST', `/automations/${made.id}/run`);
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ last_status: 'succeeded', runs: 1 });
    expect(ran.body.last_detail).toMatch(/^Started an answer in "Morning brief, /);
    const threadId = ran.body.last_href?.replace('/t/', '') ?? '';
    expect(threadId).toMatch(/^thr_/);
    const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
    const runId = path.active_run?.id ?? path.messages.at(-1)?.run_id ?? '';
    await h.settle(runId);
    const answered = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
    expect(answered.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Here is your brief.' }]);
    expect(answered.thread.title).toMatch(/^Morning brief, /);
  });

  it('runs on its schedule through the same tick as the built-ins', async () => {
    const ran = await opsHarness();
    const made = (
      await h.call<AutomationView>('POST', '/automations', {
        kind: 'notify',
        title: 'Stretch',
        cron: '0 15 * * *',
        config: { title: 'Time to stretch', body: 'Stand up for five minutes.' },
      })
    ).body;
    const seen: string[] = [];
    h.bus.subscribe(Number.MAX_SAFE_INTEGER, (e) => {
      if (e.type === 'notification') seen.push(e.title);
    });
    // Make it due, then tick.
    await h.automationStore.patch(made.id, { next_run_at: new Date(Date.now() - 1_000).toISOString() });
    await h.automations.tick();
    expect(seen).toEqual(['Time to stretch']);
    const list = (await h.call<{ items: AutomationView[] }>('GET', '/automations')).body.items;
    expect(list.find((a) => a.id === made.id)).toMatchObject({ last_status: 'succeeded', runs: 1 });
    expect(ran).toEqual([]);
  });

  it("re-checks only the chosen notebook's web sources", async () => {
    const posted: unknown[] = [];
    const kn = {
      get: async <T>(path: string) => {
        expect(path).toBe('/notebooks/nbk_pumps/sources');
        return [
          { id: 'src_link', kind: 'url' },
          { id: 'src_pdf', kind: 'file' },
        ] as T;
      },
      post: async <T>(path: string, b?: unknown) => {
        posted.push({ path, b });
        return { checked: 1, stale: 1 } as T;
      },
    };
    await opsHarness({ kn });
    const made = (
      await h.call<AutomationView>('POST', '/automations', {
        kind: 'recheck_sources',
        title: 'Pump links',
        cron: '0 6 * * 1',
        config: { notebook_id: 'nbk_pumps' },
      })
    ).body;
    const ran = (await h.call<AutomationView>('POST', `/automations/${made.id}/run`)).body;
    expect(posted).toEqual([
      { path: '/maintenance/stale-check', b: { source_ids: ['src_link'], force: true } },
    ]);
    expect(ran).toMatchObject({
      last_status: 'succeeded',
      last_detail: 'Checked 1 link; 1 changed.',
      last_href: '/n/nbk_pumps',
    });
  });

  it('makes every tool call an unattended run raises critical', async () => {
    const base = await readFile(join(__dirname, '../../../../config/policies/base.cedar'), 'utf8');
    for (const cedar of [undefined, { 'base.cedar': base }]) {
      await opsHarness(cedar ? { cedar } : {});
      const made = (
        await h.call<AutomationView>(
          'POST',
          '/automations',
          ask({
            config: { prompt: '/tool fs_write {"path":"brief.md","content":"x"}' },
          }),
        )
      ).body;
      const ran = (await h.call<AutomationView>('POST', `/automations/${made.id}/run`)).body;
      const threadId = ran.last_href?.replace('/t/', '') ?? '';
      const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
      const runId = path.messages.at(-1)?.run_id ?? '';
      expect((await h.settle(runId)).status).toBe('waiting_approval');
      const asked = of(await h.eventsOf(runId), 'approval.required')[0];
      // fs.write is gated in a thread you are watching; unattended, it is critical.
      expect(asked).toMatchObject({ tier: 'critical', suggestions: [] });
      await h.close();
    }
  });
});

describe('built-in automations', () => {
  it('changes the schedule and settings, keeps them, and resets to default', async () => {
    const ran = await opsHarness();
    const changed = await h.call<AutomationView>('PATCH', '/automations/cleanup', {
      cron: '30 2 * * 0',
      config: { logs_days: 30 },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      origin: 'builtin',
      customised: true,
      cron: '30 2 * * 0',
      default_cron: '0 3 * * *',
      schedule_words: 'Every Sunday at 02:30',
      config: { logs_days: 30 },
    });
    await h.call('POST', '/automations/cleanup/run');
    expect(ran).toEqual(['cleanup:30']);

    // A restart reads automations.yaml again; your change wins.
    await h.automations.start(60_000);
    h.automations.stop();
    expect((await h.automations.view('cleanup'))?.cron).toBe('30 2 * * 0');

    const unknown = await h.call<Err>('PATCH', '/automations/cleanup', { config: { temp: 1 } });
    expect(unknown.status).toBe(400);
    const range = await h.call<Err>('PATCH', '/automations/cleanup', { config: { logs_days: 0 } });
    expect(range.status).toBe(400);
    const named = await h.call<Err>('PATCH', '/automations/cleanup', { title: 'Mine' });
    expect(named.status).toBe(400);

    const reset = await h.call<AutomationView>('POST', '/automations/cleanup/reset');
    expect(reset.body).toMatchObject({ customised: false, cron: '0 3 * * *', config: { logs_days: 14 } });

    // Changing it back by hand counts as default too.
    const same = await h.call<AutomationView>('PATCH', '/automations/cleanup', { cron: '0 3 * * *' });
    expect(same.body.customised).toBe(false);

    const del = await h.call<Err>('DELETE', '/automations/cleanup');
    expect(del.body.error.code).toBe('automation.builtin');
  });

  it('says a job is not set up, and does not run it', async () => {
    const ran = await opsHarness();
    const v = await h.automations.view('memory_backup');
    expect(v).toMatchObject({ setup: { title: 'Not set up' }, next_run_at: null });
    await h.automationStore.patch('memory_backup', {
      next_run_at: new Date(Date.now() - 1_000).toISOString(),
    });
    await h.automations.tick();
    expect(ran).toEqual([]);
    expect((await h.automations.view('memory_backup'))?.runs).toBe(0);
    const now = await h.call<Err>('POST', '/automations/memory_backup/run');
    expect(now.status).toBe(422);
    expect(now.body.error).toMatchObject({
      code: 'automation.not_set_up',
      hint: 'Set a git remote for memory.',
    });
  });

  it('leaves event-driven jobs alone', async () => {
    await opsHarness();
    const r = await h.call<Err>('PATCH', '/automations/auto_title', { cron: '0 9 * * *' });
    expect(r.body.error.code).toBe('automation.event_driven');
  });
});
