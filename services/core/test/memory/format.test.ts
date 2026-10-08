import { describe, expect, it } from 'vitest';
import {
  addEntry,
  derivedKey,
  entries,
  parseMemory,
  renderMemory,
  supersedeEntry,
  updateEntry,
} from '../../src/memory/format';

const USER = `---
type: user
scope: global
updated: 2026-10-07
---
# Preferences

- Use British spelling in prose and code comments. <!-- m:01J9Z3 conf:0.92 src:msg_01J9YX at:2026-10-07 -->
- Prefers tables over long lists
  when comparing options. <!-- m:01J9Z4 conf:0.8 src:msg_01J9YQ at:2026-10-06 -->
- Written by hand, no trailer.

Some free text the user wrote.

## Superseded
- ~~Prefers bullet summaries.~~ <!-- m:01J8AA superseded_by:01J9Z4 at:2026-10-06 -->
`;

describe('parse/render', () => {
  it('round-trips a hand-written file byte for byte', () => {
    expect(renderMemory(parseMemory(USER))).toBe(USER);
  });

  it('round-trips CRLF files and files with no final newline', () => {
    const crlf = USER.replace(/\n/g, '\r\n');
    expect(renderMemory(parseMemory(crlf))).toBe(crlf);
    const bare = USER.trimEnd();
    expect(renderMemory(parseMemory(bare))).toBe(bare);
    expect(renderMemory(parseMemory(''))).toBe('');
  });

  it('reads front matter, entries, trailers and continuation lines', () => {
    const doc = parseMemory(USER);
    expect(doc.frontMatter).toMatchObject({ type: 'user', scope: 'global' });
    const live = entries(doc);
    expect(live.map((e) => e.key)).toEqual(['01J9Z3', '01J9Z4', derivedKey('Written by hand, no trailer.')]);
    expect(live[0]?.meta).toMatchObject({ conf: 0.92, src: 'msg_01J9YX', at: '2026-10-07' });
    expect(live[1]?.text).toBe('Prefers tables over long lists\nwhen comparing options.');
    expect(live[0]?.section).toBe('Preferences');
  });

  it('marks superseded entries and strips the strike-through', () => {
    const all = entries(parseMemory(USER), { includeSuperseded: true });
    const old = all.find((e) => e.key === '01J8AA');
    expect(old).toMatchObject({ superseded: true, text: 'Prefers bullet summaries.' });
    expect(old?.meta.superseded_by).toBe('01J9Z4');
  });

  it('derives keys that survive whitespace edits', () => {
    expect(derivedKey('Written  by hand,\nno trailer.')).toBe(derivedKey('Written by hand, no trailer.'));
  });
});

describe('editing', () => {
  it('adds to the end of an existing section without touching other bytes', () => {
    const doc = addEntry(parseMemory(USER), 'Preferences', 'Short answers first.', {
      m: 'NEW1',
      conf: 0.9,
      at: '2026-10-07',
    });
    const out = renderMemory(doc);
    expect(out).toContain(
      '- Written by hand, no trailer.\n- Short answers first. <!-- m:NEW1 conf:0.9 at:2026-10-07 -->\n\nSome free text',
    );
    expect(out.replace('- Short answers first. <!-- m:NEW1 conf:0.9 at:2026-10-07 -->\n', '')).toBe(USER);
  });

  it('creates a missing section at the end', () => {
    const out = renderMemory(
      addEntry(parseMemory('# Notes\n\nfree text'), 'Findings', 'It works.', { m: 'F1' }),
    );
    expect(out).toBe('# Notes\n\nfree text\n\n## Findings\n\n- It works. <!-- m:F1 -->\n');
  });

  it('updates only the edited entry and keeps its key', () => {
    const doc = updateEntry(parseMemory(USER), '01J9Z3', 'Use British spelling everywhere.', { conf: 0.95 });
    const e = entries(doc).find((x) => x.key === '01J9Z3');
    expect(e?.text).toBe('Use British spelling everywhere.');
    expect(e?.meta.conf).toBe(0.95);
    const out = renderMemory(doc);
    expect(out).toContain('<!-- m:01J9Z3 conf:0.95 src:msg_01J9YX at:2026-10-07 -->');
    expect(out.split('\n').length).toBe(USER.split('\n').length);
  });

  it('supersedes by moving the old belief, struck through, into Superseded', () => {
    const doc = supersedeEntry(parseMemory(USER), '01J9Z3', 'NEWKEY', '2026-10-08');
    expect(entries(doc).some((e) => e.key === '01J9Z3')).toBe(false);
    const moved = entries(doc, { includeSuperseded: true }).find((e) => e.key === '01J9Z3');
    expect(moved).toMatchObject({
      superseded: true,
      text: 'Use British spelling in prose and code comments.',
      section: 'Superseded',
    });
    expect(renderMemory(doc)).toContain(
      '- ~~Use British spelling in prose and code comments.~~ <!-- m:01J9Z3 at:2026-10-08 superseded_by:NEWKEY -->',
    );
  });
});
