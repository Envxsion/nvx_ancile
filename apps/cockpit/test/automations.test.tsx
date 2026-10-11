/**
 * Admin → Automations: the schedule picker's round trip to cron and back,
 * what it says about a custom schedule, and the picker itself.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SchedulePicker, scheduleBlocker } from '../src/ops/AutomationDialog';
import { lastWord } from '../src/ops/AutomationsScreen';
import {
  cronError,
  cronFromDraft,
  DEFAULT_DRAFT,
  draftFromCron,
  type ScheduleDraft,
} from '../src/ops/schedule';

describe('schedules', () => {
  it('opens the common shapes in the friendly picker', () => {
    expect(draftFromCron('*/15 * * * *')).toMatchObject({ mode: 'minutes', every: 15 });
    expect(draftFromCron('0 * * * *')).toMatchObject({ mode: 'hours', every: 1 });
    expect(draftFromCron('0 */6 * * *')).toMatchObject({ mode: 'hours', every: 6 });
    expect(draftFromCron('0 3 * * *')).toMatchObject({ mode: 'daily', time: '03:00' });
    expect(draftFromCron('30 18 * * 1-5')).toMatchObject({
      mode: 'weekly',
      time: '18:30',
      days: [1, 2, 3, 4, 5],
    });
    expect(draftFromCron('0 4 * * 7')).toMatchObject({ mode: 'weekly', days: [0] });
  });

  it('keeps anything else as custom, word for word', () => {
    expect(draftFromCron('5 4 1 * *')).toMatchObject({ mode: 'custom', cron: '5 4 1 * *' });
    expect(draftFromCron('15 */2 * * *')).toMatchObject({ mode: 'custom' });
    expect(draftFromCron('nonsense')).toMatchObject({ mode: 'custom', cron: 'nonsense' });
  });

  it('writes cron back out', () => {
    const d = (p: Partial<ScheduleDraft>) => cronFromDraft({ ...DEFAULT_DRAFT, ...p });
    expect(d({ mode: 'minutes', every: 10 })).toBe('*/10 * * * *');
    expect(d({ mode: 'minutes', every: 1 })).toBe('*/5 * * * *');
    expect(d({ mode: 'hours', every: 1 })).toBe('0 * * * *');
    expect(d({ mode: 'hours', every: 4 })).toBe('0 */4 * * *');
    expect(d({ mode: 'daily', time: '07:45' })).toBe('45 7 * * *');
    expect(d({ mode: 'weekly', time: '09:00', days: [5, 1, 3] })).toBe('0 9 * * 1,3,5');
    expect(d({ mode: 'custom', cron: '  0  9 1 * * ' })).toBe('0 9 1 * *');
    for (const cron of ['*/20 * * * *', '0 */3 * * *', '15 6 * * *', '0 22 * * 0,6'])
      expect(cronFromDraft(draftFromCron(cron))).toBe(cron);
  });

  it('says what is wrong with a custom schedule', () => {
    expect(cronError('0 9 * * 1-5')).toBeNull();
    expect(cronError('0 9 * *')).toMatch(/five fields/);
    expect(cronError('0 24 * * *')).toBe('The hour must be 0 to 23.');
    expect(cronError('x 9 * * *')).toBe('"x" is not a minute.');
    expect(cronError('* 9 * * *')).toMatch(/at least 5 minutes/);
    expect(cronError('*/2 * * * *')).toMatch(/at least 5 minutes/);
    expect(scheduleBlocker({ ...DEFAULT_DRAFT, mode: 'weekly', days: [] })).toBe('Pick at least one day.');
    expect(scheduleBlocker({ ...DEFAULT_DRAFT, mode: 'minutes', every: 2 })).toMatch(/5 to 59/);
    expect(scheduleBlocker(DEFAULT_DRAFT)).toBeNull();
  });

  it('says "Not set up" instead of the last result', () => {
    expect(lastWord({ last_status: 'skipped', setup: { title: 'Not set up', hint: 'Set a remote.' } })).toBe(
      'Not set up',
    );
    expect(lastWord({ last_status: 'succeeded', setup: null })).toBe('Done');
    expect(lastWord({ last_status: 'skipped', setup: null })).toBe('Skipped');
  });
});

function Picker({ start, seen }: { start: string; seen: string[] }) {
  const [d, setD] = useState(draftFromCron(start));
  return (
    <SchedulePicker
      value={d}
      onChange={(next) => {
        setD(next);
        seen.push(cronFromDraft(next));
      }}
    />
  );
}

describe('the schedule picker', () => {
  it('picks days of the week and carries the schedule into Custom', () => {
    const seen: string[] = [];
    render(<Picker start="0 9 * * 1" seen={seen} />);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
    expect(seen.at(-1)).toBe('0 9 * * 1,4');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(screen.getByRole('textbox', { name: 'Cron schedule' })).toHaveValue('0 9 * * 1,4');
    fireEvent.change(screen.getByRole('textbox', { name: 'Cron schedule' }), { target: { value: '0 9 *' } });
    expect(screen.getByText(/five fields/)).toBeInTheDocument();
  });
});
