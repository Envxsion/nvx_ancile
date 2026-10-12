import { deflateRawSync } from 'node:zlib';
import { AncileError } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { isMarkdownExport, readMarkdownExport, readZip, writeMarkdownExport } from '../../src/memory/archive';
import { defaultSection, entryText, fromChatGpt, fromNotes, sameText } from '../../src/memory/importers';
import { MemoryProposalStore, PgProposalStore } from '../../src/memory/proposals';
import { eachBackend, uid } from '../support/stores';

/** A minimal zip writer for tests: stored or deflated entries. */
function zip(files: { name: string; data: string; deflate?: boolean; claim?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data, 'utf8');
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.claim ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.claim ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('reading archives', () => {
  it('reads stored and deflated markdown, and skips everything else', () => {
    const files = readZip(
      zip([
        { name: 'USER.md', data: '- a\n' },
        { name: 'PROJECTS/x.md', data: '- b\n', deflate: true },
        { name: 'PROJECTS/', data: '' },
        { name: '.git/config', data: 'x' },
        { name: 'image.png', data: 'x' },
      ]),
    );
    expect(files).toEqual([
      { path: 'USER.md', content: '- a\n' },
      { path: 'PROJECTS/x.md', content: '- b\n' },
    ]);
  });

  it('refuses what is not a zip, and archives that claim too much', () => {
    expect(() => readZip(Buffer.from('hello'))).toThrow(AncileError);
    try {
      readZip(zip([{ name: 'a.md', data: 'x', claim: 65 * 1024 * 1024 }]));
      expect.unreachable();
    } catch (err) {
      expect((err as AncileError).code).toBe('memory.import_too_large');
    }
    // A truncated archive is unreadable, not a crash.
    const cut = zip([{ name: 'a.md', data: 'x'.repeat(100) }]).subarray(0, 60);
    expect(() => readZip(cut)).toThrow(/not a zip/);
  });

  it('writes and reads the Markdown export, markers and all', () => {
    const text = writeMarkdownExport(
      [
        { path: 'USER.md', content: '# About me\n\n- One.\n' },
        { path: 'AGENTS.md', content: '- Two.' },
      ],
      { head: 'abc', date: '2026-10-12', note: 'A note.' },
    );
    expect(isMarkdownExport(text)).toBe(true);
    expect(readMarkdownExport(text)).toEqual([
      { path: 'USER.md', content: '# About me\n\n- One.\n' },
      { path: 'AGENTS.md', content: '- Two.\n' },
    ]);
    expect(() => readMarkdownExport('# just notes')).toThrow(/memory export/);
  });
});

describe('importers', () => {
  it('cuts long entries and compares text loosely', () => {
    const long = entryText('word '.repeat(200));
    expect(long.clipped).toBe(true);
    expect(long.text.length).toBe(600);
    expect(entryText('a <!-- hidden --> b').text).toBe('a b');
    expect(sameText('Uses **British** spelling.')).toBe(sameText('uses british   spelling'));
    expect(defaultSection('MODELS/x.md')).toBe('Quirks');
    expect(defaultSection('notes.md')).toBe('Imported');
  });

  it('Markdown notes: front matter, tables, rules, Superseded and continuation lines', () => {
    const r = fromNotes(
      [
        '---',
        'title: x',
        '---',
        '## Food',
        '- Vegetarian,',
        '  except fish.',
        '- [x] Likes curry.',
        '',
        '| a | b |',
        '---',
        'A paragraph',
        'over two lines.',
        '## Superseded',
        '- ~~Old.~~',
      ].join('\n'),
      { path: 'USER.md', label: 'Markdown notes' },
    );
    expect(r.candidates.map((c) => [c.section, c.text])).toEqual([
      ['Food', 'Vegetarian, except fish.'],
      ['Food', 'Likes curry.'],
      ['Food', 'A paragraph over two lines.'],
    ]);
    expect(r.skipped).toBeGreaterThanOrEqual(5);
  });

  it('ChatGPT: JSON lists in the shapes people have, and JSON that is not one', () => {
    expect(fromChatGpt('["One.", "Two."]', { path: 'USER.md' }).candidates.map((c) => c.text)).toEqual([
      'One.',
      'Two.',
    ]);
    expect(
      fromChatGpt('{"memories":[{"content":"A."},{"text":"B."},{"memory":"C."},{"other":1}]}', {
        path: 'USER.md',
      }).candidates.map((c) => c.text),
    ).toEqual(['A.', 'B.', 'C.']);
    const odd = fromChatGpt('{"name": "not memories"}', { path: 'USER.md' });
    expect(odd.notes[0]).toMatch(/read line by line/);
    const numbered = fromChatGpt('1. First.\n2) Second.\n“Third.”', { path: 'AGENTS.md' });
    expect(numbered.candidates.map((c) => [c.section, c.text])).toEqual([
      ['House rules', 'First.'],
      ['House rules', 'Second.'],
      ['House rules', 'Third.'],
    ]);
  });
});

eachBackend('memory imports store', (backend) => {
  const make = () => {
    const b = backend();
    return b.sql ? new PgProposalStore(b.sql) : new MemoryProposalStore();
  };

  it('keeps an import, its proposals in order, and leaves them out of the inbox', async () => {
    const store = make();
    const imp = await store.createImport({ origin: 'chatgpt', label: 'ChatGPT memory', filename: uid('f') });
    expect(await store.getImport(imp.id)).toEqual(imp);
    expect((await store.listImports(500)).some((r) => r.id === imp.id)).toBe(true);
    const base = {
      kind: 'imported' as const,
      target_path: 'USER.md',
      op: 'add' as const,
      section: 'Preferences',
      target_key: null,
      target_text: null,
      rationale: 'test',
      confidence: 0.5,
      provenance: 'import' as const,
      evidence: [],
      status: 'proposed' as const,
      import_id: imp.id,
    };
    const a = await store.create({ ...base, text: uid('first') });
    const b = await store.create({ ...base, text: uid('second') });
    expect((await store.byImport(imp.id)).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(a.import_id).toBe(imp.id);
    const inbox = await store.list({ limit: 500 });
    expect(inbox.some((p) => p.id === a.id)).toBe(false);
    await store.update(a.id, { status: 'applied', commit_sha: 'f'.repeat(40), decided: true });
    expect((await store.withCommit('f'.repeat(40))).map((p) => p.id)).toContain(a.id);
    expect(await store.getImport('mim_none')).toBeUndefined();
  });
});
