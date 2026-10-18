/**
 * ------------------------------------------------------------------
 *  Title    |  Model lines in pickers (MD4, MD5)
 *  Ref      |  packages/contracts/src/modelwatch.ts
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  A line (Claude Opus) is listed once with a Latest tag
 *           |  and a note saying what answers now; the model it points
 *           |  to and retired models are not offered unless selected;
 *           |  plan and key badges still work with alias ids; an alias
 *           |  answered by its own current model is not a fallback.
 * ------------------------------------------------------------------
 */

import type { ModelBilling } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { modelGroups } from '../src/engines/api';
import type { ModelView } from '../src/lib/types';
import { claudeLine, displayName, sameModelBothWays } from '../src/models/billing';
import { isOwnAnswer, nowNote, offerable, retiredNote } from '../src/models/lines';

const KEY: ModelBilling = { kind: 'key', payer: 'anthropic' };

const m = (id: string, name: string, p: Partial<ModelView> = {}): ModelView => ({
  id,
  name,
  provider: 'Anthropic',
  hue: 'coral',
  via: 'direct',
  contextWindow: 200_000,
  status: 'ready',
  chat: true,
  billing: KEY,
  price: { in: 5, out: 25 },
  ...p,
});

const ALIAS = m('anthropic/opus:latest', 'Claude Opus', {
  aliasOf: 'anthropic/claude-opus-5-6',
  lineId: 'anthropic/opus',
});
const CURRENT = m('anthropic/claude-opus-5-6', 'Claude Opus 5.6', { lineId: 'anthropic/opus' });
const OLD = m('anthropic/claude-opus-5-4', 'Claude Opus 5.4', {
  lineId: 'anthropic/opus',
  lifecycle: 'retired',
});
const SONNET = m('anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5', { lineId: 'anthropic/sonnet' });
const ALL = [ALIAS, CURRENT, OLD, SONNET];

const groups = (currentId: string | null, models = ALL) =>
  modelGroups({ models, engines: undefined, scope: undefined, session: null, currentId });
const entries = (currentId: string | null, models = ALL) => groups(currentId, models).flatMap((g) => g.items);

describe('pickers and lines', () => {
  it('lists the line once with a Latest tag and what answers now', () => {
    const e = entries(null);
    const line = e.find((x) => x.id === 'anthropic/opus:latest');
    expect(line?.name).toBe('Claude Opus');
    expect(line?.tag).toBe('Latest');
    expect(line?.note).toBe('now Claude Opus 5.6');
    expect(e.some((x) => x.id === 'anthropic/claude-sonnet-5-5')).toBe(true);
  });

  it('hides the model the line answers with, and retired models', () => {
    const ids = entries(null).map((x) => x.id);
    expect(ids).not.toContain('anthropic/claude-opus-5-6');
    expect(ids).not.toContain('anthropic/claude-opus-5-4');
  });

  it('never hides the selected model', () => {
    expect(entries('anthropic/claude-opus-5-6').map((x) => x.id)).toContain('anthropic/claude-opus-5-6');
    const old = entries('anthropic/claude-opus-5-4').find((x) => x.id === 'anthropic/claude-opus-5-4');
    expect(old?.current).toBe(true);
    expect(old?.note).toBe('Retired: answers come from Claude Opus 5.6');
  });

  it('keeps the Key badge and the plan or key suffix working with alias ids', () => {
    expect(claudeLine({ id: 'anthropic/opus:latest' })).toBe('opus');
    const plan = m('claude-code/opus', 'Claude Code: Opus', { billing: { kind: 'plan', payer: 'max' } });
    const dupes = sameModelBothWays([plan, ALIAS, SONNET]);
    expect(dupes.has('anthropic/opus:latest')).toBe(true);
    expect(dupes.has('claude-code/opus')).toBe(true);
    expect(displayName(ALIAS, dupes)).toBe('Claude Opus · API key');
    const line = entries(null, [plan, ALIAS, CURRENT]).find((x) => x.id === 'anthropic/opus:latest');
    expect(line?.badge).toBe('Key');
    expect(line?.name).toBe('Claude Opus · API key');
  });

  it('offerable and the notes work on any list', () => {
    expect(offerable(ALL).map((x) => x.id)).toEqual(['anthropic/opus:latest', 'anthropic/claude-sonnet-5-5']);
    expect(offerable(ALL, ['anthropic/claude-opus-5-4']).map((x) => x.id)).toContain(
      'anthropic/claude-opus-5-4',
    );
    expect(nowNote(ALIAS, ALL)).toBe('now Claude Opus 5.6');
    expect(nowNote(SONNET, ALL)).toBeNull();
    expect(retiredNote(OLD, ALL)).toBe('Retired: answers come from Claude Opus 5.6');
    expect(retiredNote(CURRENT, ALL)).toBeNull();
  });
});

describe('answered by the line itself', () => {
  it('is not a fallback when an alias is answered by its own current model', () => {
    expect(isOwnAnswer('anthropic/opus:latest', 'anthropic/claude-opus-5-6', ALL)).toBe(true);
    // An older Opus that stepped in after a failure is a real fallback.
    expect(isOwnAnswer('anthropic/opus:latest', 'anthropic/claude-opus-5-5', ALL)).toBe(false);
  });

  it('is still a fallback when another line or provider answered, or the request was a literal id', () => {
    expect(isOwnAnswer('anthropic/opus:latest', 'anthropic/claude-sonnet-5-5', ALL)).toBe(false);
    expect(isOwnAnswer('anthropic/opus:latest', 'openai/gpt-5.5', ALL)).toBe(false);
    expect(isOwnAnswer('anthropic/claude-opus-5-6', 'anthropic/claude-opus-5-5', ALL)).toBe(false);
  });
});
