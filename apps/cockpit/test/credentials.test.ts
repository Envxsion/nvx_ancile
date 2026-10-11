/**
 * Settings → API keys and the try-out models: every credential has a row
 * and a place to get it; status never shows more than four characters; the
 * try-out models step aside once a real model is ready.
 */
import { CredentialId } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_META, statusText } from '../src/credentials/ApiKeys';
import { hideTryout } from '../src/lib/mappers';

describe('API keys', () => {
  it('has a row, with an https link to get one, for every credential Core knows', () => {
    expect(CREDENTIAL_META.map((m) => m.id).sort()).toEqual([...CredentialId.options].sort());
    for (const m of CREDENTIAL_META) expect(m.getUrl).toMatch(/^https:\/\//);
  });

  it('says where a value comes from, and only its last four characters', () => {
    expect(statusText(undefined)).toBe('Not set');
    expect(statusText({ set: false, source: null, last4: null })).toBe('Not set');
    expect(statusText({ set: true, source: 'saved', last4: '4f2a' })).toBe('Saved · ends in 4f2a');
    expect(statusText({ set: true, source: 'saved', last4: null })).toBe('Saved');
    expect(statusText({ set: true, source: 'environment', last4: '9876' })).toBe(
      'Set in the environment · ends in 9876',
    );
  });

  it('keeps UI copy free of em dashes', () => {
    for (const m of CREDENTIAL_META)
      for (const text of [m.name, m.desc, m.removes, m.getLabel]) expect(text).not.toContain('—');
  });
});

describe('try-out models', () => {
  const tryout = { id: 'offline/test', offline: true, status: 'ready', chat: true };
  const echo = { id: 'offline/echo', offline: true, status: 'ready', chat: true };
  const claude = { id: 'anthropic/c', offline: false, status: 'needs_key', chat: true };

  it('stay while no real model can answer', () => {
    expect(hideTryout([tryout, echo, claude], false)).toHaveLength(3);
  });

  it('leave once a real model is ready', () => {
    const ready = { ...claude, status: 'ready' };
    expect(hideTryout([tryout, echo, ready], false).map((m) => m.id)).toEqual(['anthropic/c']);
  });

  it('do not count an embedding model as a real one', () => {
    const embed = { id: 'local/embed', offline: false, status: 'ready', chat: false };
    expect(hideTryout([tryout, embed], false)).toHaveLength(2);
  });

  it('stay when "Show try-out models" is on', () => {
    expect(hideTryout([tryout, { ...claude, status: 'ready' }], true)).toHaveLength(2);
  });
});
