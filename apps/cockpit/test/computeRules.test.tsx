import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { RuleDialog, WeekdayPicker } from '../src/compute/Rules';
import { daysWords, draftOf, emptyDraft, problems, ruleOf, ruleSummary } from '../src/compute/ruleDraft';

describe('rule drafts', () => {
  it('start empty and are not ready until the required field reads', () => {
    const idle = emptyDraft('idle_timeout', 'UTC');
    expect(idle.minutes).toBe('');
    expect(problems(idle).map((p) => p.field)).toEqual(['minutes']);
    expect(problems({ ...idle, minutes: '3' })[0]?.message).toMatch(/5 to 1440/);
    expect(problems({ ...idle, minutes: '30' })).toEqual([]);

    const cap = emptyDraft('cost_cap', 'UTC');
    expect(cap.amount).toBe('');
    expect(problems(cap).map((p) => p.field)).toEqual(['amount']);
    expect(problems({ ...cap, amount: '150' })).toEqual([]);

    const sched = emptyDraft('schedule', 'UTC');
    expect(sched.time).toBe('');
    expect(problems(sched).map((p) => p.field)).toEqual(['time']);
    expect(problems({ ...sched, time: '25:00' })[0]?.field).toBe('time');
    expect(problems({ ...sched, time: '23:00', days: [] }).map((p) => p.field)).toEqual(['days']);
  });

  it('need at least one chosen node when scoped to chosen nodes', () => {
    const d = { ...emptyDraft('idle_timeout', 'UTC'), minutes: '30', scope: 'chosen' as const };
    expect(problems(d).map((p) => p.field)).toEqual(['nodes']);
    expect(ruleOf({ ...d, nodeIds: ['n1'] })).toMatchObject({
      config: { node_ids: ['n1'], idle_minutes: 30 },
    });
  });

  it('build a schedule with weekdays, and leave them out for every day', () => {
    const d = { ...emptyDraft('schedule', 'Europe/London'), time: '7:05' };
    const every = ruleOf(d);
    expect(every.config).toEqual({ node_ids: '*', cron: '5 7 * * *', action: 'stop', tz: 'Europe/London' });
    const some = ruleOf({ ...d, days: ['fri', 'mon'] });
    expect(some.config).toMatchObject({ weekdays: ['mon', 'fri'] });
  });

  it('round-trip a saved rule into the dialog', () => {
    const rule = {
      id: 'r1',
      kind: 'schedule' as const,
      enabled: false,
      config: {
        node_ids: ['n1'],
        cron: '0 23 * * *',
        action: 'start' as const,
        tz: 'UTC',
        weekdays: ['sat' as const],
      },
    };
    const d = draftOf(rule, 'Europe/London');
    expect(d).toMatchObject({
      id: 'r1',
      time: '23:00',
      action: 'start',
      days: ['sat'],
      scope: 'chosen',
      tz: 'UTC',
    });
    expect(ruleOf(d)).toEqual(rule);
  });

  it('read plainly in the list', () => {
    expect(daysWords(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Mon to Fri');
    expect(daysWords(['sun', 'sat'])).toBe('Sat and Sun');
    expect(daysWords(undefined)).toBe('every day');
    const names = new Map([['n1', 'Studio A100']]);
    expect(
      ruleSummary(
        {
          id: 'r',
          kind: 'schedule',
          enabled: true,
          config: {
            node_ids: ['n1'],
            cron: '0 19 * * *',
            action: 'stop',
            tz: 'UTC',
            weekdays: ['mon', 'wed'],
          },
        },
        names,
      ),
    ).toBe('At 19:00 Mon and Wed (UTC), on Studio A100');
  });
});

describe('WeekdayPicker', () => {
  function Harness() {
    const [days, setDays] = useState<('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[]>(['mon']);
    return <WeekdayPicker value={days} onChange={setDays} />;
  }

  it('toggles days and moves with the arrow keys', () => {
    render(<Harness />);
    const mon = screen.getByRole('button', { name: 'Monday' });
    expect(mon).toHaveAttribute('aria-pressed', 'true');
    expect(mon).toHaveTextContent('Mon');
    mon.focus();
    fireEvent.keyDown(mon, { key: 'ArrowRight' });
    const tue = screen.getByRole('button', { name: 'Tuesday' });
    expect(tue).toHaveFocus();
    fireEvent.click(tue);
    expect(tue).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(mon);
    expect(mon).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('RuleDialog', () => {
  it('keeps the add button off until a value is typed', () => {
    render(
      <RuleDialog
        draft={emptyDraft('idle_timeout', 'UTC')}
        nodes={[{ id: 'n1', name: 'A100' }]}
        onClose={() => {}}
      />,
    );
    const add = screen.getByRole('button', { name: 'Add rule' });
    expect(add).toBeDisabled();
    const field = screen.getByPlaceholderText('For example, 30');
    expect(field).toHaveValue(null);
    fireEvent.change(field, { target: { value: '45' } });
    expect(add).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Chosen nodes' }));
    expect(add).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'A100' }));
    expect(add).toBeEnabled();
  });
});
