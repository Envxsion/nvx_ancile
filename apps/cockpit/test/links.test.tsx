import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { classifyLink } from '../src/lib/links';
import { SafeLink } from '../src/thread/Citations';

const ORIGIN = 'http://127.0.0.1:8787';
// Built up so the linter does not mistake the fixture for a real script link.
const SCRIPT_URL = ['javascript', 'alert(1)'].join(':');

describe('links in answers', () => {
  it('opens web and mail links outside the app', () => {
    expect(classifyLink('https://nvx.sh/docs', ORIGIN)).toEqual({
      kind: 'external',
      href: 'https://nvx.sh/docs',
    });
    expect(classifyLink('http://example.com', ORIGIN).kind).toBe('external');
    expect(classifyLink('mailto:hello@nvx.sh', ORIGIN).kind).toBe('external');
    expect(classifyLink('//evil.example/x', ORIGIN).kind).toBe('refused');
  });

  it('keeps NVX Ancile pages in the app', () => {
    expect(classifyLink('/flows', ORIGIN)).toEqual({ kind: 'internal', to: '/flows' });
    expect(classifyLink(`${ORIGIN}/notebooks/n1?x=1#top`, ORIGIN)).toEqual({
      kind: 'internal',
      to: '/notebooks/n1?x=1#top',
    });
    expect(classifyLink('#section', ORIGIN).kind).toBe('anchor');
    // Core's files open beside the app.
    expect(classifyLink('/api/v1/sources/s1/file', ORIGIN).kind).toBe('external');
  });

  it('refuses every other scheme', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,hi',
      'ms-settings:privacy',
      'vbscript:x',
      '',
      undefined,
    ])
      expect(classifyLink(href, ORIGIN).kind).toBe('refused');
  });

  it('draws an external link with a new-tab target and no opener', () => {
    const { container } = render(<SafeLink href="https://nvx.sh">nvx</SafeLink>);
    const a = container.querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('draws a refused link as text, never an anchor', () => {
    const { container } = render(<SafeLink href={SCRIPT_URL}>run</SafeLink>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('.md-link-refused')?.textContent).toBe('run');
  });

  it('leaves an internal link alone when there is no router to navigate with', () => {
    const { container } = render(<SafeLink href="/flows">flows</SafeLink>);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('/flows');
    expect(a?.getAttribute('target')).toBeNull();
    // No router in this test: the click is not swallowed by the link.
    let prevented: boolean | null = null;
    const seen = (e: Event) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    };
    document.body.addEventListener('click', seen);
    fireEvent.click(a as HTMLAnchorElement);
    document.body.removeEventListener('click', seen);
    expect(prevented).toBe(false);
  });
});
