/** The chain edits Admin → Routing makes: move, add, remove, never in place. */
import { describe, expect, it } from 'vitest';
import { addModel, moveBy, moveTo, removeModel, sameOrder } from '../src/routes/admin/chainOrder';

const chain = ['a', 'b', 'c'] as const;

describe('chain order', () => {
  it('moves a model up and down, and stays put at either end', () => {
    expect(moveBy(chain, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveBy(chain, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveBy(chain, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(chain, 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(chain, 'x', 1)).toEqual(['a', 'b', 'c']);
  });

  it('moves to a place, clamped', () => {
    expect(moveTo(chain, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveTo(chain, 0, 9)).toEqual(['b', 'c', 'a']);
    expect(moveTo(chain, 5, 0)).toEqual(['a', 'b', 'c']);
  });

  it('adds to the end once, and removes', () => {
    expect(addModel(chain, 'd')).toEqual(['a', 'b', 'c', 'd']);
    expect(addModel(chain, 'b')).toEqual(['a', 'b', 'c']);
    expect(removeModel(chain, 'b')).toEqual(['a', 'c']);
  });

  it('never changes the chain it was given', () => {
    const before = [...chain];
    moveTo(chain, 0, 2);
    removeModel(chain, 'a');
    expect([...chain]).toEqual(before);
    expect(sameOrder(chain, before)).toBe(true);
    expect(sameOrder(chain, ['a', 'c', 'b'])).toBe(false);
  });
});
