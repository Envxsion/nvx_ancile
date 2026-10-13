/**
 * The tour runner goes to the screen a tour needs and waits for the target
 * before it shows a step; a target that never comes is said out loud.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn(() => Promise.resolve());
let pathname = '/';
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useNavigate: () => navigate,
    useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
      select({ location: { pathname } }),
  };
});
const flows = {
  data: [{ id: 'f1', scope: 'workspace', name: 'Main' }] as unknown[] | undefined,
  isError: false,
};
vi.mock('../src/flows/api', () => ({ useFlows: () => flows }));
vi.mock('../src/lib/data', () => ({
  useNotebooks: () => ({ data: [], isError: false }),
  useThreads: () => ({ data: [], isError: false }),
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...real,
    api: { get: vi.fn(() => Promise.resolve({ value: null })), put: vi.fn(() => Promise.resolve()) },
  };
});

import { useHelp } from '../src/help/store';
import { TARGET_WAIT_MS, TourOverlay } from '../src/help/TourOverlay';

function addTarget(name: string) {
  const el = document.createElement('button');
  el.dataset.tour = name;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  navigate.mockClear();
  pathname = '/';
  flows.data = [{ id: 'f1', scope: 'workspace', name: 'Main' }];
});
afterEach(() => {
  act(() => useHelp.setState({ tour: null }));
  for (const el of document.querySelectorAll('[data-tour]')) el.remove();
  vi.useRealTimers();
});

describe('the tour runner', () => {
  it('takes you to the Flows tab before it shows step one there', async () => {
    const { rerender } = render(<TourOverlay />);
    act(() => useHelp.getState().startTour('flows'));
    expect(navigate).toHaveBeenCalledWith({ to: '/flows' });
    // Still on the old screen: nothing floats over it.
    expect(screen.queryByRole('dialog')).toBeNull();

    pathname = '/flows';
    addTarget('flows-new');
    rerender(<TourOverlay />);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Your flows live here');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens a flow for the canvas step, filling the route parameter', async () => {
    pathname = '/flows';
    addTarget('flows-new');
    render(<TourOverlay />);
    act(() => useHelp.getState().startTour('flows'));
    await screen.findByRole('dialog');
    act(() => useHelp.getState().stepTour(1));
    expect(navigate).toHaveBeenCalledWith({ to: '/flows/$flowId', params: { flowId: 'f1' } });
  });

  it('says what is missing when there is nothing to open', async () => {
    pathname = '/flows';
    addTarget('flows-new');
    flows.data = [];
    render(<TourOverlay />);
    act(() => useHelp.getState().startTour('flows'));
    await screen.findByRole('dialog');
    act(() => useHelp.getState().stepTour(1));
    expect(await screen.findByRole('status')).toHaveTextContent('You have no flows yet');
  });

  it('says so when the target never draws, instead of pointing at nothing', async () => {
    vi.useFakeTimers();
    pathname = '/flows';
    render(<TourOverlay />);
    act(() => useHelp.getState().startTour('flows'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(TARGET_WAIT_MS + 200);
    });
    expect(screen.getByRole('status')).toHaveTextContent('This part is not on this screen');
  });
});
