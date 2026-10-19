/**
 * SE2: the section list and the settings panel scroll on their own, so a
 * lower section is reachable without scrolling the whole page, at laptop and
 * tablet widths. The open section is scrolled into view, and a section or a
 * search starts at the top of the panel.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ group: 'advanced' }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ group: route.group }),
  Link: ({
    children,
    className,
    ...rest
  }: {
    children: ReactNode;
    className?: string;
    params?: { group: string };
    to?: string;
    onClick?: () => void;
    'data-active'?: boolean;
  }) => (
    <a href="#x" className={className} data-active={rest['data-active']}>
      {children}
    </a>
  ),
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  const ok = () => Promise.resolve({});
  return {
    ...real,
    api: { get: vi.fn(ok), post: vi.fn(ok), put: vi.fn(ok), patch: vi.fn(ok), del: vi.fn(ok) },
  };
});

import { queryClient } from '../src/lib/query';
import { SettingsScreen } from '../src/routes/settings/Settings';
import { read, stripComments } from './tokenCss';

const css = stripComments(read('../src/styles/kit.css'));
/** The declarations of the first rule with exactly this selector list. */
function rule(sel: string): string {
  const i = css.indexOf(`${sel} {`);
  expect(i, `${sel} exists`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

describe('settings scroll within their own panels', () => {
  it('the page itself does not scroll; the section list and the panel do, with a thin scrollbar', () => {
    expect(rule('.settings')).toMatch(/overflow:\s*hidden/);
    const both = rule('.settings__nav,\n.settings__main');
    expect(both).toMatch(/overflow-y:\s*auto/);
    expect(both).toMatch(/min-height:\s*0/);
    expect(both).toMatch(/scrollbar-width:\s*thin/);
  });

  it('on a phone the strip sits above the panel and the page scrolls as one', () => {
    const start = css.indexOf('@media (max-width: 820px)', css.indexOf('.settings__main {'));
    expect(start).toBeGreaterThan(-1);
    const narrow = css.slice(start, css.indexOf('/* ---- Sources', start));
    expect(narrow).toMatch(/\.settings \{[^}]*overflow:\s*auto/);
    expect(narrow).toMatch(/\.settings__nav,\s*\.settings__main \{[^}]*overflow:\s*visible/);
  });

  it('a laptop (1280) and a tablet (900) both keep the list beside the panel', () => {
    // The only break point is 820px: wider than that, the section list stays in its own column.
    expect(rule('.settings')).toMatch(/grid-template-columns:\s*240px/);
    expect(css).toContain('@media (max-width: 820px)');
  });
});

describe('the Settings screen', () => {
  beforeEach(() => {
    queryClient.clear();
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn() as never;
  });

  it('scrolls the open section into view and the panel to the top; the panel takes keyboard focus', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <SettingsScreen />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    const panel = screen.getByRole('region', { name: 'Settings' });
    expect(panel).toHaveAttribute('tabindex', '0');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 0 });
    // The list comes before the panel in the reading order.
    const list = screen.getByRole('complementary', { name: 'Settings groups' });
    expect(list.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
