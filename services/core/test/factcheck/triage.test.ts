/**
 * Fact-check triage (TR3): how much model a claim needs, decided by rules a person can read, with the
 * decision layer allowed to raise a tier and never to lower one; and when a claim is sent up a tier.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  escalateTo,
  MAX_HOPS,
  setTriageProvider,
  triageClaim,
  triageClaims,
} from '../../src/factcheck/triage';

const off = { critical: false };

afterEach(() => setTriageProvider(null));

describe('the rules', () => {
  it.each(['The sky is blue.', 'Water is wet.', 'Cats are mammals.'])(
    'sends an obvious short claim to a tiny model: %s',
    (c) => {
      expect(triageClaim(c, off)).toMatchObject({ tier: 'tiny', obvious: true, critical: false });
    },
  );

  it.each([
    ['The pump failed after 14 hours of use.', 'number'],
    ['The treaty was signed in March 1648 by all parties.', 'date'],
    ['Smith et al. found the effect was larger in adults.', 'citation'],
    ['The contract is void if either party withdraws.', 'legal'],
    ['Take the tablet with food to reduce nausea, per the medical guidance.', 'medical'],
    ['The loan has a lower interest rate than the mortgage.', 'financial'],
  ])('sends %s to standard or better (%s)', (c) => {
    const t = triageClaim(c, off);
    expect(t.tier).toBe('balanced');
    expect(t.obvious).toBe(false);
  });

  it('sends a long or many-part claim to standard', () => {
    const long = `${'The system reads the queue and writes the result to the log '.repeat(6)}end.`;
    expect(triageClaim(long, off).tier).toBe('balanced');
    expect(triageClaim('It reads the queue; it also writes the result to disk.', off).tier).toBe('balanced');
  });

  it('keeps names out of the tiny tier', () => {
    expect(triageClaim('Paris is the capital of France.', off)).toMatchObject({
      tier: 'fast',
      obvious: false,
    });
  });

  it('holds a critical notebook, or a claim you marked, at standard with a floor', () => {
    expect(triageClaim('The sky is blue.', { critical: true })).toMatchObject({
      tier: 'balanced',
      floor: 'balanced',
      critical: true,
      obvious: false,
    });
    expect(triageClaim('The sky is blue.', { critical: false, marked: true })).toMatchObject({
      tier: 'balanced',
      floor: 'balanced',
      critical: true,
    });
  });
});

describe('the decision layer', () => {
  it('can raise a tier, never lower one', async () => {
    setTriageProvider({
      triage: async () => [{ tier: 'best' }, { tier: 'tiny' }, null],
    });
    const out = await triageClaims(
      ['The sky is blue.', 'The pump failed after 14 hours.', 'Water is wet.'],
      off,
    );
    expect(out.map((t) => t.tier)).toEqual(['best', 'balanced', 'tiny']);
    expect(out[0]?.obvious).toBe(false);
    expect(out[2]?.obvious).toBe(true);
  });

  it('can mark a claim critical, which lifts it to standard', async () => {
    setTriageProvider({ triage: async () => [{ critical: true }] });
    const [t] = await triageClaims(['The sky is blue.'], off);
    expect(t).toMatchObject({ tier: 'balanced', critical: true, obvious: false });
  });

  it('falls back to the rules when it fails or says nothing', async () => {
    setTriageProvider({
      triage: async () => {
        throw new Error('down');
      },
    });
    expect((await triageClaims(['The sky is blue.'], off))[0]?.tier).toBe('tiny');
    setTriageProvider({ triage: async () => null });
    expect((await triageClaims(['The sky is blue.'], off))[0]?.tier).toBe('tiny');
  });

  it('is not asked in a critical notebook: the rules already hold everything at standard', async () => {
    let asked = 0;
    setTriageProvider({
      triage: async () => {
        asked++;
        return null;
      },
    });
    await triageClaims(['The sky is blue.'], { critical: true });
    expect(asked).toBe(0);
  });
});

describe('going up a tier', () => {
  const base = { hops: 0, verdict: 'supported' as const, confidence: 0.9, critical: false };

  it('goes up on a contradiction, on low confidence, or when a critical claim was under-checked', () => {
    expect(escalateTo({ ...base, tier: 'fast', verdict: 'contradicted' })).toBe('balanced');
    expect(escalateTo({ ...base, tier: 'tiny', confidence: 0.4 })).toBe('fast');
    expect(escalateTo({ ...base, tier: 'fast', critical: true })).toBe('balanced');
  });

  it('stays put when the model is sure and nothing else asks', () => {
    expect(escalateTo({ ...base, tier: 'tiny' })).toBeNull();
    expect(escalateTo({ ...base, tier: 'fast', confidence: null, verdict: 'insufficient' })).toBeNull();
    expect(escalateTo({ ...base, tier: 'balanced', critical: true })).toBeNull();
  });

  it('stops at frontier and after two hops', () => {
    expect(escalateTo({ ...base, tier: 'best', verdict: 'contradicted' })).toBeNull();
    expect(escalateTo({ ...base, tier: 'tiny', verdict: 'contradicted', hops: MAX_HOPS })).toBeNull();
    expect(MAX_HOPS).toBe(2);
  });
});
