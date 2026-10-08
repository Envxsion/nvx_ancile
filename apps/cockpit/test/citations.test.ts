import { describe, expect, it } from 'vitest';
import { linkMarkers, plainQuote } from '../src/thread/Citations';

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
