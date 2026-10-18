/**
 * ------------------------------------------------------------------
 *  Title    |  Admin
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One place for the machinery: health, compute, permissions,
 *           |  memory, logs and the rest, grouped by what they are for.
 * ------------------------------------------------------------------
 */

import { Link, Navigate, Outlet, useParams } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { Icon } from '../../ui/Icon';
import { EmptyState } from '../../ui/primitives';
import { ADMIN_SECTIONS, type AdminSection } from './sections';

const GROUPS: AdminSection['group'][] = ['System', 'Trust', 'Models', 'Extend'];

export function AdminLayout() {
  const { section } = useParams({ strict: false });
  const nav = useRef<HTMLElement>(null);
  // On narrow screens the sections are one scrolling row: keep the open one in view.
  useEffect(() => {
    if (!section) return;
    const active = nav.current?.querySelector<HTMLElement>('[data-active]');
    if (active && nav.current && nav.current.scrollWidth > nav.current.clientWidth)
      active.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [section]);
  return (
    <div className="admin">
      <nav ref={nav} className="admin__nav" aria-label="Admin">
        {GROUPS.map((g) => (
          <div key={g} className="admin__group">
            <h2 className="admin__group-h">{g}</h2>
            <ul>
              {ADMIN_SECTIONS.filter((s) => s.group === g).map((s) => (
                <li key={s.id}>
                  <Link
                    to="/admin/$section"
                    params={{ section: s.id }}
                    className="admin__link"
                    data-active={section === s.id || undefined}
                  >
                    <Icon name={s.icon} size={14} />
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {/* Focusable so the keyboard can scroll it when a page has no controls (axe: scrollable-region-focusable). */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable from the keyboard */}
      <div className="admin__main" data-scrollable tabIndex={0} role="region" aria-label="Admin section">
        <Outlet />
      </div>
    </div>
  );
}

export function AdminSectionScreen() {
  const { section } = useParams({ strict: false });
  // Permissions were called Grants: an old link still lands there.
  if (section === 'grants')
    return <Navigate to="/admin/$section" params={{ section: 'permissions' }} replace />;
  const found = ADMIN_SECTIONS.find((s) => s.id === section);
  if (!found)
    return (
      <EmptyState
        icon="settings"
        title="There is no admin page by that name"
        body="Pick a section from the list on the left."
      />
    );
  // Rendered as a component, not called, so each section keeps its own hooks.
  const Body = found.render;
  return (
    <div className="admin__page" key={found.id}>
      <h1 className="admin__title" data-display>
        {found.label}
      </h1>
      <Body />
    </div>
  );
}
