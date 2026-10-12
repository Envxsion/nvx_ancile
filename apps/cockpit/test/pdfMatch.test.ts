/**
 * ------------------------------------------------------------------
 *  Title    |  PDF text matching
 *  Ref      |  apps/cockpit/src/sources/pdf.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A cited passage and a search land on the right words
 *           |  of a PDF page despite line breaks, hyphenation,
 *           |  spacing, accents and markdown marks.
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import {
  countMatches,
  findAll,
  fold,
  isMarkdown,
  isPdf,
  locatePassage,
  pagesToTry,
  zoomStep,
} from '../src/sources/pdf';

const page = [
  'The results of the co-',
  'operation study were',
  ' clear: ',
  'Café owners saw a 12% rise',
  ' in footfall.',
];

describe('fold', () => {
  it('keeps letters and digits only, lower case, without accents', () => {
    expect(fold('Café **owners**, 12%!')).toBe('cafeowners12');
  });
  it('unfolds ligatures', () => {
    expect(fold('ﬁnal')).toBe('final');
  });
});

describe('findAll', () => {
  it('finds a phrase split across runs and a hyphenated line end', () => {
    const m = findAll(page, 'cooperation study');
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual([
      { item: 0, start: 19, end: 21 },
      { item: 1, start: 0, end: 15 },
    ]);
  });

  it('ignores case and accents', () => {
    expect(findAll(page, 'CAFE owners')[0]?.[0]).toEqual({ item: 3, start: 0, end: 11 });
  });

  it('finds nothing for one character', () => {
    expect(findAll(page, 'a')).toEqual([]);
  });

  it('counts every occurrence', () => {
    expect(countMatches(['one two one', 'one'], 'one')).toBe(3);
    expect(findAll(['one two one', 'one'], 'one')).toHaveLength(3);
  });
});

describe('locatePassage', () => {
  it('finds the whole passage through markdown marks and line breaks', () => {
    const hit = locatePassage(page, 'The results of the **co-operation** study were clear:\n\nCafé owners');
    expect(hit).toEqual({ needle: expect.any(String), kind: 'full' });
  });

  it('falls back to the longest run of the first words', () => {
    const hit = locatePassage(
      page,
      'Café owners saw a 12% rise in footfall, which the authors put down to the new bus route.',
    );
    expect(hit?.kind).toBe('partial');
    expect(fold(hit?.needle ?? '')).toBe(fold('Café owners saw a 12% rise in footfall,'));
  });

  it('says so when nothing matches', () => {
    expect(locatePassage(page, 'Entirely unrelated words that are nowhere on this page')).toBeNull();
  });
});

describe('helpers', () => {
  it('tries the cited page, then its neighbours', () => {
    expect(pagesToTry(1, 3)).toEqual([1, 2]);
    expect(pagesToTry(3, 3)).toEqual([3, 2]);
  });

  it('steps the zoom', () => {
    expect(zoomStep(1, 1)).toBe(1.25);
    expect(zoomStep(1, -1)).toBe(0.8);
    expect(zoomStep(3, 1)).toBe(3);
    expect(zoomStep(1.1, 1)).toBe(1.25);
  });

  it('tells a PDF and markdown by type or name', () => {
    expect(isPdf({ kind: 'file', mime: 'application/pdf' })).toBe(true);
    expect(isPdf({ kind: 'file', mime: null, uri: 'Report.PDF' })).toBe(true);
    expect(isPdf({ kind: 'url', uri: 'https://x/a.pdf' })).toBe(false);
    expect(isMarkdown({ kind: 'file', mime: 'text/markdown' })).toBe(true);
    expect(isMarkdown({ kind: 'file', uri: 'notes.md' })).toBe(true);
    expect(isMarkdown({ kind: 'file', mime: 'application/pdf' })).toBe(false);
  });
});
