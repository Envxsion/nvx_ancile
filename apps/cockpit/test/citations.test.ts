import { describe, expect, it } from 'vitest';
import { listLanguages } from '../src/drawer/SourcesPanel';
import { linkMarkers, plainQuote, sourceNote } from '../src/thread/Citations';

const NBSP = ' ';
const WJ = '⁠';

describe('linkMarkers', () => {
  it('links markers and glues them to the word before and the punctuation after', () => {
    expect(linkMarkers('Loft insulation pays back fastest [2]. If you insulate')).toBe(
      `Loft insulation pays back fastest${NBSP}[2](#cite-2)${WJ}. If you insulate`,
    );
  });

  it('keeps a run of chips together and leaves the space after them', () => {
    expect(linkMarkers('It moves 42 litres [1][3] and weighs 18 kg.')).toBe(
      `It moves 42 litres${NBSP}[1](#cite-1)${WJ}[3](#cite-3) and weighs 18 kg.`,
    );
  });

  it('glues a chip that follows a full stop', () => {
    expect(linkMarkers('Service it yearly. [3]\n\nNext')).toBe(
      `Service it yearly.${NBSP}[3](#cite-3)\n\nNext`,
    );
  });

  it('leaves code and real links alone', () => {
    expect(linkMarkers('Use `arr[3]` and [the docs](https://x.y).')).toBe(
      'Use `arr[3]` and [the docs](https://x.y).',
    );
  });
});

describe('plainQuote', () => {
  it('drops headings and emphasis marks', () => {
    expect(plainQuote('# P-300\n\nThe **P-300** moves `42` litres.')).toBe('The P-300 moves 42 litres.');
  });
});

describe('a cited source that is gone or different now (track G)', () => {
  type Status = NonNullable<Parameters<typeof sourceNote>[0]>;
  const status = (over: Partial<Status>): Status => ({
    marker: 1,
    chunk_id: 'chk_1',
    source_id: 'src_1',
    state: 'current',
    source_title: 'Pump manual',
    removed_at: null,
    merged_into: null,
    ...over,
  });

  it('says nothing while the source holds the passage, or when it could not be checked', () => {
    expect(sourceNote(status({}))).toBeNull();
    expect(sourceNote(status({ state: 'unknown' }))).toBeNull();
    expect(sourceNote(undefined)).toBeNull();
  });

  it('says "Source removed", with the date, and that the quote is what the answer was given', () => {
    const n = sourceNote(status({ state: 'removed', removed_at: '2026-10-12T09:00:00.000Z' }));
    expect(n?.label).toBe('Source removed');
    expect(n?.detail).toBe('It was deleted on 12 Oct 2026. The passage above is what this answer was given.');
    expect(sourceNote(status({ state: 'removed', merged_into: 'src_2' }))?.detail).toMatch(/^It was merged/);
  });

  it('says "Source changed since cited"', () => {
    expect(sourceNote(status({ state: 'changed' }))?.label).toBe('Source changed since cited');
  });
});

describe('listLanguages', () => {
  it('names languages in British English', () => {
    expect(listLanguages(['en', 'fr'])).toBe('English and French');
    expect(listLanguages(['en', 'fr', 'de'])).toBe('English, French and German');
    expect(listLanguages(['ja'])).toBe('Japanese');
  });
});
