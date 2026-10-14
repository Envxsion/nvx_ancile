/**
 * A tool step's one-line preview reads as words: no colour codes, no box
 * drawing, no rules drawn with dashes (thread/ToolSteps.tsx, plainLine).
 */
import { describe, expect, it } from 'vitest';
import { oneLine, plainLine } from '../src/thread/ToolSteps';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('plainLine', () => {
  it('drops rules drawn around a heading', () => {
    expect(plainLine('—— indexing workspace ————————————')).toBe('indexing workspace');
    expect(plainLine('=== RUN tests ===')).toBe('RUN tests');
    expect(plainLine('----- migration ledger -----')).toBe('migration ledger');
  });

  it('drops box drawing, blocks and spinners', () => {
    expect(plainLine('╒══════════════════╕')).toBe('');
    expect(plainLine('│ RLS policy surface │')).toBe('RLS policy surface');
    expect(plainLine('████▌ 62%')).toBe('62%');
    expect(plainLine('⠋ building')).toBe('building');
  });

  it('drops colour codes and terminal titles', () => {
    expect(plainLine(`${ESC}[1;32mPASS${ESC}[0m one`)).toBe('PASS one');
    expect(plainLine(`${ESC}]0;title${BEL}done`)).toBe('done');
  });

  it('keeps ordinary punctuation', () => {
    expect(plainLine('a - b -- c')).toBe('a - b -- c');
    expect(plainLine('Loading...')).toBe('Loading...');
    expect(plainLine('Error: not found')).toBe('Error: not found');
    expect(plainLine('+3 more')).toBe('+3 more');
  });

  it('collapses whitespace', () => {
    expect(plainLine('  a\t\tb   c  ')).toBe('a b c');
  });
});

describe('oneLine', () => {
  it('skips lines that were only a frame', () => {
    expect(oneLine('┌────────┐\n│        │\n─── Survey RLS ───\nrest')).toBe('Survey RLS');
    expect(oneLine('════════\n--------\n')).toBeNull();
  });
});
