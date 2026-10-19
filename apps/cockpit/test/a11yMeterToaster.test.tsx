/**
 * ------------------------------------------------------------------
 *  Title    |  Meter and toaster semantics
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A meter with no value is not announced as a meter, and
 *           |  the toaster is a labelled region of status messages,
 *           |  not a list whose items have another role (axe: the
 *           |  required-attr and list rules).
 * ------------------------------------------------------------------
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster } from '../src/notify/Toaster';
import { notify, useNotify } from '../src/state/notify';
import { Meter } from '../src/usage/Meter';

afterEach(() => useNotify.setState({ toasts: [] }));

describe('Meter', () => {
  it('has role meter and a value when it has one', () => {
    render(<Meter percent={42} label="Context used" />);
    expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '42');
  });

  it('is plain text, not a meter, when the value is not reported', () => {
    render(<Meter percent={null} label="Weekly limit" />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('Weekly limit: not reported')).toBeInTheDocument();
  });
});

describe('Toaster', () => {
  it('is a labelled region with a status per toast, and no list', async () => {
    render(<Toaster />);
    act(() => {
      notify({ level: 'success', title: 'Saved' });
    });
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });
});
