/**
 * ------------------------------------------------------------------
 *  Title    |  The palette lists models like the composer's menu
 *  Ref      |  apps/cockpit/src/palette/modelSections.ts · docs/models.md
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  A heading per company, older models behind one Older
 *           |  row, and an OpenRouter copy of a model a provider
 *           |  serves directly as "also via OpenRouter", not a row.
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import type { ModelEntry, ModelGroup } from '../src/engines/api';
import { modelSections, openRouterCopies } from '../src/palette/modelSections';

const e = (id: string, name: string, p: Partial<ModelEntry> = {}, provider = 'Anthropic'): ModelEntry => ({
  id,
  name,
  hue: 'coral',
  kind: 'cloud',
  badge: 'Key',
  badgeTitle: null,
  note: null,
  group: provider,
  disabled: null,
  current: false,
  model: { provider } as ModelEntry['model'],
  ...p,
});

const group = (items: ModelEntry[]): ModelGroup => ({
  kind: 'cloud',
  label: 'Cloud models',
  note: null,
  items,
});

const sonnet = e('anthropic/sonnet:latest', 'Claude Sonnet');
const sonnetOld = e('anthropic/claude-sonnet-5', 'Claude Sonnet 5', { older: true });
const gpt = e('openai/sol:latest', 'GPT Sol', {}, 'OpenAI');
const orSonnet = e(
  'openrouter/anthropic-sonnet:latest',
  'Anthropic: Claude Sonnet',
  { group: 'OpenRouter · Anthropic' },
  'OpenRouter',
);
const orLlama = e(
  'openrouter/meta-llama:latest',
  'Llama large',
  { group: 'OpenRouter · Meta' },
  'OpenRouter',
);

describe('the palette model rows', () => {
  const groups = [group([sonnet, sonnetOld, gpt, orSonnet, orLlama])];

  it('puts a heading over each provider and keeps older ones behind an Older row', () => {
    const { sections } = modelSections(groups, { typed: false, olderOpen: new Set() });
    expect(sections.map((s) => s.heading)).toEqual(['Anthropic', 'OpenAI', 'OpenRouter · Meta']);
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).not.toContain('anthropic/claude-sonnet-5');
    expect(sections.at(-1)?.older).toBe(1);
  });

  it('shows the older models once the Older row is opened', () => {
    const { sections } = modelSections(groups, { typed: false, olderOpen: new Set(['cloud']) });
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).toContain('anthropic/claude-sonnet-5');
    expect(sections.every((s) => s.older === 0)).toBe(true);
  });

  it('shows an OpenRouter copy of a direct model as a note on the direct row, not a second row', () => {
    const { sections, also } = modelSections(groups, { typed: false, olderOpen: new Set() });
    const ids = sections.flatMap((s) => s.items.map((i) => i.id));
    expect(ids).not.toContain(orSonnet.id);
    expect(ids).toContain(orLlama.id); // no direct twin
    expect(also.has(sonnet.id)).toBe(true);
    expect(also.has(gpt.id)).toBe(false);
  });

  it('finds everything, copies and older included, when you type', () => {
    const { sections } = modelSections(groups, { typed: true, olderOpen: new Set() });
    expect(sections.flatMap((s) => s.items.map((i) => i.id)).sort()).toEqual(
      [sonnet, sonnetOld, gpt, orSonnet, orLlama].map((i) => i.id).sort(),
    );
  });

  it('never folds away or hides the model in use', () => {
    const inUse = { ...sonnetOld, current: true };
    const used = modelSections([group([sonnet, inUse])], { typed: false, olderOpen: new Set() });
    expect(used.sections.flatMap((s) => s.items.map((i) => i.id))).toContain(inUse.id);
    const copy = { ...orSonnet, current: true };
    expect(openRouterCopies([sonnet, copy]).size).toBe(0);
  });
});
