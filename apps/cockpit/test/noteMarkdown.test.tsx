import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NoteMarkdown } from '../src/flows/noteMarkdown';

describe('sticky-note markdown', () => {
  it('renders bold, italics, code, lists and safe links, never raw HTML', () => {
    const { container } = render(
      <NoteMarkdown
        text={
          '**Example:** Jev routes _here_.\n\n- uses `plan`\n- [docs](https://nvx.sh)\n\n<script>x</script> [bad](javascript:alert(1))'
        }
      />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Example:');
    expect(container.querySelector('em')?.textContent).toBe('here');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('code')?.textContent).toBe('plan');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>x</script>');
    expect(container.textContent).toContain('bad');
  });
});
