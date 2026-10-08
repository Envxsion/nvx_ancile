import { describe, expect, it } from 'vitest';
import { diffStats, lineDiff, parsePatch } from '../src/memory/linediff';
import { conflictSide } from '../src/memory/MemoryEditor';

describe('line diff (review before saving memory)', () => {
  it('shows only what changed, with context, and folds the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const rows = lineDiff(before, after, 2);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
    expect(rows[0]).toEqual({ kind: 'fold', count: 7 });
    expect(rows.filter((r) => r.kind === 'same')).toHaveLength(4);
    expect(rows.find((r) => r.kind === 'del')).toMatchObject({ text: 'line 10', a: 10 });
    expect(rows.find((r) => r.kind === 'add')).toMatchObject({ text: 'line ten', b: 10 });
    expect(rows.at(-1)).toEqual({ kind: 'fold', count: 8 });
  });

  it('handles an added entry at the end of a section', () => {
    const before = '## Preferences\n\n- One.\n\n## Code\n';
    const after = '## Preferences\n\n- One.\n- Two.\n\n## Code\n';
    const rows = lineDiff(before, after);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 0 });
    expect(rows.find((r) => r.kind === 'add')).toMatchObject({ text: '- Two.' });
  });

  it('says nothing changed when nothing did', () => {
    expect(diffStats(lineDiff('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 });
  });

  it("reads git's unified patch", () => {
    const patch = [
      'diff --git a/USER.md b/USER.md',
      'index 1..2 100644',
      '--- a/USER.md',
      '+++ b/USER.md',
      '@@ -3,2 +3,3 @@ x',
      ' ## Preferences',
      '-- Old.',
      '+- New.',
      '+- Also.',
    ].join('\n');
    const rows = parsePatch(patch);
    expect(rows[0]).toEqual({ kind: 'file', path: 'USER.md' });
    expect(rows.filter((r) => r.kind === 'add').map((r) => 'text' in r && r.text)).toEqual([
      '- New.',
      '- Also.',
    ]);
    expect(rows.find((r) => r.kind === 'del')).toMatchObject({ text: '- Old.', a: 4 });
  });
});

describe('conflict sides', () => {
  const marked = 'top\n<<<<<<< saved meanwhile\nA\n=======\nB\n>>>>>>> your edit\nbottom';
  it('splits a marked-up file into the two versions', () => {
    expect(conflictSide(marked, 'ours')).toBe('top\nA\nbottom');
    expect(conflictSide(marked, 'theirs')).toBe('top\nB\nbottom');
  });
});
