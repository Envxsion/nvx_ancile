/**
 * N1: Flows and Automations sit in the rail, each lit while you are on it
 * (a notebook's own flow counts as Flows), with a shortcut to reach them.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouterState: () => '/',
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={params ? to.replace('$section', params.section ?? '') : to} {...rest}>
      {children}
    </a>
  ),
}));

import { bindingById } from '../src/keys/registry';
import { RAIL_PLACES, RailPlaces, railPlaceActive } from '../src/shell/Rail';

const wrap = (ui: ReactNode) => render(<Tooltip.Provider>{ui}</Tooltip.Provider>);

describe('places in the rail', () => {
  it('lists Flows and Automations, each linking to its screen', () => {
    wrap(<RailPlaces pathname="/" />);
    expect(screen.getByRole('link', { name: 'Flows' })).toHaveAttribute('href', '/flows');
    expect(screen.getByRole('link', { name: 'Automations' })).toHaveAttribute('href', '/admin/automations');
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('lights the one you are on, and only that one', () => {
    wrap(<RailPlaces pathname="/admin/automations" />);
    const auto = screen.getByRole('link', { name: 'Automations' });
    expect(auto).toHaveAttribute('aria-current', 'page');
    expect(auto).toHaveAttribute('data-active');
    expect(screen.getByRole('link', { name: 'Flows' })).not.toHaveAttribute('aria-current');
  });

  it('counts a flow, the flow list and a notebook’s own flow as Flows', () => {
    expect(railPlaceActive('flows', '/flows')).toBe(true);
    expect(railPlaceActive('flows', '/flows/flw_1')).toBe(true);
    expect(railPlaceActive('flows', '/n/nb_1/flow')).toBe(true);
    expect(railPlaceActive('flows', '/n/nb_1')).toBe(false);
    expect(railPlaceActive('flows', '/flowsy')).toBe(false);
    expect(railPlaceActive('automations', '/admin/automations')).toBe(true);
    expect(railPlaceActive('automations', '/admin/health')).toBe(false);
  });

  it('each place has a shortcut of its own', () => {
    const keys = RAIL_PLACES.map((p) => bindingById(p.binding)?.keys);
    expect(keys).toEqual(['g w', 'g u']);
  });
});
