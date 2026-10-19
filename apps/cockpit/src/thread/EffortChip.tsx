/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning effort chip
 *  Ref      |  ROADMAP.md EN1 · gateway/effort.ts · docs/prompt-caching.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Beside the model chip, for a model that takes a
 *           |  reasoning effort: how hard it thinks in this thread
 *           |  (low, medium or high), or its own default.
 *  How      |  The levels come from the model (Core reads them from
 *           |  the provider's profile, so a model that ignores effort
 *           |  never shows the chip). Choosing saves the setting on
 *           |  the thread (PATCH /threads/:id { effort }); every later
 *           |  message in the thread sends it. It reads the thread
 *           |  itself, so changing it never redraws the composer.
 *  Note     |  Effort is a request setting, not part of the prompt:
 *           |  changing it keeps the cached start of the conversation.
 *           |  Thinking shows folded under the answer (Parts.tsx).
 *           |  TODO(phase-0.1.1): Pro per-notebook defaults and "auto
 *           |  effort", where the router picks by difficulty and says
 *           |  so in Why.
 * ------------------------------------------------------------------
 */

import type { Effort } from '@nvx/contracts';
import { useThread } from '../lib/data';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { BarLabel, Tip } from '../ui/primitives';
import { EFFORT_WORDS, setEffort } from './effort';

export function EffortChip({ threadId, levels }: { threadId: string; levels: readonly Effort[] }) {
  const value = useThread(threadId).data?.effort ?? null;
  const word = value ? EFFORT_WORDS[value] : null;
  const items: MenuEntry[] = [
    { kind: 'label', label: 'How hard the model thinks' },
    {
      label: 'Model default',
      icon: value === null ? 'check' : undefined,
      onSelect: () => void setEffort(threadId, null),
    },
    ...levels.map(
      (l): MenuEntry => ({
        label: EFFORT_WORDS[l],
        icon: value === l ? 'check' : undefined,
        onSelect: () => void setEffort(threadId, l),
      }),
    ),
    { kind: 'separator' },
    { kind: 'label', label: 'Higher can cost more. Changing it keeps the cache.' },
  ];
  return (
    <DropMenu
      align="start"
      side="top"
      items={items}
      trigger={
        <Tip label={word ? `Thinking effort: ${word.toLowerCase()}` : 'Thinking effort: the model default'}>
          <button
            type="button"
            className="effort-chip"
            data-set={value ?? undefined}
            data-tour="effort-chip"
            aria-label={`Thinking effort: ${word ? word.toLowerCase() : 'model default'}. Change`}
          >
            <Icon name="sparkle" size={12} />
            <BarLabel full={word ? `Effort: ${word}` : 'Effort'} short={word ?? 'Effort'} />
          </button>
        </Tip>
      }
    />
  );
}
