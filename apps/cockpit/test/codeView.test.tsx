/**
 * The real CodeMirror surface, mounted in jsdom: the text is there with
 * its label, read-only means not editable, and the Edit switch makes it
 * editable without rebuilding the view. Layout-dependent behaviour (the
 * diff's alignment) is left to the e2e screenshots.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeDiff, CodeView } from '../src/code/CodeView';

// jsdom has no layout: CodeMirror measures ranges, so give them empty boxes.
const empty = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= empty;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

describe('CodeView', () => {
  it('shows the text read-only, then editable', async () => {
    const { rerender } = render(
      <CodeView value={'def f():\n    return 1\n'} language="a.py" label="Contents of a.py" />,
    );
    const content = await screen.findByLabelText('Contents of a.py');
    expect(content.textContent).toContain('def f():');
    expect(content).toHaveAttribute('contenteditable', 'false');
    rerender(
      <CodeView
        value={'def f():\n    return 1\n'}
        language="a.py"
        label="Contents of a.py"
        readOnly={false}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Contents of a.py')).toHaveAttribute('contenteditable', 'true'),
    );
    rerender(<CodeView value="x = 2" language="a.py" label="Contents of a.py" readOnly={false} />);
    await waitFor(() => expect(screen.getByLabelText('Contents of a.py').textContent).toContain('x = 2'));
  });

  it('draws a diff, one column or two', async () => {
    const { container, rerender } = render(
      <CodeDiff before="a\nb\n" after="a\nc\n" language="x.txt" label="Changes" />,
    );
    await waitFor(() => expect(container.querySelector('.cm-mergeView')).not.toBeNull());
    rerender(<CodeDiff before="a\nb\n" after="a\nc\n" language="x.txt" label="Changes" unified />);
    await waitFor(() => expect(container.querySelector('.cm-mergeView')).toBeNull());
    await waitFor(() =>
      expect(screen.getByLabelText('Changes: after, with removed lines shown')).toBeInTheDocument(),
    );
  });
});
