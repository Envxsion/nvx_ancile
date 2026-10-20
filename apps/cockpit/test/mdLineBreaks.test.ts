/**
 * ------------------------------------------------------------------
 *  Title    |  Single line breaks in an answer stay line breaks
 *  Ref      |  thread/mdPlugins.ts
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: a Gemini answer written as lines joined by
 *           |  one newline ("GREEN\nShipped: ...") rendered as one run
 *           |  of words, because markdown folds a soft break.
 * ------------------------------------------------------------------
 */
import { describe, expect, it } from 'vitest';
import { keepLineBreaks } from '../src/thread/mdPlugins';

describe('keepLineBreaks', () => {
  it('turns a newline inside text into a break, leaving code alone', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'GREEN\r\nShipped: login fix\nNext' }],
        },
        { type: 'code', value: 'a\nb' },
      ],
    };
    keepLineBreaks()(tree);
    const para = tree.children[0] as { children: { type: string; value?: string }[] };
    expect(para.children.map((c) => c.type)).toEqual(['text', 'break', 'text', 'break', 'text']);
    expect(para.children.filter((c) => c.type === 'text').map((c) => c.value)).toEqual([
      'GREEN',
      'Shipped: login fix',
      'Next',
    ]);
    expect((tree.children[1] as { value: string }).value).toBe('a\nb');
  });
});
