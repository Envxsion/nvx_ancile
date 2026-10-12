import { describe, expect, it } from 'vitest';
import { ArtifactFrameMessage, findArtifacts, splitArtifacts } from '../src/artifacts';

describe('findArtifacts', () => {
  it('finds a fenced artifact with its attributes', () => {
    const text =
      'Here it is:\n\n```html artifact id="pricing" title="Pricing table"\n<p>Hi</p>\n```\n\nDone.';
    const [a] = findArtifacts(text);
    expect(a).toMatchObject({
      key: 'pricing',
      type: 'html',
      title: 'Pricing table',
      content: '<p>Hi</p>',
      complete: true,
    });
    expect(text.slice(a?.start, a?.end)).toBe(
      '```html artifact id="pricing" title="Pricing table"\n<p>Hi</p>\n```',
    );
  });

  it('leaves plain fences alone, even when they mention artifact inside', () => {
    const text = '```python\nprint("```html artifact")\n```\n\n```js\nlet a = 1\n```';
    expect(findArtifacts(text)).toEqual([]);
  });

  it('maps languages and Claude-style tags to types', () => {
    const text = [
      '```tsx artifact title="Counter"',
      'export default () => <b>1</b>',
      '```',
      '<antArtifact identifier="flow" type="application/vnd.ant.mermaid" title="Flow">',
      'graph TD; A-->B',
      '</antArtifact>',
      '```python artifact',
      'print(1)',
      '```',
    ].join('\n');
    const found = findArtifacts(text);
    expect(found.map((a) => [a.key, a.type, a.language])).toEqual([
      ['counter', 'react', 'tsx'],
      ['flow', 'mermaid', 'mermaid'],
      ['code', 'code', 'python'],
    ]);
  });

  it('marks an artifact still being written as incomplete', () => {
    const [a] = findArtifacts('```svg artifact title="Logo"\n<svg><circle r="4"/>');
    expect(a?.complete).toBe(false);
    expect(a?.content).toBe('<svg><circle r="4"/>');
    const [b] = findArtifacts('<antArtifact identifier="x" type="text/html">\n<p>');
    expect(b?.complete).toBe(false);
  });

  it('keeps keys unique within one answer', () => {
    const text = '```html artifact\n<a>\n```\n```html artifact\n<b>\n```';
    expect(findArtifacts(text).map((a) => a.key)).toEqual(['html', 'html-2']);
  });

  it('accepts a longer closing fence and tildes', () => {
    const [a] = findArtifacts('~~~~markdown artifact title="Notes"\n# Hi\n```\ncode\n```\n~~~~~\nafter');
    expect(a?.content).toBe('# Hi\n```\ncode\n```');
    expect(a?.type).toBe('markdown');
  });
});

describe('artifacts written slightly off the form', () => {
  it('takes the attributes from the line after the opening fence', () => {
    const text = 'See:\n\n```html\nartifact id="pricing" title="Pricing table"\n<p>Hi</p>\n```\nDone.';
    const [a] = findArtifacts(text);
    expect(a).toMatchObject({ key: 'pricing', type: 'html', title: 'Pricing table', content: '<p>Hi</p>' });
    expect(text.slice(a?.start, a?.end)).toBe(
      '```html\nartifact id="pricing" title="Pricing table"\n<p>Hi</p>\n```',
    );
  });

  it('takes a bare html block that is a whole document, titled from it', () => {
    const doc = '<!DOCTYPE html>\n<html><head><title>Timer</title></head><body>0:00</body></html>';
    const [a] = findArtifacts(`Here:\n\n\`\`\`html\n${doc}\n\`\`\`\n`);
    expect(a).toMatchObject({ key: 'timer', type: 'html', title: 'Timer', content: doc, complete: true });
  });

  it('leaves alone a fragment, an unfinished document, a word "artifact" in prose and other languages', () => {
    expect(findArtifacts('```html\n<div>Just a snippet</div>\n```')).toEqual([]);
    expect(findArtifacts('```html\n<!doctype html>\n<html><body>')).toEqual([]);
    expect(findArtifacts('```js\nartifact\nconsole.log(1)\n```')).toEqual([]);
    expect(findArtifacts('```python\n<!doctype html><html></html>\n```')).toEqual([]);
    // A whole document inside another fence is not taken out of it.
    expect(findArtifacts('````md\n```html\n<!doctype html><html></html>\n```\n````')).toEqual([]);
  });
});

describe('splitArtifacts', () => {
  it('keeps the surrounding text exactly', () => {
    const text = 'Before\n```html artifact\n<p>x</p>\n```\nAfter';
    const pieces = splitArtifacts(text);
    expect(pieces.map((p) => p.kind)).toEqual(['text', 'artifact', 'text']);
    expect(pieces[0]).toEqual({ kind: 'text', text: 'Before\n' });
    expect(pieces[2]).toEqual({ kind: 'text', text: '\nAfter' });
  });
});

describe('ArtifactFrameMessage', () => {
  const base = { channel: 'nvx-ancile-artifact', nonce: 'abcdefgh12' };
  it('accepts the four kinds', () => {
    expect(ArtifactFrameMessage.safeParse({ ...base, kind: 'size', height: 300 }).success).toBe(true);
    expect(ArtifactFrameMessage.safeParse({ ...base, kind: 'copy', text: 'x' }).success).toBe(true);
    expect(
      ArtifactFrameMessage.safeParse({
        ...base,
        kind: 'download',
        name: 'a.csv',
        mime: 'text/csv',
        data: 'a,b',
      }).success,
    ).toBe(true);
  });
  it('rejects anything else', () => {
    expect(ArtifactFrameMessage.safeParse({ ...base, kind: 'navigate', url: 'https://x' }).success).toBe(
      false,
    );
    expect(
      ArtifactFrameMessage.safeParse({
        ...base,
        kind: 'download',
        name: '../../evil.exe',
        mime: 'text/plain',
        data: '',
      }).success,
    ).toBe(false);
    expect(
      ArtifactFrameMessage.safeParse({
        ...base,
        kind: 'download',
        name: 'a.exe',
        mime: 'application/x-msdownload',
        data: '',
      }).success,
    ).toBe(false);
    expect(
      ArtifactFrameMessage.safeParse({ ...base, channel: 'other', kind: 'size', height: 1 }).success,
    ).toBe(false);
  });
});
