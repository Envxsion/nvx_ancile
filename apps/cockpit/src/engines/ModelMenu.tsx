/**
 * ------------------------------------------------------------------
 *  Title    |  The model picker
 *  Ref      |  docs/engines.md · docs/scopes.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One menu for every thread: Claude Code models, cloud
 *           |  models and local models, each with its engine badge.
 *           |  An entry the thread's scope (or the engine) rules out
 *           |  stays in view, greyed, with the reason in words
 *           |  ("This notebook is private: local models only").
 *  How      |  The groups come from useModelGroups (engines/api.ts).
 *           |  Radix DropdownMenu: arrows move, type-ahead jumps,
 *           |  Escape closes; disabled entries are skipped by the keys.
 *           |  When the scope hides something, the last row opens the
 *           |  thread's scope editor. When Claude Code cannot answer,
 *           |  a separate "Set up Claude Code" row (an action, not a
 *           |  model) says why and opens its settings.
 * ------------------------------------------------------------------
 */

import * as DM from '@radix-ui/react-dropdown-menu';
import type { CSSProperties, ReactNode } from 'react';
import { openEditor } from '../editors/store';
import { hueVar } from '../lib/format';
import { Icon } from '../ui/Icon';
import { type ModelEntry, type ModelGroup, SET_UP_CLAUDE_CODE } from './api';

/** Claude Code cannot answer here: why, and what opens its setup (Settings → Claude Code). */
export interface ClaudeCodeSetupRow {
  reason: string;
  onSelect: () => void;
}

export function ModelMenuContent({
  groups,
  onPick,
  threadId,
  label = 'Model for the next message',
  setup,
}: {
  groups: ModelGroup[];
  onPick: (e: ModelEntry) => void;
  threadId?: string | undefined;
  label?: string;
  setup?: ClaudeCodeSetupRow | null | undefined;
}) {
  const scoped = groups.some((g) =>
    g.items.some((i) => i.disabled && /notebook|thread|computer/.test(i.disabled)),
  );
  return (
    <DM.Content
      className="menu model-menu"
      side="top"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      aria-label={label}
    >
      <DM.Label className="menu__label">{label}</DM.Label>
      {groups.length === 0 ? (
        <DM.Item className="menu__item" disabled>
          <span className="menu__noicon" />
          <span className="menu__text">No models are set up yet</span>
        </DM.Item>
      ) : null}
      {groups.map((g, gi) => (
        <DM.Group key={g.kind} aria-label={g.label}>
          {gi > 0 ? <DM.Separator className="menu__sep" /> : null}
          <DM.Label className="menu__label model-menu__group">{g.label}</DM.Label>
          {g.items.map((e) => (
            <DM.Item
              key={e.id}
              className="menu__item model-menu__item"
              disabled={!!e.disabled}
              data-current={e.current || undefined}
              onSelect={() => onPick(e)}
            >
              {e.current ? <Icon name="check" size={14} /> : <span className="menu__noicon" />}
              <span
                className="model-menu__swatch"
                style={{ '--hue': hueVar(e.hue) } as CSSProperties}
                aria-hidden="true"
              />
              <span className="menu__text model-menu__text">
                <span className="model-menu__name">{e.name}</span>
                {e.disabled ? (
                  <span className="model-menu__why">{e.disabled}</span>
                ) : e.note ? (
                  <span className="cc-pick__desc">{e.note}</span>
                ) : null}
              </span>
              <span className="model-badge" data-kind={e.kind}>
                {e.badge}
              </span>
            </DM.Item>
          ))}
        </DM.Group>
      ))}
      {setup ? (
        <>
          {groups.length ? <DM.Separator className="menu__sep" /> : null}
          <DM.Item className="menu__item model-menu__item" onSelect={setup.onSelect}>
            <Icon name="terminal" size={14} />
            <span className="menu__text model-menu__text">
              <span className="model-menu__name">{SET_UP_CLAUDE_CODE}</span>
              <span className="model-menu__why">{setup.reason}</span>
            </span>
          </DM.Item>
        </>
      ) : null}
      {scoped && threadId ? (
        <>
          <DM.Separator className="menu__sep" />
          <DM.Item
            className="menu__item"
            onSelect={() => openEditor({ kind: 'scope', level: 'thread', id: threadId })}
          >
            <Icon name="shield" size={14} />
            <span className="menu__text">See what this thread may use</span>
          </DM.Item>
        </>
      ) : null}
    </DM.Content>
  );
}

/** A trigger and the picker, for places that are not the palette. */
export function ModelMenu({
  trigger,
  groups,
  onPick,
  threadId,
  open,
  onOpenChange,
  label,
  setup,
}: {
  trigger: ReactNode;
  groups: ModelGroup[];
  onPick: (e: ModelEntry) => void;
  threadId?: string | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  label?: string;
  setup?: ClaudeCodeSetupRow | null | undefined;
}) {
  return (
    <DM.Root modal={false} {...(open !== undefined && { open })} {...(onOpenChange && { onOpenChange })}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <ModelMenuContent
          groups={groups}
          onPick={onPick}
          threadId={threadId}
          setup={setup}
          {...(label && { label })}
        />
      </DM.Portal>
    </DM.Root>
  );
}
